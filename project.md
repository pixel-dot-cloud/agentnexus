# AgentNexus — Project Brief

> Pick-up doc for any new Claude session. Read this first.

## What this is

AgentNexus is a multi-channel, multi-agent LLM gateway. You define **agents** (persona + tools + provider) and wire them to **channels** (Telegram, CLI, future: Discord/Slack/WhatsApp). Inbound messages route to the right agent based on `wiring.json`; the agent runs a tool-using loop and replies through the same channel.

Originally a Telegram-only bot derived from `codenexus` (terminal agent). Recently restructured into a channel-adapter framework inspired by `nanoclaw` (a small fork of OpenClaw).

## Hard constraints (user preferences)

- **No "Claude" or "Claude Code" naming anywhere.** User reacts negatively to it. Use generic terms: `agent`, `system.md`, `soul.md`. Never `CLAUDE.md`.
- **Provider-neutral.** Anthropic, Google, Ollama, LM Studio, custom OpenAI-compatible — all first-class. Never special-case Anthropic.
- **Containerization is opt-in.** Default = in-process. Docker isolation is a future opt-in flag per agent, never required.
- **Caveman mode is active.** Terse responses, no filler. Code/commits stay normal.
- **Toggleable-by-default.** Surface knobs in config; avoid hard-coded constants.
- **Protected files (do not edit):** `.env`, `.env.*`, all lockfiles (`package-lock.json`, etc.).

## Architecture

```
[ Telegram | CLI | (future: Discord/WhatsApp) ]   <-- channels
              |        ChannelAdapter
              v
        registry  ->  onInbound(ctx, msg)
              |
              v
        resolveWiring()  ->  AgentDefinition
              |
              v
        runTurn()  <- shared driver
              |
              v
        runAgentLoop() -> LLMProvider + tools + skills
              |
              v
        adapter.deliver(...)
```

### Channel adapter contract (`src/channels/types.ts`)

```ts
interface ChannelAdapter {
  name:            string;                       // e.g. "telegram:default", "cli:local"
  channelType:     string;                       // "telegram" | "cli" | ...
  supportsThreads: boolean;

  setup(cb: ChannelCallbacks): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  deliver(platformId, threadId, msg): Promise<string|undefined>;
  setTyping?(platformId, threadId): Promise<void>;
  askConsent?(platformId, threadId, req, timeoutMs): Promise<ConsentDecision|false>;

  getOrCreateState(platformId, threadId): ChatState;
  formatOutbound?(text): string[];
  formatToolCall?(name, args): string | null;
  formatToolResult?(name, output, isError): string | null;
}
```

Each adapter owns its own per-conversation state map. The orchestrator (`src/index.ts`) is channel-agnostic — it just calls `adapter.getOrCreateState(...)`, looks up the agent, and calls `runTurn`.

### Per-agent persona (file-based, no DB)

Agent definition at `~/.agentnexus/agents/<name>/agent.json`:

```json
{
  "name": "research-bot",
  "displayName": "@Research",
  "providerName": "anthropic-1",
  "modelId": "claude-opus-4-7",
  "engageMode": "mention",
  "engagePattern": null,
  "toolsEnabled": ["shell_execute", "file_read"],
  "permissionMode": "default"
}
```

Plus, in the same dir:
- `system.md` — per-agent system prompt overlay (appended after the base `main-agent` prompt)
- `memory/` — per-agent memory dir (overrides cwd-based memory lookup)
- `skills/` — per-agent skill files (overlaid onto daemon skills for the duration of each turn)

If no agents are defined, a synthetic `default` agent is used — behavior matches pre-port single-agent agentnexus.

### Wiring (`~/.agentnexus/wiring.json`)

```json
[
  { "channelType": "telegram", "platformId": "12345", "agentName": "research-bot", "engageMode": "mention" },
  { "channelType": "telegram", "platformId": "*",     "agentName": "default",     "priority": -1 },
  { "channelType": "cli",      "platformId": "local", "agentName": "research-bot" }
]
```

Wildcard `*` matches all. Higher `priority` wins. If nothing matches, falls back to default agent in `pattern` mode with regex `.` (always engage).

### Engagement modes (`src/core/engage.ts`)

- `pattern` — regex on message text. `.` sentinel = always.
- `mention` — only when adapter reports `isMention: true`.
- `mention-sticky` — mention OR DM (sticky sessions in groups land later with T3).

### Scheduled tasks (`~/.agentnexus/scheduled.json`)

Standard 5-field cron (with `*/n` step, ranges, comma lists, day/month name shortcuts). Sample:

```json
[
  {
    "id": "morning-brief",
    "schedule": "0 9 * * MON-FRI",
    "channelType": "telegram",
    "platformId": "12345",
    "agentName": "research-bot",
    "prompt": "Summarize overnight news from Hacker News and TechCrunch.",
    "enabled": true
  }
]
```

Tick loop runs every 60s (`src/core/scheduler.ts`), fires matching tasks via `runTurn` directly against the target adapter.

### Skills

Three layers loaded at boot (`src/lib/skills.ts`):
1. Bundled (in code).
2. User dir: `~/.agentnexus/skills/`.
3. Project dir: `<cwd>/.agentnexus/skills/`.

Per-turn overlay (`src/core/run-turn.ts`):
4. Agent dir: `<agent.skillsDir>` (defaults to `~/.agentnexus/agents/<name>/skills/`).

Skill format: markdown files with YAML frontmatter (`name`, `description`, `whenToUse`, `argumentHint`, `allowedTools`). Body = the prompt the agent gets when invoking the skill via `SkillTool`.

## File layout

```
src/
├── index.ts                    # entry: setup wizard, daemon, CLI orchestration
├── config.ts                   # ConfigManager — ~/.agentnexus/config.json
├── providers.ts                # LLMProvider abstraction + ProviderFactory
├── tools.ts                    # ShellExecuteTool + tool registry
├── channels/
│   ├── types.ts                # ChannelAdapter interface
│   ├── registry.ts             # register/start/stop adapters
│   ├── telegram.ts             # Telegram adapter (grammy)
│   └── cli.ts                  # CLI adapter (stdin readline)
├── core/
│   ├── agents.ts               # file-based AgentDefinition loader
│   ├── wiring.ts               # channel/platform -> agent rules
│   ├── engage.ts               # engage-mode evaluator
│   ├── run-turn.ts             # adapter-agnostic agent-turn driver
│   ├── daemon-setup.ts         # tools/MCP/skills/hooks shared across channels
│   ├── scheduler.ts            # cron tasks (5-field, 60s tick)
│   └── skill-context.ts        # process-wide active skill set
├── telegram/
│   ├── bot.legacy.ts           # PRE-PORT entry — KEPT FOR REFERENCE, excluded via tsconfig
│   ├── commands.ts             # /start /clear /config /model... handlers
│   ├── consent.ts              # inline-keyboard consent flow
│   ├── config-menu.ts          # interactive /config menu
│   ├── model-picker.ts         # interactive /models picker
│   └── formatter.ts            # Telegram-specific chunking & tool formatting
├── lib/
│   ├── agent-loop.ts           # core tool-using loop (provider-agnostic)
│   ├── consent.ts              # ConsentManager + ConsentRequest types
│   ├── context.ts              # loadSoulFiles / loadMemoryFiles / project context
│   ├── skills.ts               # skill loader (folder drop pattern)
│   ├── session.ts              # session save/load (JSON files)
│   ├── hooks-manager.ts        # user-defined hook scripts
│   ├── mcp.ts                  # MCP client + tool wrapper
│   ├── menu-cli.ts             # interactive --config menu (terminal)
│   ├── menu-tree.ts            # shared menu structure used by both CLI & Telegram menus
│   ├── permission-modes.ts     # default / plan / acceptEdits / bypassPermissions
│   └── ...
├── tools/
│   ├── SkillTool.ts            # invoke skill by name
│   ├── TodoTool.ts / TodoReadTool
│   └── AgentSpawnTool.ts       # spawn sub-agents
└── prompts/
    ├── main-agent.md           # base system prompt
    ├── soul-skeleton.md
    ├── fork.md
    └── explore.md
```

User config dir: `~/.agentnexus/`
- `config.json` — providers, models, bots, behavior knobs
- `agents/<name>/{agent.json,system.md,memory/,skills/}` — agent definitions
- `wiring.json` — channel→agent rules
- `scheduled.json` — cron tasks
- `skills/` — user-level skills
- `sessions/` — saved conversation histories
- `chats/` — exported markdown chats
- `hooks.json` (optional) — user hook scripts
- `mcp.json` (optional) — MCP server configs

## Recent change history

- **P4a — Opt-in Docker isolation (tools-only sandbox)** — agents with `container.enabled:true, mode:'tools-only'` get an ephemeral Docker container (default `node:20-slim`) per turn. Only code-executing tools (`shell_execute`, future `SANDBOXED_TOOLS`) redirect into the container; file/skill/todo tools pass through to host. Mount allowlist (`agent.container.mounts`) enforced; default mount `~/.agentnexus/agents/<name>/work` → `/work` (rw). Default network `none`. CPU/memory caps via Docker flags. New files: `src/core/container.ts`, `src/core/tool-sandbox.ts`. `runAgentLoop` accepts optional `executeTool` override (additive, backward-compatible). Config block `container` + `/config` menu pane. `full` mode (whole agent loop in container) parsed but rejected at runtime — planned for P4b with hono-based cred-proxy.
- **Telegram inline-keyboard bug fix** — grammy `callback_query:data` handlers were registered as separate middleware but each early-returned without `await next()`, so the first handler (consent) consumed all callbacks and `cfg:*` / `model:*` never reached their handlers. Fixed in `consent.ts:15`, `model-picker.ts:323`, `config-menu.ts:192` by adding `await next()` on the non-match branch.
- **Nanoclaw port (T2 + ops/safety scope, no T3)** — added channel-adapter framework, per-agent personas, wiring, engagement modes, shared turn runner, CLI adapter, cron scheduler, per-agent skill overlay.
- **`src/telegram/bot.ts` renamed to `bot.legacy.ts`** and excluded via tsconfig. Kept for reference, not built.

## How to run

```bash
npm run build           # tsc + copy prompts
npm run typecheck       # tsc --noEmit
agentnexus              # daemon — Telegram only (default)
agentnexus --cli        # daemon — Telegram + CLI both
agentnexus --cli-only   # daemon — CLI only (no Telegram polling)
agentnexus --no-cron    # disable scheduler
agentnexus --setup      # first-time wizard
agentnexus --config     # interactive config menu (terminal)
```

In Telegram chat: `/config`, `/models`, `/providers`, `/model`, `/provider`, `/apikey`, `/mode`, `/status`, `/clear`, `/abort`, `/help`.

## How to add a new channel

1. Create `src/channels/<name>.ts` exporting `create<Name>Adapter(config): ChannelAdapter`.
2. Implement: `setup`, `teardown`, `deliver`, `getOrCreateState`. Optional: `setTyping`, `askConsent`, `formatOutbound`, `formatToolCall`, `formatToolResult`.
3. Inside `setup`, call `cb.onInbound(ctx, msg)` for each inbound message (after engagement gate via `shouldEngage`).
4. Register in `src/index.ts:runDaemon` behind a CLI flag or config check.

That's it. The shared `runTurn` driver and registry handle the rest.

## How to add a new agent

```bash
mkdir -p ~/.agentnexus/agents/my-agent
cat > ~/.agentnexus/agents/my-agent/agent.json <<'EOF'
{
  "name": "my-agent",
  "engageMode": "mention",
  "modelId": "claude-opus-4-7"
}
EOF
echo "You are a research assistant. Be terse." > ~/.agentnexus/agents/my-agent/system.md
```

Wire it (example: respond in Telegram chat 12345):

```bash
cat > ~/.agentnexus/wiring.json <<'EOF'
[
  { "channelType": "telegram", "platformId": "12345", "agentName": "my-agent" }
]
EOF
```

Restart the daemon.

## Deferred (in `todo.md`)

Channels:
- Discord adapter (discord.js, thread-aware)
- Slack adapter (@slack/bolt, thread-aware)
- WhatsApp adapter (Baileys, QR-pair auth)

Ops/safety remaining (P4):
- **P4b — `full` container mode + credential proxy.** Whole agent loop in container, host signs LLM API calls via hono-based proxy. Spec: [`p4b.md`](p4b.md).
- **P4c — Sweep loop.** Heartbeat-based stuck-container detection. Depends on P4b. Spec: [`p4c.md`](p4c.md).

P4a (opt-in Docker, `tools-only` mode) shipped — see recent change history.

## Out of scope (T3 — deliberately skipped per user)

- Two-file-per-session SQLite (`inbound.db` / `outbound.db`)
- User / role tables, owner/admin grants
- Access gates, approval inline cards
- Channel-registration approval flow
- Dropped-message audit log

## Conventions

- **TypeScript strict.** ESM (`"type": "module"`, NodeNext). Imports use `.js` extensions (NodeNext resolution rule).
- **No comments unless WHY is non-obvious.** Identifiers carry the WHAT.
- **Existing terminology stays.** "Soul" file = the in-context persona/memory. "Memory" = recall-on-demand notes. Don't rename to match other tools.
- **Caveman responses to user.** Code stays normal.

## Verification before shipping changes

1. `npm run typecheck` — must be clean.
2. `npm run build` — must produce `dist/` cleanly.
3. Manual smoke test in real Telegram: start daemon, send `/start`, tap `/config` buttons, send a plain message, confirm reply.
4. If touching CLI: `agentnexus --cli-only` should drop you into a readline prompt that calls the same agent.

## Plan files (long-form, by phase)

- `/home/felipe/.claude/plans/magical-painting-whisper.md` — original nanoclaw-port plan (P1 + P2 shipped, P3 deferred to channel backlog).
- `/home/felipe/.claude/plans/proceed-with-p4-glimmering-feather.md` — P4a `tools-only` Docker sandbox plan (shipped).
- `p4b.md` *(repo root)* — P4b phase constraints: `full` container mode + credential proxy.
- `p4c.md` *(repo root)* — P4c phase constraints: sweep loop / stuck-container detection.
