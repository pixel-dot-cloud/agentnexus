# P4b — Credential proxy + `full` container mode

## Goal

Run the **entire agent loop** inside a Docker container (`agent.container.mode: 'full'`). Container never sees provider API keys; host owns them and forwards signed HTTP requests on the container's behalf.

P4a shipped `tools-only` (only `shell_execute` enters the sandbox; agent loop + keys stay on host). P4b is the harder mode — needs custom runner image + cred-proxy + stdio JSON-RPC bridge.

## Hard constraints

- **Zero API keys cross the host→container boundary.** Container env is stripped of all `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / etc.
- **Provider-neutral.** No Anthropic-specific code paths. Each provider gets a generic forward route.
- **Container `network` defaults to `none`** in tools-only; **`full` mode must default to a custom network** (e.g. user-defined `agentnexus-internal`) that allows reaching ONLY the host's cred-proxy IP and port. No general internet from inside.
- **No Claude/Claude Code naming.** Container runner = `runner` or `agent-runner`. Never `claude-runner`.
- **Toggleable** at config-level: master switch `container.credProxy.enabled` (default true when any agent uses `full` mode).
- **HTTP framework:** **hono** (Web Standards Request/Response, built-in SSE streaming, ~14KB, active maintenance). Confirmed in P4a plan. Do not switch.
- **Per-agent token:** container is handed an opaque random token at spawn time; cred-proxy validates token→agent mapping before signing requests. Prevents one container impersonating another.
- **Allowlist of upstream URLs.** Cred-proxy refuses to forward to any host that isn't in the user's `providers[].endpoint` list. Stops SSRF and data exfiltration.

## Components

### 1. Custom runner image — `container/Dockerfile`

```Dockerfile
FROM node:20-slim
WORKDIR /app
COPY dist/ ./dist/
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
ENTRYPOINT ["node", "dist/runner.js"]
```

Build script `container/build.sh` builds image tag `agentnexus-runner:<git-sha>`. Cache + push optional.

### 2. Stdio JSON-RPC bridge — `src/core/runner-bridge.ts`

Host ↔ container framing mirrors `src/lib/mcp.ts:107-152`:
- One JSON message per line (newline-delimited).
- Methods: `runTurn`, `streamText`, `toolCall`, `toolResult`, `consentRequest`, `consentDecision`, `abort`, `done`.
- IDs correlate request/response. 30s default timeout on RPC.
- Lifecycle: spawn container detached with stdio piped through `docker run -i`, send `runTurn{...}`, receive stream of events, send `done` from inside when complete.

### 3. Agent runner entrypoint — `src/runner.ts` *(new top-level)*

Container-side process. Reads `runTurn` request from stdin, builds an LLM provider whose base URL points to the cred-proxy host (`http://host.docker.internal:<port>/proxy/<provider-name>`), runs the existing `runAgentLoop` with tools that emit `toolCall` RPC events back to the host instead of executing directly. Host owns tool execution.

This inverts P4a: in P4a, the loop is on host, tools dispatch to container. In P4b, the loop is in the container, tools dispatch to host. Both arrangements share `runAgentLoop` unchanged — only the tool executor differs.

### 4. Credential proxy — `src/core/cred-proxy.ts`

**hono**-based HTTP server. Routes:

```
POST /proxy/<providerName>/v1/messages          → Anthropic
POST /proxy/<providerName>/v1/chat/completions  → OpenAI-compat / LM Studio
POST /proxy/<providerName>/api/chat             → Ollama
POST /proxy/<providerName>/v1beta/.../generateContent → Google (if SDK swap done)
GET  /healthz
```

Per-request flow:
1. Validate `X-Agent-Token` header against active mapping.
2. Look up `providerName` in `config.providers[]`; reject if not present.
3. Verify URL host (when computed) matches the provider's configured endpoint — allowlist guard.
4. Rewrite headers: inject the real API key (`x-api-key` / `Authorization: Bearer` / `anthropic-version`); strip any inbound auth.
5. Pipe body through (streaming-safe). For SSE, hono's `c.stream()` keeps backpressure correct.
6. Pipe response back unchanged (status, headers, body).

Run on `127.0.0.1:<port>` only. Container reaches it via `--add-host=host.docker.internal:host-gateway` (Linux Docker 20.10+).

### 5. Google SDK outlier

`@google/genai` SDK does **not** honor arbitrary base URLs. Two paths:
- **(a) Preferred:** swap Google provider implementation to raw `fetch` against the OAI-compat Gemini endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/...`). Drops SDK dep for that provider.
- **(b) Fallback:** if (a) hits feature gaps (streaming behavior, tool-use format), keep SDK but mark Google provider as **incompatible with `full` mode**. Runtime error if user wires a Google-backed agent to `full` mode.

Spike (a) first. Track in P4b kickoff.

## Files

New:
- `container/Dockerfile`
- `container/build.sh`
- `src/runner.ts`
- `src/core/runner-bridge.ts`
- `src/core/cred-proxy.ts`

Modified:
- `src/core/container.ts` — add `spawnRunner(agent, defaults, runnerImage, proxyAddr, agentToken)` alongside `spawnSandbox`. New variant uses `docker run -i` (interactive stdio) instead of `-d`, custom network, `--add-host`, env injection of proxy address + token.
- `src/core/run-turn.ts` — when `mode === 'full'`, replace the local `runAgentLoop` call with `runnerBridge.runTurn(...)`. Tool execution callbacks dispatch to the host's `defaultToolRegistry`.
- `src/config.ts` — add `container.credProxy: { enabled, port, allowedHosts? }` defaults.
- `src/providers.ts` — Google provider: see Google SDK outlier (above).
- `package.json` — add `hono` (`^4`).
- `src/lib/menu-tree.ts` — cred-proxy pane (port, enable toggle).

## Verification

1. `npm run typecheck` + `npm run build` clean.
2. `bash container/build.sh` produces tag `agentnexus-runner:<sha>`.
3. **Key isolation**: from inside a `full`-mode container, `env | grep -i key` returns nothing relevant; `cat /proc/1/environ | strings | grep -i key` likewise empty.
4. **Allowlist guard**: with a wired Anthropic provider whose endpoint is `https://api.anthropic.com`, posting to `/proxy/<name>/something-else` returns 403 from the proxy.
5. **Round-trip**: wire an agent to `mode: 'full'`, send a Telegram message → response streams back, tool calls execute on host, container exits cleanly.
6. **SSE streaming**: enable an Anthropic streaming model, watch host log — first token latency ≤ 500ms over loopback (no buffering regression).
7. **Token-scope leak test**: spawn two `full`-mode agents concurrently with different tokens; manual `curl` from inside container A using container B's token → 401.

## Risk notes

- **Network policy is the load-bearing primitive.** If the user's Docker daemon doesn't support `host-gateway`, `host.docker.internal` won't resolve. Detect at probe time; fall back to host LAN IP with a warning.
- **SSE streaming** is the long-tail risk. hono handles it natively; raw `http.createServer` would not. (This is why P4a's plan picked hono.)
- **Image rebuild cadence**: `dist/` changes each release. Image tag includes git sha. `runTurn` should refuse to spawn if image absent — `docker run` returns non-zero, caller surfaces a clear "run `bash container/build.sh` first" message.
- **Aborts**: when host's `AbortController` fires mid-turn, send `abort` RPC to container; container kills the in-flight provider fetch via its own AbortController; container exits. Verify no zombie containers.

## Out of scope for P4b

- Sweep loop / stuck-container detection — that is **P4c** (`p4c.md`). It depends on this work landing.
- Multi-host orchestration. Single host only.
- Image registry / pull-from-remote. Local-build-only.
