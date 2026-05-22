# P4b — Done

## Original intent

P4a shipped `tools-only` mode: the agent loop runs on the host, only `shell_execute` is redirected into an ephemeral Docker sandbox. Keys stay on the host. Safe, simple.

P4b is the harder mode. Goal: run **the entire agent loop** inside a Docker container so that even a compromised model output or a rogue tool call cannot read the host's environment, API keys, or file system beyond an explicit mount allowlist.

The fundamental constraint: **zero API keys cross the host→container boundary.** The container needs to call LLM APIs, but it must never see the credentials. The solution is a host-side HTTP proxy (`cred-proxy`) that the container points its providers at. The container sends requests to `http://host.docker.internal:<port>/proxy/<providerName>/...`; the proxy validates a per-spawn opaque token, injects the real API key, and pipes the response back — including SSE streaming.

---

## What shipped

### `container/Dockerfile`

Custom runner image. Copies compiled `dist/` into `node:20-slim`, runs `npm ci --omit=dev`, sets `ENTRYPOINT node dist/runner.js`. Tagged as `agentnexus-runner:<git-sha>` and `agentnexus-runner:latest` by the build script.

### `container/build.sh`

Runs `npm run build` then `docker build`. Tags both `<sha>` and `latest`. Must be re-run whenever `dist/` changes. Runner fails with a clear error if the image is missing at turn-time (`checkRunnerImageExists`).

### `src/core/cred-proxy.ts`

hono-based HTTP proxy on `127.0.0.1:40571` (configurable). Per-request flow:

1. Extract token from `X-Agent-Token`, `x-api-key`, or `Authorization: Bearer` (providers differ in how they transmit the key).
2. Reject if token not in the in-memory registry.
3. Look up `providerName` in live config.
4. Build upstream URL = `provider.endpoint + path_suffix`. Verify it starts with the provider's configured endpoint — SSRF / exfiltration guard.
5. Strip inbound auth headers, inject real credentials (Anthropic: `x-api-key`; all others: `Authorization: Bearer`).
6. Buffer request body (LLM payloads are small JSON). Stream response body through via `ReadableStream` passthrough — SSE-safe, no buffering regression.

Singleton: `ensureCredProxyStarted()` is idempotent. Token lifecycle: `registerAgentToken` at spawn, `revokeAgentToken` in `finally`.

### `src/core/runner-bridge.ts`

Host-side stdio JSON-RPC bridge. Spawns the runner container via `spawnRunnerProc` (`docker run -i --rm`), then exchanges newline-delimited JSON on stdin/stdout.

Protocol:

| Direction | Message | Purpose |
|-----------|---------|---------|
| H→C | `runTurn { payload }` | Initial turn request |
| H→C | `toolResult { callId, output, isError }` | Result of host-executed tool |
| H→C | `abort` | Cancel in-flight turn |
| C→H | `stream { chunk }` | Streaming text delta |
| C→H | `text { content }` | Completed assistant text block |
| C→H | `toolCall { callId, name, args }` | Request host to execute tool |
| C→H | `done { history, usage }` | Turn complete |
| C→H | `error { message }` | Unrecoverable container error |

Tool calls from the container go through the host's `ConsentManager` and `onConsentRequest` callback before execution — same consent model as normal turns. Plan-mode hard-blocks apply. `file_write` diffs are computed on the host.

Abort: sends `abort` message, waits 3 s, then `SIGKILL`. `finally` always kills the process.

Returns `AgentLoopResult` — same shape as `runAgentLoop`, so callers are identical.

### `src/runner.ts`

Container-side entrypoint (`dist/runner.js`). Reads the initial `runTurn` message, builds an `LLMProvider` pointed at the cred-proxy, runs `runAgentLoop` with a custom tool executor that sends `toolCall` to the host and `await`s the `toolResult` via a `pendingToolResults` map resolved by the `readline` event handler.

`bypassPermissions` consent mode — the host bridge owns consent. `invoke_skill` excluded from the tools list sent to the container (skill expansion not supported in full mode; tools list is filtered by `run-turn.ts`).

Provider endpoint construction per type:
- Anthropic → `proxyBase/v1/messages`
- Ollama → `proxyBase/v1/chat/completions` (OAI-compat path avoids URL origin-stripping)
- Google AI → `proxyBase/v1beta/openai/chat/completions`
- All others → `proxyBase/v1/chat/completions`

### `src/core/container.ts` additions

- `defaultMounts()` — exported (was private; needed by `run-turn.ts` for full-mode mount resolution)
- `ensureNetworkExists(name, dockerPath)` — creates `agentnexus-internal` if absent; race-safe double-check
- `resolveHostGatewaySpec(dockerPath)` — returns `--add-host` argument. Uses `host-gateway` (Docker ≥ 20.10); falls back to reading bridge gateway IP from `docker network inspect`; last resort `172.17.0.1` with warning
- `checkRunnerImageExists(image, dockerPath)` — pre-flight check; hard error with "run `bash container/build.sh`" message
- `spawnRunnerProc(dockerPath, opts)` — builds and spawns `docker run -i` (interactive stdio) argv-form; no shell, no injection surface; returns `ChildProcess`

### `src/config.ts`

New `CredProxyConfig` interface: `{ enabled, port, networkName, runnerImage }`.

`ContainerDefaults` gains `credProxy?: CredProxyConfig`.

Defaults: `port=40571`, `networkName='agentnexus-internal'`, `runnerImage='agentnexus-runner:latest'`, `enabled=true`.

`getContainerDefaults()` return type updated to include `credProxy: Required<CredProxyConfig>`. New `getCredProxyConfig()` / `setCredProxyConfig()` methods.

### `src/providers.ts`

**`GoogleAIProvider` renamed to `GoogleAISDKProvider`** — kept in file for reference, not wired into `ProviderFactory`.

**`GoogleAIRawFetchProvider` (new)** — extends `OpenAICompatibleProvider`. Uses the Gemini OAI-compat endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`) instead of the `@google/genai` SDK. The SDK ignores `config.endpoint`, making it incompatible with the cred-proxy's URL rewriting. Raw fetch is equivalent and works through the proxy. `resolveModel` throws on `AUTO_MODEL` (Google AI requires explicit model IDs). `listModels` returns `[]`.

`ProviderFactory` now returns `GoogleAIRawFetchProvider` for `google` / `google-ai` types.

### `src/core/run-turn.ts`

Replaced the P4b placeholder rejection with the real full-mode path:

1. `ensureDockerAvailable` (shared with tools-only)
2. `checkRunnerImageExists` — fail-fast with actionable message
3. `ensureCredProxyStarted` — lazy singleton, first full-mode turn pays the startup cost
4. `ensureNetworkExists` — creates `agentnexus-internal` if absent
5. `resolveHostGatewaySpec` — probe Docker version once per turn
6. `crypto.randomBytes(32)` → opaque `agentToken`, registered in proxy
7. Build `RunTurnPayload` (includes serialized tool specs, system prompt, history)
8. Call `runTurnViaRunner(...)` — same callback surface as `runAgentLoop`
9. `finally`: `revokeAgentToken`, restore skill overlay, clear `isRunning`

Tools-only (P4a) path unchanged, now in `else` branch.

### `src/lib/menu-tree.ts`

`credProxyNode()` sub-pane added to container defaults section: port, Docker network name, runner image tag, enable toggle.

---

## Decisions made

| Decision | Choice | Reason |
|----------|--------|--------|
| Google AI provider | Raw fetch (path a) | SDK ignores base URL; needed for proxy routing |
| Cred-proxy port default | 40571 | Low collision risk with common dev ports |
| Docker network missing | Auto-create on daemon | Zero-friction; idempotent |
| Runner image missing | Hard error + message | No silent 30s auto-build; user stays in control |
| Token transmission | Accept from x-api-key / Authorization / X-Agent-Token | Providers differ; cred-proxy normalises |
| `invoke_skill` in full mode | Excluded from container tool list | Skill expansion hardcoded to `defaultToolRegistry` in agent-loop; not available in container |
| Consent in full mode | Host bridge checks consent | Container is untrusted; only host can prompt user |

---

## Verification checklist (from p4b.md)

- [x] `npm run typecheck` clean
- [x] `npm run build` clean — all new files compile, `dist/runner.js` present
- [ ] `bash container/build.sh` — requires Docker; run manually
- [ ] Key isolation: `env | grep -i key` inside container returns nothing relevant
- [ ] Allowlist guard: wrong upstream path → 403 from proxy
- [ ] Round-trip: full-mode agent message → response via Telegram
- [ ] SSE streaming: first token ≤ 500ms over loopback
- [ ] Token-scope: container A token rejected by container B → 401

Items marked `[ ]` require a live Docker environment and running daemon.

---

## What is NOT in P4b

- Sweep loop / stuck-container detection — **P4c** (`p4c.md`). Depends on this work.
- Multi-host orchestration.
- Image registry / pull-from-remote (local build only).
- `invoke_skill` inside full-mode containers.
