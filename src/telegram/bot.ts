import { Bot } from 'grammy';
import type { ConfigManager, BotInstance } from '../config.js';
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
import { installConfigMenuHandler, routeInputForChat } from './config-menu.js';
import { registerCommands } from './commands.js';
import { dbg, dbgErr } from '../lib/debug.js';

export interface ChatState {
  history:    ChatMessage[];
  sessionId:  string;
  permMode:   PermissionMode;
  isRunning:  boolean;
  abortCtrl?: AbortController;
}

export async function startBot(config: ConfigManager): Promise<void> {
  const bots = config.getBots();
  if (!bots.length) {
    throw new Error('No Telegram bots configured. Run: agentnexus --setup or agentnexus --config');
  }

  // ── Daemon-scoped wiring (shared by all bots) ──────────────────────────────
  const hooks = new HookManager(loadHooksConfig());
  const daemonConsent = new ConsentManager(() => 'default');

  defaultToolRegistry.registerTool(new ShellExecuteTool());

  let skillsRef: Skill[] = [];
  defaultToolRegistry.registerTool(new SkillTool(() => skillsRef));
  defaultToolRegistry.registerTool(new TodoTool(() => {}));
  defaultToolRegistry.registerTool(new TodoReadTool());

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

  skillsRef = await loadSkills(getCwd()).catch(() => []);

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

  // ── Per-bot wiring ─────────────────────────────────────────────────────────
  const runningBots: { bot: Bot; name: string }[] = [];

  for (const inst of bots) {
    if (!inst.botToken) {
      console.error(`Skipping bot "${inst.name}": no botToken set. Use /config or agentnexus --config to set it.`);
      continue;
    }
    try {
      const bot = startSingleBot(inst, config);
      runningBots.push({ bot, name: inst.name });
    } catch (e: any) {
      console.error(`Bot "${inst.name}" failed to start: ${e.message}`);
    }
  }

  if (!runningBots.length) {
    throw new Error('No bots could be started. Use agentnexus --config to fix tokens.');
  }

  console.log(`Nexus online — ${runningBots.length} bot(s) polling: ${runningBots.map(b => b.name).join(', ')}`);

  // Graceful shutdown stops every bot
  const shutdown = async () => {
    console.log('Shutting down...');
    await Promise.allSettled(runningBots.map(b => b.bot.stop()));
    process.exit(0);
  };
  process.once('SIGINT',  shutdown);
  process.once('SIGTERM', shutdown);
}

function startSingleBot(inst: BotInstance, config: ConfigManager): Bot {
  const bot   = new Bot(inst.botToken);
  const chats = new Map<number, ChatState>();

  function getOrCreateChatState(chatId: number): ChatState {
    let state = chats.get(chatId);
    if (!state) {
      state = {
        history:   [],
        sessionId: newId(),
        permMode:  inst.permissionMode ?? config.getDefaultPermissionMode(),
        isRunning: false,
      };
      chats.set(chatId, state);
    }
    return state;
  }

  installConsentHandler(bot);
  installModelPickerHandler(bot, config);
  installConfigMenuHandler(bot, config);

  registerCommands(bot, chats, config, inst.name);

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (!Array.isArray(inst.allowedUsers) || inst.allowedUsers.length === 0) {
      dbg('bot.message.denied.emptyWhitelist', { bot: inst.name, userId, chatId });
      return;
    }
    if (!userId || !inst.allowedUsers.includes(userId)) {
      dbg('bot.message.denied', { bot: inst.name, userId, chatId });
      return;
    }

    const userText = ctx.message.text;
    if (!userText?.trim()) return;

    // Config menu may be awaiting text input — consume before agent loop.
    const consumed = await routeInputForChat(bot, chatId, userText, config);
    if (consumed) return;

    const state = getOrCreateChatState(chatId);
    if (state.isRunning) {
      await ctx.reply('Task in progress. Use /abort to cancel.').catch(() => {});
      return;
    }

    state.isRunning = true;
    const ac = new AbortController();
    state.abortCtrl = ac;

    await ctx.replyWithChatAction('typing').catch(() => {});
    const typingMs = Math.max(1, config.getTypingIntervalSec()) * 1000;
    const typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, typingMs);

    const provider = config.getActiveProvider();
    const model    = config.getActiveModel();
    if (!provider || !model) {
      clearInterval(typingInterval);
      state.isRunning = false;
      state.abortCtrl = undefined;
      await ctx.reply('No model configured. Use /config or /models.').catch(() => {});
      return;
    }

    const llm = ProviderFactory.create(provider.type, {
      endpoint: provider.endpoint,
      model:    model.id,
      apiKey:   provider.apiKey,
    });

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
          onStream:   () => {},
          onToolCall: async (name, args) => {
            const summary = formatToolCall(name, args);
            await bot.api.sendMessage(chatId, summary).catch(() => {});
          },
          onToolResult: async (name, output, isError) => {
            const summary = formatToolResult(name, output, isError, config.getToolResultTruncChars());
            await bot.api.sendMessage(chatId, summary).catch(() => {});
          },
          onConsentRequest: async (req) => {
            return requestConsentViaTelegram(bot, chatId, req, config.getConsentTimeoutSec() * 1000);
          },
          onTodosUpdate: async () => {},
        },
        ac.signal,
        config.getMaxToolIter(),
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

  bot.api.setMyCommands([
    { command: 'start',     description: 'Greeting and usage' },
    { command: 'clear',     description: 'Reset conversation' },
    { command: 'config',    description: 'Open interactive config menu' },
    { command: 'model',     description: 'List or switch model' },
    { command: 'models',    description: 'Interactive model picker' },
    { command: 'providers', description: 'List providers' },
    { command: 'provider',  description: 'Switch active provider' },
    { command: 'apikey',    description: 'Set or clear a provider API key' },
    { command: 'mode',      description: 'Change permission mode' },
    { command: 'status',    description: 'Current status' },
    { command: 'abort',     description: 'Cancel running task' },
    { command: 'help',      description: 'Show help' },
  ]).catch((e) => dbgErr('bot.setMyCommands', e));

  bot.start();
  return bot;
}
