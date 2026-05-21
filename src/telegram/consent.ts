import { Bot, InlineKeyboard } from 'grammy';
import type { ConsentRequest, ConsentDecision } from '../lib/consent.js';

const DEFAULT_CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingConsent {
  resolve: (d: ConsentDecision | false) => void;
  toolName: string;
  timeout: NodeJS.Timeout;
}

const pending = new Map<number, PendingConsent>();

export function installConsentHandler(bot: Bot): void {
  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.callbackQuery.data?.startsWith('consent:')) return;

    const messageId = ctx.callbackQuery.message?.message_id;
    if (messageId === undefined) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    const entry = pending.get(messageId);
    if (!entry) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    clearTimeout(entry.timeout);
    pending.delete(messageId);

    await ctx.answerCallbackQuery().catch(() => {});

    const raw = ctx.callbackQuery.data.slice('consent:'.length);
    const chatId = ctx.callbackQuery.message!.chat.id;

    await bot.api.editMessageText(
      chatId, messageId,
      `${raw === 'deny' ? '❌' : '✅'} ${entry.toolName} — ${raw}`,
    ).catch(() => {});

    entry.resolve(raw === 'deny' ? false : (raw as ConsentDecision));
  });
}

export async function requestConsentViaTelegram(
  bot: Bot,
  chatId: number,
  req: ConsentRequest,
  timeoutMs: number = DEFAULT_CONSENT_TIMEOUT_MS,
): Promise<ConsentDecision | false> {
  const argsStr = JSON.stringify(req.args, null, 2).slice(0, 300);
  const text = `🔐 Permission request\n\nTool: ${req.toolName}\n\nArgs:\n${argsStr}`;

  const keyboard = new InlineKeyboard()
    .text('✅ Allow once',     'consent:allow-once')
    .text('🔁 Always allow',  'consent:always-tool')
    .row()
    .text('🔢 Always binary', 'consent:always-binary')
    .text('❌ Deny',          'consent:deny');

  const msg = await bot.api.sendMessage(chatId, text, {
    reply_markup: keyboard,
  });

  return new Promise<ConsentDecision | false>((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(msg.message_id);
      bot.api.editMessageText(chatId, msg.message_id, '⏱️ Consent timed out — denied.').catch(() => {});
      resolve(false);
    }, timeoutMs);

    pending.set(msg.message_id, { resolve, toolName: req.toolName, timeout });
  });
}
