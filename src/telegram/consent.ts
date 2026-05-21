import { Bot, InlineKeyboard } from 'grammy';
import type { ConsentRequest, ConsentDecision } from '../lib/consent.js';

const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

export async function requestConsentViaTelegram(
  bot: Bot,
  chatId: number,
  req: ConsentRequest,
): Promise<ConsentDecision | false> {
  const argsStr = JSON.stringify(req.args, null, 2).slice(0, 300);
  const text = `🔐 Permission request\n\nTool: \`${req.toolName}\`\n\`\`\`\n${argsStr}\n\`\`\``;

  const keyboard = new InlineKeyboard()
    .text('✅ Allow once',     'consent:allow-once')
    .text('🔁 Always allow',  'consent:always-tool')
    .row()
    .text('🔢 Always binary', 'consent:always-binary')
    .text('❌ Deny',          'consent:deny');

  const msg = await bot.api.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });

  return new Promise<ConsentDecision | false>((resolve) => {
    const timeout = setTimeout(() => {
      bot.api.editMessageText(chatId, msg.message_id, '⏱️ Consent timed out — denied.').catch(() => {});
      resolve(false);
    }, CONSENT_TIMEOUT_MS);

    const removeHandler = bot.on('callback_query:data', async (ctx) => {
      if (!ctx.callbackQuery.data?.startsWith('consent:')) return;
      if (ctx.callbackQuery.message?.message_id !== msg.message_id) return;

      clearTimeout(timeout);
      await ctx.answerCallbackQuery().catch(() => {});

      const raw = ctx.callbackQuery.data.slice('consent:'.length);
      const decision = raw as ConsentDecision;

      await bot.api.editMessageText(
        chatId, msg.message_id,
        `${raw === 'deny' ? '❌' : '✅'} ${req.toolName} — ${raw}`,
      ).catch(() => {});

      resolve(raw === 'deny' ? false : decision);
    });
  });
}
