import { Bot } from 'grammy';
import type { BotInstance, ConfigManager } from '../config.js';
import type {
  ChannelAdapter,
  ChannelCallbacks,
  InboundContext,
  OutboundMessage,
} from './types.js';
import type { ConsentDecision, ConsentRequest } from '../lib/consent.js';

import { ChatState, createState } from '../core/run-turn.js';
import { resolveWiring, fallbackWiring } from '../core/wiring.js';
import { shouldEngage } from '../core/engage.js';

import { installConsentHandler, requestConsentViaTelegram } from '../telegram/consent.js';
import { installModelPickerHandler } from '../telegram/model-picker.js';
import { installConfigMenuHandler, routeInputForChat } from '../telegram/config-menu.js';
import { registerCommands } from '../telegram/commands.js';
import { formatForTelegram, formatToolCall as tgFormatToolCall, formatToolResult as tgFormatToolResult } from '../telegram/formatter.js';
import { botPool } from '../lib/bot-pool.js';
import { subagentRegistry } from '../lib/subagent-registry.js';
import { dbg, dbgErr } from '../lib/debug.js';

const CHANNEL_TYPE = 'telegram';

export interface TelegramAdapterHandle extends ChannelAdapter {
  /** Direct grammy Bot — exposed so per-bot commands can reach it. Internal. */
  bot:   Bot;
  /** Per-chat state map — keyed by Telegram chat id. */
  chats: Map<number, ChatState>;
  /** The BotInstance config that drove this adapter. */
  inst:  BotInstance;
}

export function createTelegramAdapter(inst: BotInstance, config: ConfigManager): TelegramAdapterHandle {
  const bot   = new Bot(inst.botToken);
  const chats = new Map<number, ChatState>();
  let connected = false;

  function getOrCreate(chatId: number): ChatState {
    let s = chats.get(chatId);
    if (!s) {
      const permMode  = inst.permissionMode ?? config.getDefaultPermissionMode();
      const busyMode  = inst.busyMode ?? config.getTelegramConfig()?.defaults?.busyMode ?? 'queue';
      s = createState(permMode, busyMode);
      chats.set(chatId, s);
    }
    return s;
  }

  const adapter: TelegramAdapterHandle = {
    name:            `telegram:${inst.name}`,
    channelType:     CHANNEL_TYPE,
    supportsThreads: false,
    bot,
    chats,
    inst,

    isConnected() { return connected; },

    async setup(cb: ChannelCallbacks): Promise<void> {
      installConsentHandler(bot);
      installModelPickerHandler(bot, config);
      installConfigMenuHandler(bot, config);
      registerCommands(bot, chats, config, inst.name);

      bot.on('message:text', async (ctx) => {
        const userId = ctx.from?.id;
        const chatId = ctx.chat.id;

        if (!Array.isArray(inst.allowedUsers) || inst.allowedUsers.length === 0) {
          dbg('tg.deny.emptyWhitelist', { bot: inst.name, userId, chatId });
          return;
        }
        if (!userId || !inst.allowedUsers.includes(userId)) {
          dbg('tg.deny.notAllowed', { bot: inst.name, userId, chatId });
          return;
        }

        const userText = ctx.message.text;
        if (!userText?.trim()) return;

        // Pool-bot routing: if this bot is a pool bot, route to bound subagent inbox.
        if (inst.pool === true) {
          const agentId = botPool.getBoundAgent(inst.name);
          if (!agentId) {
            dbg('tg.pool.unbound.drop', { bot: inst.name, chatId });
            console.log(`[pool] ${inst.name}: unbound, dropping message from chat ${chatId}`);
            return;
          }
          const session = subagentRegistry.get(agentId);
          if (!session) {
            dbg('tg.pool.noSession', { bot: inst.name, agentId });
            return;
          }
          botPool.touchUserChat(inst.name, chatId.toString());
          session.userInbox.push(userText);
          dbg('tg.pool.routed', { bot: inst.name, agentId, chatId });
          return;
        }

        // Config-menu input capture (multi-step prompts) — main bots only.
        const consumed = await routeInputForChat(bot, chatId, userText, config);
        if (consumed) return;

        const platformId = chatId.toString();
        const wiring     = resolveWiring(CHANNEL_TYPE, platformId, null) ?? fallbackWiring(CHANNEL_TYPE, platformId);

        const isGroup   = ctx.chat.type !== 'private';
        const isMention = false; // Telegram mentions handled at username level — DMs always pass; group filtering uses pattern/mention modes below.

        if (!shouldEngage(userText, isMention, isGroup, wiring.engageMode ?? 'pattern', wiring.engagePattern)) {
          dbg('tg.engage.skip', { bot: inst.name, chatId, mode: wiring.engageMode });
          return;
        }

        const inboundCtx: InboundContext = {
          channelType: CHANNEL_TYPE,
          platformId,
          threadId:    null,
          userId:      userId?.toString(),
          userName:    ctx.from?.username ?? ctx.from?.first_name,
          adapterId:   inst.name,
        };

        await cb.onInbound(inboundCtx, {
          id:        `tg-${ctx.message.message_id}`,
          text:      userText,
          timestamp: new Date().toISOString(),
          isMention,
          isGroup,
        });
      });

      bot.api.setMyCommands([
        { command: 'start',     description: 'Greeting and usage' },
        { command: 'new',       description: 'Start new conversation' },
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
      ]).catch((e) => dbgErr('tg.setMyCommands', e));

      // grammy's start() resolves only on stop. Fire-and-forget.
      bot.start().catch((e) => dbgErr('tg.start', e));
      connected = true;
    },

    async teardown(): Promise<void> {
      if (!connected) return;
      try { await bot.stop(); } catch {}
      connected = false;
    },

    async deliver(platformId: string, _threadId: string | null, msg: OutboundMessage): Promise<string | undefined> {
      const chatId = Number(platformId);
      let lastMsgId: number | undefined;
      if (msg.text) {
        const sendOpts = msg.parseMode ? { parse_mode: msg.parseMode as 'HTML' | 'Markdown' | 'MarkdownV2' } : {};
        for (const chunk of formatForTelegram(msg.text)) {
          try {
            const sent = await bot.api.sendMessage(chatId, chunk, sendOpts);
            lastMsgId = sent.message_id;
          } catch (e) { dbgErr('tg.deliver', e); }
        }
      }
      if (msg.files?.length) {
        for (const f of msg.files) {
          try {
            const sent = await bot.api.sendDocument(chatId, new (await import('grammy')).InputFile(f.data, f.filename));
            lastMsgId = sent.message_id;
          } catch (e) { dbgErr('tg.deliver.file', e); }
        }
      }
      return lastMsgId?.toString();
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      const chatId = Number(platformId);
      try { await bot.api.sendChatAction(chatId, 'typing'); } catch {}
    },

    async askConsent(
      platformId: string,
      _threadId:  string | null,
      req:        ConsentRequest,
      timeoutMs:  number,
    ): Promise<ConsentDecision | false> {
      const chatId = Number(platformId);
      return requestConsentViaTelegram(bot, chatId, req, timeoutMs);
    },

    getOrCreateState(platformId: string, _threadId: string | null): ChatState {
      return getOrCreate(Number(platformId));
    },

    formatOutbound:   (text) => formatForTelegram(text),
    formatToolCall:   (name, args) => tgFormatToolCall(name, args),
    formatToolResult: (name, output, isError) => tgFormatToolResult(name, output, isError, config.getToolResultTruncChars()),
  };

  return adapter;
}
