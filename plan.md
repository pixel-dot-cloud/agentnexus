# Plan — agentnexus session handoff (2026-05-23)

Continuation doc. Previous session shipped Features 1–5 + bold/chunk/DS-toolcall fixes. Build clean (`npm run build` exits 0).

## Done this session

### F1 — Agent name prefix
- `src/core/agents.ts` — `agentDisplayName(agent)` helper added.
- `src/core/run-turn.ts` — `makeOnText` closure emits prefix once per turn.
- Telegram: `<b>Name</b>` + body combined in ONE message via `parse_mode: HTML`. Body HTML-escaped. Falls back to 2-message split if combined > 4096.
- CLI: `Name:\n<body>` plain.

### F2 — Async subagents
- New: `src/lib/subagent-registry.ts` — `SubagentSession`, `subagentRegistry`, `MAX_RUNNING_SUBAGENTS = 8`, prune/TTL.
- New tools: `MessageLeaderTool` (per-spawn), `CheckAgentTool`, `ListAgentsTool`, `AbortAgentTool`.
- `src/lib/sub-agent.ts` — `MAX_SUB_ITER` 10→25, `onHistoryUpdate?` callback emitted after each push.
- `src/tools.ts` — `ToolRegistry.clone()` helper.
- `src/tools/AgentSpawnTool.ts` — fire-and-forget IIFE, concurrency cap, cloned registry with per-session `message_leader` injection. Snapshots fork parent history.
- `src/core/daemon-setup.ts` — registers `check_agent`, `list_agents`, `abort_agent`.
- `src/core/run-turn.ts` — `<subagent-pending>` block injected into `buildSystemPrompt` when unread inbox exists.
- `src/prompts/main-agent.md` — docs for tools.

### F3 — Telegram bold
- `src/channels/types.ts` — `OutboundMessage.parseMode?: 'HTML'|'Markdown'|'MarkdownV2'`.
- `src/channels/telegram.ts` — `deliver()` passes `{ parse_mode }` when set.

### F4 — `message_user` tool
- New: `src/core/turn-context.ts` — push/pop/current stack.
- New: `src/tools/MessageUserTool.ts` — per-spawn injected, captures `TurnContext` snapshot. Helper `deliverWithHeader()` shared with run-turn for combined header+body single-message delivery.
- `src/core/run-turn.ts` — `pushTurnContext`/`popTurnContext` around both code paths (try/finally).
- `src/tools/AgentSpawnTool.ts` — injects `MessageUserTool` with `agentId` 3rd arg.

### F5 — Bot pool + assignment
- `src/config.ts` — `BotInstance.pool?: boolean`; `updateBot` patch lane.
- `src/lib/subagent-registry.ts` — `userInbox: string[]`, `boundBotName?: string`.
- New: `src/lib/bot-pool.ts` — runtime assignment map + `lastUserChat` per bot. `botPool` singleton.
- New tools: `ListBotsTool`, `AssignBotTool`, `ReleaseBotTool` (global), `ReadUserMessagesTool` (per-spawn).
- `src/channels/telegram.ts` — pool bot inbound branch: routes to bound subagent's `userInbox` if assigned, drops if unbound; updates `touchUserChat` per message.
- `src/tools/AgentSpawnTool.ts` — injects `ReadUserMessagesTool` per spawn; calls `botPool.releaseAgent(id)` in IIFE finally.
- `src/tools/MessageUserTool.ts` — prefers bound bot (via `botPool.getBoundBot(agentId)` + `getUserChat`); falls back to spawn ctx.
- `src/core/daemon-setup.ts` — registers `list_bots`, `assign_bot`, `release_bot`; `botPool.init(() => config.getBots())`.

### Chunking / UX fixes
- `src/telegram/formatter.ts` — smart splitter. Target 1500, max 2800, hard 4096. Priority: paragraph → line → sentence → clause → space. Never mid-word.
- `formatToolResult` — returns `null` on success → no spam to user; surfaces only errors (❌).

### DeepSeek tool-call leak fix
- New: `src/lib/deepseek-toolcalls.ts` — `parseDeepseekToolCalls(rawText)` extracts `<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>` blocks into proper `ToolCall[]`, strips hallucinated `<｜tool▁outputs▁begin｜>` blocks from visible text.
- `src/providers.ts` — wired into `OpenAICompatibleProvider.chat` and `OllamaProvider.chat` post-stream when `toolCalls.length === 0 && buffer.length > 0`.

### System prompt
- `src/prompts/main-agent.md` — emphatic "Remember: always present yourself fully" line; strengthened "First message" section.

### Config / runtime
- `~/.agentnexus/config.json` — `container.enabled: true`, `container.credProxy.enabled: true`.
- `~/.agentnexus/agents/default/agent.json` — created. `mode: tools-only` (downgraded from `full` because full mode has bugs — see below).
- `agentnexus-runner:latest` image built (`bash container/build.sh` succeeded).

---

## Open issues / next steps

### Bug — full container mode broken
Three interacting path-mismatch bugs prevent full mode from working with LM Studio (and any provider with `/v1`-style endpoint):

1. **`isBareBase` regex** in `OpenAICompatibleProvider.chat` (`src/providers.ts:408`) doesn't recognize `/proxy/<name>` as a bare base → wrong chatEndpoint built when endpoint = `proxyBaseUrl`.
2. **`listModels`** uses `new URL(endpoint).origin` (drops path) → strips the `/proxy/<name>` prefix → cred-proxy returns 404 → resolveModel fails with "No model loaded". Same bug in `LmStudioApi` (`src/lib/lmstudio-api.ts:112`).
3. **`/v1` doubling** — cred-proxy appends request path verbatim onto `provider.endpoint`. If provider endpoint = `http://localhost:1234/v1` AND request path = `/v1/chat/completions`, final URL = `http://localhost:1234/v1/v1/chat/completions`.

Suggested fix path:
- Extend `isBareBase` regex to `/^\/?$|^\/v1\/?$|^\/proxy\/[^/]+\/?$/`.
- In `listModels` (both OpenAI compat + LmStudioApi), preserve the `/proxy/<name>` prefix if present instead of `.origin`.
- In `cred-proxy.ts:117` provBase normalization, strip trailing `/v1` from provider endpoint so the doubling can't happen — OR detect overlap when concatenating.

Current workaround: `mode: tools-only` in default agent. Fs/shell sandboxed, agent loop stays host-side → LM Studio reachable.

### Network: container "localhost" → host
User originally asked for any `localhost`/`127.0.0.1` endpoint inside container to route to host. Not feasible cleanly without `--network=host` (kills isolation). Current `host.docker.internal` add-host is set via `resolveHostGatewaySpec`. Code rewrite path (intercept provider config inside runner and rewrite `localhost` → `host.docker.internal`) is doable as part of the full-mode fix.

### Not yet wired
- Pool bot persistence across daemon restarts (in-memory only).
- Subagent-to-subagent messaging (only leader ↔ child currently).
- Group chats on pool bots.

---

## Files touched this session

### New
- `src/lib/subagent-registry.ts`
- `src/lib/bot-pool.ts`
- `src/lib/deepseek-toolcalls.ts`
- `src/core/turn-context.ts`
- `src/tools/MessageLeaderTool.ts`
- `src/tools/CheckAgentTool.ts`
- `src/tools/ListAgentsTool.ts`
- `src/tools/AbortAgentTool.ts`
- `src/tools/MessageUserTool.ts`
- `src/tools/ListBotsTool.ts`
- `src/tools/AssignBotTool.ts`
- `src/tools/ReleaseBotTool.ts`
- `src/tools/ReadUserMessagesTool.ts`

### Modified
- `src/core/agents.ts`
- `src/core/run-turn.ts`
- `src/core/daemon-setup.ts`
- `src/channels/types.ts`
- `src/channels/telegram.ts`
- `src/telegram/formatter.ts`
- `src/lib/sub-agent.ts`
- `src/tools.ts`
- `src/tools/AgentSpawnTool.ts`
- `src/providers.ts`
- `src/prompts/main-agent.md`
- `src/config.ts`

### Config (not in repo)
- `~/.agentnexus/config.json`
- `~/.agentnexus/agents/default/agent.json` (new)

---

## Verification status
- Build: `npm run build` clean.
- Manual runtime: pending daemon restart by user.
- Telegram bold: code verified, dist updated, needs restart.
- DeepSeek parser: untested in live run.
- Tools-only container mode: untested in live run.
- Full container mode: known broken (3 bugs above).
