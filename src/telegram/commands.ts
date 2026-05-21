import { Bot } from 'grammy';
import type { ConfigManager } from '../config.js';
import type { ChatState } from './bot.js';

export function registerCommands(
  bot: Bot,
  chats: Map<number, ChatState>,
  config: ConfigManager,
): void {

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Nexus online.\n\n' +
      'Send me a message and I\'ll execute it.\n\n' +
      'Commands:\n' +
      '/clear — reset conversation\n' +
      '/model — switch model\n' +
      '/mode — change permission mode\n' +
      '/status — show status\n' +
      '/abort — cancel running task\n' +
      '/help — this message',
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Commands:\n\n' +
      '/start — greeting\n' +
      '/clear — reset conversation history\n' +
      '/model <number> — switch LLM model\n' +
      '/mode <default|plan|bypass> — permission mode\n' +
      '/status — current model, mode\n' +
      '/abort — cancel running task\n' +
      '/help — this message',
    );
  });

  bot.command('clear', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chats.get(chatId);
    if (state) {
      state.history = [];
    }
    await ctx.reply('Conversation cleared.');
  });

  bot.command('status', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chats.get(chatId);
    const cfg = config.getConfig();
    const model = config.getActiveModel();
    const mode = state?.permMode ?? 'default';
    await ctx.reply(
      `Status\n\nModel: ${model?.name ?? 'none'}\nProvider: ${cfg.activeProvider}\nMode: ${mode}\nRunning: ${state?.isRunning ? 'yes' : 'no'}`,
    );
  });

  bot.command('model', async (ctx) => {
    const args = ctx.match?.trim();
    const cfg = config.getConfig();
    if (!args) {
      const list = cfg.models.map((m, i) =>
        `${i + 1}. ${m.name} [${m.provider}]${m.id === cfg.activeModel ? ' <- active' : ''}`
      ).join('\n');
      await ctx.reply(list || 'No models configured.\nEdit ~/.agentnexus/config.json');
      return;
    }
    const idx = parseInt(args) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < cfg.models.length) {
      const sel = cfg.models[idx];
      config.setActiveModelById(sel.id, sel.provider);
      await ctx.reply(`Switched to ${sel.name}`);
    } else {
      await ctx.reply('Usage: /model <number> — use /model to list');
    }
  });

  bot.command('mode', async (ctx) => {
    const chatId = ctx.chat.id;
    const args = ctx.match?.trim();
    if (!args || !['default', 'plan', 'bypass'].includes(args)) {
      await ctx.reply('Usage: /mode <default|plan|bypass>');
      return;
    }
    const state = chats.get(chatId);
    if (state) {
      state.permMode = args === 'bypass' ? 'bypassPermissions' : args as any;
    }
    await ctx.reply(`Mode: ${args}`);
  });

  bot.command('abort', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chats.get(chatId);
    if (state?.abortCtrl) {
      state.abortCtrl.abort();
      state.abortCtrl = undefined;
      state.isRunning = false;
      await ctx.reply('Task aborted.');
    } else {
      await ctx.reply('Nothing running.');
    }
  });
}
