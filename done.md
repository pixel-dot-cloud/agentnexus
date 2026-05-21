# AgentNexus — Build Record

## Objective

Turn the codenexus terminal agent into a Telegram bot daemon. Same Nexus brain, different interface. Instead of a TUI you type into, you message a bot like a coworker and it autonomously executes tasks and replies.

Inspired by OpenClaw's architecture: a local gateway that exposes an AI agent over messaging channels you already use.

---

## What was built

### Core extraction: `src/lib/agent-loop.ts`

The main agent loop lived inside a React/Ink component (`codenexus/src/app.tsx:406-658`) tangled with `useState`, `useRef`, and UI callbacks. Extracted it into a pure async function `runAgentLoop()` that:

- Takes input, history, LLM provider, tool specs, system prompt, consent manager, and callbacks
- Iterates up to 200 tool-call cycles
- Replaces all `setStreaming`/`addLog`/`webServer.broadcast` calls with typed callbacks (`onText`, `onStream`, `onToolCall`, `onToolResult`, `onConsentRequest`, `onTodosUpdate`)
- Returns final history and usage stats
- Has no React, no Ink, no side effects outside the callbacks

This is the piece that makes the bot possible. Everything else wires to it.

### Telegram layer: `src/telegram/`

**`bot.ts`** — Grammy bot. Per-chat state map (`ChatState`): history, sessionId, permMode, isRunning, abortCtrl. On each message: whitelist check, lock, build LLM and system prompt, run agent loop, save session, unlock. Grammy's callback_query handler powers the consent flow.

**`formatter.ts`** — Strips ANSI escape codes (codenexus renders markdown to ANSI; Telegram would show garbage). Splits output on newline boundaries at the 4096-char Telegram limit. Tool call summaries are collapsed to one line with emoji prefix.

**`consent.ts`** — Sends an inline keyboard (Allow once / Always allow / Always binary / Deny) and returns a Promise that resolves when the user taps a button. 5-minute timeout auto-denies. Replaces the terminal ConsentPrompt component.

**`commands.ts`** — `/start /help /clear /model /mode /status /abort`. Thin handlers, no logic.

### Config: `src/config.ts`

Extends the codenexus ConfigManager pattern with a `telegram` section stored at `~/.agentnexus/config.json`:

- `telegram.botToken`
- `telegram.allowedUsers` — whitelist by Telegram user ID
- `telegram.permissionMode`

All data paths moved from `~/.codenexus/` to `~/.agentnexus/`.

### Setup wizard: `src/index.ts`

`agentnexus --setup` walks through bot token, allowed user IDs, provider/model configuration. Writes `~/.agentnexus/config.json`. `agentnexus` with no args starts the daemon.

### Lib files: `src/lib/`

All copied from codenexus with two adaptations:

1. Path strings `.codenexus` replaced with `.agentnexus` (session storage, hooks config, skills dirs, debug log, memory/soul file locations)
2. `permission-modes.ts` — removed `theme.js` import (terminal-only); replaced theme color functions with hardcoded hex strings

`tools.ts` — removed `node-pty` / `TerminalManager` dependency from `ShellExecuteTool`. No pseudo-terminal needed for a bot; `execAsync` is sufficient.

---

## Why these decisions

**Grammy over Telegraf** — TypeScript-first, better types, simpler middleware model, actively maintained.

**No streaming to Telegram** — Telegram has no SSE or websocket for bot messages. Streaming chunks mid-response would spam the chat. The `onStream` callback is a no-op; full text sends on completion.

**Whitelist by user ID** — Telegram bots are public by default. Anyone who finds the bot can message it. User ID whitelist is the minimal security layer before the agent loop runs. Silent ignore on non-whitelisted senders (no error response = no confirmation the bot exists).

**Per-chat state instead of global** — Each `chatId` gets its own history, session, and abort controller. Enables multiple allowed users without history bleed.

**Consent via inline keyboard** — The terminal version blocks on a React component. In Telegram the equivalent is an inline keyboard message. Grammy's `callback_query` handler resolves the Promise when the user taps. Timeout auto-denies so the agent loop does not hang if the user is away.

**`bin/agentnexus` as shell script with `realpath`** — Node shebang scripts do not follow symlinks, so `npm install -g .` breaks `$(dirname "$0")`. `realpath` resolves the symlink to the actual file before computing relative paths. Also passes `--no-deprecation` to suppress the `punycode` warning from grammy deps.

---

## Known gaps / PR targets

- `onStream` is a no-op — could send typing action or update a placeholder message during long tool chains
- `requestConsentViaTelegram` registers a new `callback_query` handler per request but never removes it — should use a one-shot listener or filter by message_id more strictly to avoid handler accumulation over long sessions
- No `/compact` command — long sessions will hit context limits with no way to summarize from Telegram
- No `/resume` command — sessions save but cannot be restored from Telegram
- `AgentSpawnTool` is registered in the tool registry but `AgentSpawnDeps.getLLM` is not wired in `bot.ts` — sub-agent spawning will fail at runtime
- Skills loaded once at boot; changes to `~/.agentnexus/skills/` require daemon restart
- Tool results over 800 chars are truncated with a char count note — could send as a `.txt` file attachment instead
- No rate limiting per user — a single allowed user can spam the bot and accumulate API costs
