import * as readline from 'readline';
import { ConfigManager, CONFIG_DIR, AUTO_MODEL } from './config.js';
import { runConfigMenu } from './lib/menu-cli.js';
import { setupDaemon } from './core/daemon-setup.js';
import { registerAdapter, startAdapters, stopAdapters, listStarted } from './channels/registry.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { createCliAdapter } from './channels/cli.js';
import { resolveAgent } from './core/agents.js';
import { runTurn } from './core/run-turn.js';
import { resolveWiring, fallbackWiring } from './core/wiring.js';
import { startScheduler, stopScheduler } from './core/scheduler.js';
import { sweeper } from './core/sweep.js';
import { stopCredProxy } from './core/cred-proxy.js';
import { botPool } from './lib/bot-pool.js';
import { runImportCommand, runFilesCommand, WORKSPACE_HELP } from './lib/workspace-cli.js';
import type { ChannelAdapter, InboundContext, InboundMessage } from './channels/types.js';

const args = process.argv.slice(2);
const cmd  = args[0];

if (cmd === 'import') {
  runImportCommand(args.slice(1));
} else if (cmd === 'files' || cmd === 'workspace' || cmd === 'ws') {
  runFilesCommand(args.slice(1));
} else if (cmd === 'setup') {
  await runSetup();
} else if (cmd === 'config') {
  const config = new ConfigManager();
  await runConfigMenu(config);
  process.exit(0);
} else if (cmd === 'cli') {
  await runTui();
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  showHelp();
  process.exit(0);
} else if (cmd === 'serve' || cmd === 'daemon' || cmd === 'gateway') {
  await runDaemon(args.slice(1));
} else if (!cmd) {
  showHelp();
  process.exit(0);
} else {
  console.error(`Unknown command: ${cmd}`);
  showHelp();
  process.exit(1);
}

function showHelp(): void {
  console.log(`
AgentNexus — multi-bot LLM agent daemon

Usage:
  agentnexus setup                      Run the setup wizard
  agentnexus serve                      Start the daemon (Telegram + configured channels)
  agentnexus cli                        TUI config then start terminal chat
  agentnexus config                     Open interactive config menu
  agentnexus import <src> [agent]       Copy file/folder into agent workspace
  agentnexus files [agent] <cmd>        Manage agent workspace files
  agentnexus help                       Show this help

Serve flags:
  --no-telegram              Skip Telegram adapters
  --cli-only                 Only start the terminal channel
  --no-cron                  Disable cron scheduler
  --verbose, -v              Log every inbound message, tool call, and subagent event

Files subcommands:
  ls [path]   show [file]   rm <path>   mkdir <path>
  link [dest]   open   path
`.trim());
}

async function runTui(): Promise<void> {
  const config = new ConfigManager();
  const { AgentNexusTuiCLI } = await import('./lib/tui-cli.js');
  const tui = new AgentNexusTuiCLI(config);
  await tui.run();
  // 'Start chat' returns from tui.run() → launch daemon with CLI channel only.
  await runDaemon(['--cli-only']);
}

function defaultIdentity(text: string): string[] {
  const t = (text ?? '').trim();
  return t ? [t] : [];
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

async function runDaemon(cliArgs: string[]): Promise<void> {
  const config = new ConfigManager();

  const enableTelegram = !cliArgs.includes('--no-telegram') && !cliArgs.includes('--cli-only');
  const enableCli      =  cliArgs.includes('--cli') || cliArgs.includes('--cli-only');
  const enableCron     = !cliArgs.includes('--no-cron');
  const verbose        =  cliArgs.includes('--verbose') || cliArgs.includes('-v');

  const bots = enableTelegram ? config.getBots() : [];
  if (enableTelegram && !bots.length && !enableCli) {
    console.error('No Telegram bots configured. Run: agentnexus setup  or  agentnexus cli  to use the terminal channel.');
    process.exit(1);
  }

  console.log('Starting AgentNexus daemon...');

  // Daemon-scoped wiring (tools, MCP, skills, hooks).
  await setupDaemon(config, {
    onAgentEvent: verbose ? (ev) => {
      const id = ev.id.slice(0, 8);
      if (ev.type === 'start')      console.log(`${ts()} [↗] subagent:${id} spawned "${ev.data?.task ?? ''}"`);
      else if (ev.type === 'end')   console.log(`${ts()} [↙] subagent:${id} done`);
      else if (ev.type === 'error') console.log(`${ts()} [✗] subagent:${id} error: ${ev.data?.message}`);
      else if (ev.type === 'tool_call')
        console.log(`${ts()} [⚙] subagent:${id} ${ev.data?.name}: ${JSON.stringify(ev.data?.args ?? {}).slice(0, 120)}`);
    } : undefined,
  });

  // Bot-pool init + restore persisted lastUserChat.
  botPool.init(() => config.getBots());
  botPool.load();

  // Register channel adapters.
  if (enableTelegram) {
    for (const inst of bots) {
      if (!inst.botToken) {
        console.error(`Skipping bot "${inst.name}": no botToken set.`);
        continue;
      }
      registerAdapter(createTelegramAdapter(inst, config));
    }
  }
  if (enableCli) {
    registerAdapter(createCliAdapter(config));
  }

  // Adapter-agnostic inbound handler.
  const callbacks = {
    async onInbound(ctx: InboundContext, msg: InboundMessage): Promise<void> {
      const adapter: ChannelAdapter | undefined =
        listStarted().find(a => a.name === `${ctx.channelType}:${ctx.adapterId}`)
        ?? listStarted().find(a => a.channelType === ctx.channelType);
      if (!adapter) {
        console.error(`No adapter for channel "${ctx.channelType}"`);
        return;
      }

      if (verbose) {
        console.log(`${ts()} [→] ${ctx.adapterId ?? ctx.channelType}:${ctx.platformId} "${msg.text.slice(0, 120)}"`);
      }

      const wiring = resolveWiring(ctx.channelType, ctx.platformId, ctx.threadId)
                  ?? fallbackWiring(ctx.channelType, ctx.platformId);
      const agent  = resolveAgent(wiring.agentName);
      const state  = adapter.getOrCreateState(ctx.platformId, ctx.threadId);

      const baseToolCallText   = adapter.formatToolCall   ?? (() => null);
      const baseToolResultText = adapter.formatToolResult ?? (() => null);

      const turnArgs = {
        state,
        agent,
        config,
        adapter,
        platformId:      ctx.platformId,
        threadId:        ctx.threadId,
        formatOutbound:  adapter.formatOutbound ?? defaultIdentity,
        onToolCallText: verbose ? (name: string, args: Record<string, unknown>) => {
          console.log(`${ts()} [⚙] ${name}: ${JSON.stringify(args).slice(0, 200)}`);
          return baseToolCallText(name, args);
        } : baseToolCallText,
        onToolResultText: verbose ? (name: string, output: string, isError: boolean) => {
          const truncated = output.slice(0, 200);
          console.log(`${ts()} [${isError ? '✗' : '✓'}] ${name}: ${truncated}`);
          return baseToolResultText(name, output, isError);
        } : baseToolResultText,
      };

      // Run turn then drain any queued messages (interrupt / queue mode).
      await runTurn({ text: msg.text, ...turnArgs });
      while (state.messageQueue.length > 0) {
        const next = state.messageQueue.shift()!;
        if (verbose) console.log(`${ts()} [↻] draining queue: "${next.slice(0, 80)}"`);
        await runTurn({ text: next, ...turnArgs });
      }
    },
  };

  await startAdapters(callbacks);

  const started = listStarted();
  if (!started.length) {
    console.error('No channel adapters could start.');
    process.exit(1);
  }
  console.log(`Nexus online — ${started.length} channel(s): ${started.map(a => a.name).join(', ')}`);

  if (enableCron) {
    startScheduler(config, callbacks);
  }

  // P4c — start sweep loop for stuck full-mode containers.
  const swCfg = config.getSweepConfig();
  sweeper.start(
    {
      enabled:          swCfg.enabled,
      intervalMs:       swCfg.intervalSec       * 1000,
      staleThresholdMs: swCfg.staleThresholdSec * 1000,
      startupGraceMs:   swCfg.startupGraceSec   * 1000,
    },
    config.getContainerDefaults().dockerPath,
  );

  const shutdown = async () => {
    console.log('Shutting down...');
    botPool.save();
    sweeper.stop();
    stopScheduler();
    stopCredProxy();
    await stopAdapters();
    process.exit(0);
  };
  process.once('SIGINT',  shutdown);
  process.once('SIGTERM', shutdown);
}

async function runSetup(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (question: string): Promise<string> =>
    new Promise(resolve => rl.question(question, resolve));

  console.log('\n=== AgentNexus Setup ===\n');

  const config = new ConfigManager();
  const cfg = config.getConfig();

  const existingBots   = config.getBots();
  const existingFirst  = existingBots[0];
  const existingToken  = existingFirst?.botToken ?? '';
  const tokenPrompt    = existingToken
    ? `Telegram bot token [${existingToken.slice(0, 10)}...]: `
    : 'Telegram bot token (from @BotFather): ';
  const botToken = (await ask(tokenPrompt)).trim() || existingToken;

  if (!botToken) {
    console.error('Bot token required. Get one from @BotFather on Telegram.');
    rl.close();
    process.exit(1);
  }

  const existingUsers = existingFirst?.allowedUsers ?? [];
  const usersStr      = existingUsers.length ? existingUsers.join(',') : '';
  const usersPrompt   = existingUsers.length
    ? `Allowed Telegram user IDs (comma-separated) [${usersStr}]: `
    : 'Your Telegram user ID (get from @userinfobot): ';
  const usersInput = (await ask(usersPrompt)).trim() || usersStr;
  const allowedUsers = usersInput
    .split(',')
    .map(s => parseInt(s.trim()))
    .filter(n => !isNaN(n) && n > 0);

  if (!allowedUsers.length) {
    console.error('At least one allowed user ID required.');
    rl.close();
    process.exit(1);
  }

  let runProviderFlow = false;
  if (cfg.providers.length === 0) {
    runProviderFlow = true;
  } else {
    console.log('\n--- Configured providers ---');
    cfg.providers.forEach((p, i) => {
      const active = p.name === cfg.activeProvider ? '  <- active' : '';
      console.log(`${i + 1}. ${p.name} (${p.type})${active}`);
    });
    const addAnother = (await ask('Add another provider? [y/N]: ')).trim().toLowerCase();
    if (addAnother === 'y' || addAnother === 'yes') {
      runProviderFlow = true;
    }
  }

  if (runProviderFlow) {
    console.log('\n--- LLM Provider ---');
    console.log('1. Anthropic');
    console.log('2. Ollama (local)');
    console.log('3. LM Studio (local)');
    console.log('4. Google AI');
    console.log('5. OpenAI-compatible (custom)');

    const provChoice = (await ask('Provider [1-5]: ')).trim();
    const provMap: Record<string, string> = {
      '1': 'anthropic',
      '2': 'ollama',
      '3': 'lmstudio',
      '4': 'google',
      '5': 'custom',
    };
    const provType = provMap[provChoice];

    if (provType) {
      let apiKey = '';
      let endpoint = '';
      let modelId = '';
      let modelName = '';

      if (provType === 'anthropic') {
        apiKey    = (await ask('Anthropic API key: ')).trim();
        modelId   = (await ask('Model ID [claude-opus-4-7]: ')).trim() || 'claude-opus-4-7';
        modelName = modelId;
      } else if (provType === 'ollama') {
        endpoint  = (await ask('Ollama endpoint [http://localhost:11434]: ')).trim() || 'http://localhost:11434';
      } else if (provType === 'lmstudio') {
        endpoint  = (await ask('LM Studio endpoint [http://localhost:1234]: ')).trim() || 'http://localhost:1234';
        apiKey    = (await ask('LM Studio API key (optional, leave blank for local): ')).trim();
      } else if (provType === 'google') {
        apiKey    = (await ask('Google AI API key: ')).trim();
        modelId   = (await ask('Model ID [gemini-2.0-flash]: ')).trim() || 'gemini-2.0-flash';
        modelName = modelId;
      } else if (provType === 'custom') {
        endpoint  = (await ask('API endpoint: ')).trim();
        apiKey    = (await ask('API key (optional): ')).trim();
        modelId   = (await ask('Model ID: ')).trim();
        modelName = modelId;
      }

      const provName = `${provType}-${cfg.providers.length + 1}`;
      const isLocal = provType === 'ollama' || provType === 'lmstudio';
      config.addProvider({ name: provName, type: provType as any, endpoint: endpoint || undefined, apiKey: apiKey || undefined });
      if (modelId) {
        config.addModel({ id: modelId, name: modelName, provider: provName });
      }
      if (!cfg.activeProvider) {
        config.setActiveProvider(provName);
        if (modelId)       config.setActiveModel(modelId);
        else if (isLocal)  config.setActiveModel(AUTO_MODEL);
      }
    }
  }

  const existingExtras = existingBots.slice(1);
  config.setTelegramConfig({
    bots: [
      {
        name:           existingFirst?.name ?? 'default',
        botToken,
        allowedUsers,
        permissionMode: existingFirst?.permissionMode ?? 'default',
      },
      ...existingExtras,
    ],
    defaults: { permissionMode: 'default' },
  });

  rl.close();

  console.log(`\nConfig saved to ${CONFIG_DIR}/config.json`);
  console.log('\nRun: agentnexus serve      (start daemon — Telegram)');
  console.log('     agentnexus cli        (terminal channel with TUI config)');
  console.log('     agentnexus config     (open interactive config menu)');
  console.log('     agentnexus setup      (re-run this wizard)');
}
