import { Bot } from 'grammy';
import type { ConfigManager } from '../config.js';
import type { ChatMessage } from '../providers.js';
import type { PermissionMode } from '../lib/permission-modes.js';
import { ProviderFactory } from '../providers.js';
import { runAgentLoop } from '../lib/agent-loop.js';
import { ConsentManager } from '../lib/consent.js';
import { SkillTool } from '../tools/SkillTool.js';
import { TodoTool, TodoReadTool } from '../tools/TodoTool.js';
import { defaultToolRegistry, ShellExecuteTool } from '../tools.js';
import { loadSkills } from '../lib/skills.js';
import { loadPrompt } from '../lib/prompts.js';
import { loadSoulFiles, loadMemoryFiles, loadProjectContext } from '../lib/context.js';
import { getCwd } from '../lib/cwd.js';
import { HookManager, loadHooksConfig } from '../lib/hooks-manager.js';
import { McpClient, McpTool, loadMcpConfig } from '../lib/mcp.js';
import { saveSession, newId } from '../lib/session.js';
import { formatForTelegram, formatToolCall, formatToolResult } from './formatter.js';
import { requestConsentViaTelegram } from './consent.js';
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

  // Init tools
  defaultToolRegistry.registerTool(new ShellExecuteTool());
  defaultToolRegistry.registerTool(new SkillTool(() => []));
  defaultToolRegistry.registerTool(new TodoTool(() => {}));
  defaultToolRegistry.registerTool(new TodoReadTool());

  // Load skills (update SkillTool after load)
  const skills = await loadSkills(getCwd()).catch(() => []);
  if (skills.length) {
    defaultToolRegistry.registerTool(new SkillTool(() => skills));
  }

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

  // Hooks
  const hooks = new HookManager(loadHooksConfig());
  hooks.run('SessionStart');

  // Register commands
  registerCommands(bot, chats, config);

  // Main message handler
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    // Whitelist check
    if (!tgCfg.allowedUsers.includes(userId ?? -1)) {
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

    await ctx.replyWithChatAction('typing').catch(() => {});

    const provider = config.getActiveProvider();
    const model    = config.getActiveModel();
    if (!provider || !model) {
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

    const consentManager = new ConsentManager(
      async (req) => {
        const result = await requestConsentViaTelegram(bot, chatId, req);
        return result === false ? 'deny' : result;
      },
      () => state.permMode,
    );

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
            const summary = formatToolCall(name, args);
            await bot.api.sendMessage(chatId, summary, { parse_mode: 'Markdown' }).catch(() => {});
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
      state.isRunning = false;
      state.abortCtrl = undefined;
    }
  });

  await bot.api.setMyCommands([
    { command: 'start',  description: 'Greeting and usage' },
    { command: 'clear',  description: 'Reset conversation' },
    { command: 'model',  description: 'List or switch model' },
    { command: 'mode',   description: 'Change permission mode' },
    { command: 'status', description: 'Current status' },
    { command: 'abort',  description: 'Cancel running task' },
    { command: 'help',   description: 'Show help' },
  ]);

  console.log('Nexus online — polling Telegram...');
  bot.start();
}
