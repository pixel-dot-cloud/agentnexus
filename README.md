# agentnexus

Personal AI agent daemon. Connects to Telegram, runs tasks autonomously, talks to local LLMs (LM Studio, Ollama) or cloud providers (Anthropic, Google). Supports multiple bots, container-isolated execution, subagents, and scheduled tasks.

## install

If you have the `gh` CLI authenticated:

```bash
bash <(gh api repos/pixel-dot-cloud/agentnexus/contents/install.sh --jq '.content' | base64 -d)
```

Or with a personal access token:

```bash
curl -fsSL -H "Authorization: token YOUR_TOKEN" \
  https://raw.githubusercontent.com/pixel-dot-cloud/agentnexus/master/install.sh | bash
```

The script clones the repo, builds, and links the binary to `~/.local/bin/agentnexus`.

## requirements

- Node.js 18+
- Docker (optional, for sandboxed container mode)

## setup

```
npm install
npm run build
agentnexus setup
agentnexus serve
```

`setup` walks through provider and Telegram bot configuration and writes to `~/.agentnexus/config.json`. After that `serve` starts the daemon.

For verbose output (tool calls, subagent events, inbound messages):

```
agentnexus serve --verbose or agentnexus serve -v
```

## running as a service

Install as a systemd user service so it starts on boot and restarts on failure:

```
bash contrib/install-service.sh
```

The script detects your node binary, writes the unit file to `~/.config/systemd/user/agentnexus.service`, and enables it immediately.

If you want the service to keep running after you log out (e.g. on a headless machine):

```
loginctl enable-linger $USER
```

To remove the service:

```
bash contrib/uninstall-service.sh
```

Logs:

```
journalctl --user -u agentnexus -f
```

## workspace

Each agent gets a working directory at `~/.agentnexus/agents/<name>/work`, mounted inside the container as `/work`. You can manage it from the CLI:

```
agentnexus import /path/to/project
agentnexus files ls
agentnexus files link          # symlink ~/nexus-workspace -> workspace
```

## license

PolyForm Noncommercial License 1.0.0. See LICENSE.
