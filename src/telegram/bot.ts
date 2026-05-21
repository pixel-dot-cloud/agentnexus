import { Bot } from 'grammy';
import type { ConfigManager } from '../config.js';
import type { ChatMessage } from '../providers.js';
import type { PermissionMode } from '../lib/permission-modes.js';
import { ProviderFactory } from '../providers.js';
import { runAgentLoop } from '../lib/agent-loop.js';
import { ConsentManager } from '../lib/consent.js';
import { SkillTool } from '../tools/SkillTool.js';
import { TodoTool, TodoReadTool } from '../tools/TodoTool.js';
import { AgentSpawnTool } from '../tools/AgentSpawnTool.js';
import { defaultToolRegistry, ShellExecuteTool } from '../tools.js';
import { loadSkills, type Skill } from '../lib/skills.js';
import { loadPrompt } from '../lib/prompts.js';
import { loadSoulFiles, loadMemoryFiles, loadProjectContext } from '../lib/context.js';
import { getCwd } from '../lib/cwd.js';
import { HookManager, loadHooksConfig } from '../lib/hooks-manager.js';
import { McpClient, McpTool, loadMcpConfig } from '../lib/mcp.js';
import { saveSession, newId } from '../lib/session.js';
import { formatForTelegram, formatToolCall, formatToolResult } from './formatter.js';
import { requestConsentViaTelegram, installConsentHandler } from './consent.js';
import { installModelPickerHandler } from './model-picker.js';
import { registerCommands } from './commands.js';
import { dbg, dbgErr } from '../lib/debug.js';

export interface ChatState {
  history:    ChatMessage[];
  sessionId:  string;
  permMode:   PermissionMode;
  isRunning:  boolean;
  abortCtrl?: AbortController;
}

const chats = new Map<number, ChatState>();

function getOrCreateChatState(chatId: number): ChatState {
  if (!chats.has(chatId)) {
    chats.set(chatId, {
      history:   [],
      sessionId: newId(),
      permMode:  'default',
      isRunning: false,
    });
  }
  return chats.get(chatId)!;
}

export async function startBot(config: ConfigManager): Promise<void> {
  const tgCfg = config.getTelegramConfig();
  if (!tgCfg?.botToken) {
    throw new Error('No Telegram bot token configured. Run: agentnexus --setup');
  }

  const bot = new Bot(tgCfg.botToken);

  // Hooks (daemon-scoped; shared across chats for sub-agents)
  const hooks = new HookManager(loadHooksConfig());

  // Daemon-scoped consent manager used by AgentSpawnTool. The per-chat agent
  // loop builds its own ConsentManager for its onConsentRequest flow; this
  // one is only reachable through spawned sub-agents.
  const daemonConsent = new ConsentManager(() => 'default');

  // Init tools
  defaultToolRegistry.registerTool(new ShellExecuteTool());

  // D3: mutable ref so future hot-reload paths can mutate `skillsRef` without
  // re-registering. Closure captures the ref, not the initial empty array.
  let skillsRef: Skill[] = [];
  defaultToolRegistry.registerTool(new SkillTool(() => skillsRef));
  defaultToolRegistry.registerTool(new TodoTool(() => {}));
  defaultToolRegistry.registerTool(new TodoReadTool());

  // D1: wire AgentSpawnTool. getLLM honors per-call model override.
  defaultToolRegistry.registerTool(new AgentSpawnTool({
    getLLM: (modelOverride?: string) => {
      const provider = config.getActiveProvider();
      const model    = config.getActiveModel();
      if (!provider || !model) throw new Error('No model configured for sub-agent');
      return ProviderFactory.create(provider.type, {
        endpoint: provider.endpoint,
        model:    modelOverride ?? model.id,
        apiKey:   provider.apiKey,
      });
    },
    consent:  daemonConsent,
    hooks,
    registry: defaultToolRegistry,
  }));

  // Load skills into the ref (SkillTool closure already points at it)
  skillsRef = await loadSkills(getCwd()).catch(() => []);

  // Load MCP
  const mcpConf = loadMcpConfig(getCwd());
  for (const [name, cfg] of Object.entries(mcpConf)) {
    const client = new McpClient(name, cfg.command, cfg.args ?? [], cfg.env);
    try {
      await client.initialize();
      const tools = await client.listTools();
      for (const tool of tools) {
        defaultToolRegistry.registerTool(
          new McpTool(tool.name, tool.description, client, tool.inputSchema),
        );
      }
      console.log(`MCP: ${tools.length} tools from "${name}"`);
    } catch (e: any) {
      console.error(`MCP "${name}": ${e.message}`);
    }
  }

  hooks.run('SessionStart');

  // D9: install global consent callback handler once
  installConsentHandler(bot);
  installModelPickerHandler(bot, config);

  // Register commands
  registerCommands(bot, chats, config);

  // Main message handler
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    // D7: defense in depth — empty/missing whitelist denies all
    if (!Array.isArray(tgCfg.allowedUsers) || tgCfg.allowedUsers.length === 0) {
      dbg('bot.message.denied.emptyWhitelist', { userId, chatId });
      return;
    }
    if (!userId || !tgCfg.allowedUsers.includes(userId)) {
      dbg('bot.message.denied', { userId, chatId });
      return;
    }

    const state = getOrCreateChatState(chatId);

    if (state.isRunning) {
      await ctx.reply('Task in progress. Use /abort to cancel.').catch(() => {});
      return;
    }

    const userText = ctx.message.text;
    if (!userText?.trim()) return;

    state.isRunning = true;
    const ac = new AbortController();
    state.abortCtrl = ac;

    // D4: keep typing indicator alive across long tool chains
    await ctx.replyWithChatAction('typing').catch(() => {});
    const typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    const provider = config.getActiveProvider();
    const model    = config.getActiveModel();
    if (!provider || !model) {
      clearInterval(typingInterval);
      state.isRunning = false;
      state.abortCtrl = undefined;
      await ctx.reply('No model configured. Edit ~/.agentnexus/config.json').catch(() => {});
      return;
    }

    const llm = ProviderFactory.create(provider.type, {
      endpoint: provider.endpoint,
      model:    model.id,
      apiKey:   provider.apiKey,
    });

    // Build system prompt
    const parts: string[] = [];
    try { parts.push(loadPrompt('main-agent')); } catch {}
    const soul = loadSoulFiles(getCwd());
    if (soul) parts.push(`<soul>\n${soul}\n</soul>`);
    const memory = loadMemoryFiles(getCwd());
    if (memory) parts.push(`<memory>\n${memory}\n</memory>`);
    const projectCtx = loadProjectContext();
    if (projectCtx) parts.push(projectCtx);
    const systemPrompt = parts.join('\n\n');

    const buildToolSpecs = () => defaultToolRegistry.getToolSpecs();

    // D8: new ConsentManager API — only getMode, no promptFn
    const consentManager = new ConsentManager(() => state.permMode);

    try {
      const result = await runAgentLoop(
        userText,
        state.history,
        llm,
        buildToolSpecs,
        systemPrompt,
        consentManager,
        {
          onText: async (text) => {
            const chunks = formatForTelegram(text);
            for (const chunk of chunks) {
              await bot.api.sendMessage(chatId, chunk).catch((e) => dbgErr('bot.sendMessage', e));
            }
          },
          onStream: () => {},
          onToolCall: async (name, args) => {
            // D10: formatter returns plain text — no Markdown parse_mode
            const summary = formatToolCall(name, args);
            await bot.api.sendMessage(chatId, summary).catch(() => {});
          },
          onToolResult: async (name, output, isError) => {
            const summary = formatToolResult(name, output, isError);
            await bot.api.sendMessage(chatId, summary).catch(() => {});
          },
          onConsentRequest: async (req) => {
            return requestConsentViaTelegram(bot, chatId, req);
          },
          onTodosUpdate: async () => {},
        },
        ac.signal,
      );

      state.history = result.history;

      saveSession({
        id:        state.sessionId,
        createdAt: new Date().toISOString(),
        model:     model.name,
        provider:  provider.name,
        history:   state.history,
      });

    } catch (e: any) {
      dbgErr('bot.agentLoop.threw', e);
      if (!ac.signal.aborted) {
        await ctx.reply(`Error: ${e.message}`).catch(() => {});
      }
    } finally {
      clearInterval(typingInterval);
      state.isRunning = false;
      state.abortCtrl = undefined;
    }
  });

  await bot.api.setMyCommands([
    { command: 'start',     description: 'Greeting and usage' },
    { command: 'clear',     description: 'Reset conversation' },
    { command: 'model',     description: 'List or switch model' },
    { command: 'models',    description: 'Interactive model picker' },
    { command: 'providers', description: 'List providers' },
    { command: 'provider',  description: 'Switch active provider' },
    { command: 'apikey',    description: 'Set or clear a provider API key' },
    { command: 'mode',      description: 'Change permission mode' },
    { command: 'status',    description: 'Current status' },
    { command: 'abort',     description: 'Cancel running task' },
    { command: 'help',      description: 'Show help' },
  ]);

  console.log('Nexus online — polling Telegram...');
  bot.start();

  // D5: graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    try { await bot.stop(); } catch {}
    process.exit(0);
  };
  process.once('SIGINT',  shutdown);
  process.once('SIGTERM', shutdown);
}
