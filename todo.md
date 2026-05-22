# AgentNexus — TODO

## Channels (deferred — not needed now)

- [ ] Add Discord support (discord.js adapter, thread-aware)
- [ ] Add Slack support (@slack/bolt adapter, thread-aware)
- [ ] Add WhatsApp support (Baileys adapter, QR-pair auth)

## Ops/safety (P4)

- [x] **P4a — Opt-in Docker isolation per agent, `tools-only` mode** (mount allowlist, network isolation, CPU/memory caps). `agent.container.enabled` + `mode:'tools-only'`. Default image `node:20-slim`. Container defaults pane in `/config`.
- [ ] **P4b — `full` mode + cred-proxy** (whole agent loop in container, host signs LLM API calls via hono HTTP proxy). Requires custom agent-runner image. Google SDK needs OAI-compat spike.
- [ ] **P4c — Retry/backoff sweep loop** (stuck-container heartbeat detection, only relevant once `full` mode lands).
