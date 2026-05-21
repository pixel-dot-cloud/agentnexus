import { Bot } from 'grammy';
import type { ConfigManager } from '../config.js';
import type { ChatState } from './bot.js';
import type { PermissionMode } from '../lib/permission-modes.js';
import { AUTO_MODEL } from '../config.js';
import { openModelPicker } from './model-picker.js';

const LOCAL_PROVIDER_TYPES = new Set(['ollama', 'lmstudio', 'custom']);

function maskKey(k: string): string {
  if (k.length > 12) return `${k.slice(0, 4)}***${k.slice(-4)}`;
  return '***';
}

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
      '/model — switch model by number\n' +
      '/models — interactive model picker\n' +
      '/providers — list providers\n' +
      '/provider <n> — switch active provider\n' +
      '/apikey <name> <key|clear> — set provider API key\n' +
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
      '/model <number> — switch LLM model by index\n' +
      '/models — interactive picker (configured + live-detected)\n' +
      '/providers — list configured providers\n' +
      '/provider <number> — switch active provider\n' +
      '/apikey <providerName> <key|clear> — set or clear a provider API key\n' +
      '  ⚠ Anyone with access to this chat can read the key. Delete the message after.\n' +
      '/mode <default|plan|accept|bypass> — permission mode\n' +
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
    const modeMap: Record<string, PermissionMode> = {
      'default':      'default',
      'plan':         'plan',
      'accept':       'acceptEdits',
      'accept-edits': 'acceptEdits',
      'bypass':       'bypassPermissions',
    };
    if (!args || !(args in modeMap)) {
      await ctx.reply('Usage: /mode <default|plan|accept|bypass>');
      return;
    }
    const mode: PermissionMode = modeMap[args];
    const state = chats.get(chatId);
    if (state) {
      state.permMode = mode;
    }
    await ctx.reply(`Mode: ${args}`);
  });

  bot.command('abort', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chats.get(chatId);
    // D2: only signal abort. The message handler's finally block clears
    // isRunning and abortCtrl once the loop actually unwinds — clearing
    // them here races with a still-draining run and corrupts state.history.
    if (state?.abortCtrl) {
      state.abortCtrl.abort();
      await ctx.reply('Aborting...');
    } else {
      await ctx.reply('Nothing running.');
    }
  });

  bot.command('models', async (ctx) => {
    await openModelPicker(bot, ctx.chat.id, config);
  });

  bot.command('providers', async (ctx) => {
    const cfg = config.getConfig();
    if (!cfg.providers.length) {
      await ctx.reply('No providers configured.\nEdit ~/.agentnexus/config.json');
      return;
    }
    const lines = cfg.providers.map((p, i) => {
      const marker = p.name === cfg.activeProvider ? '  <- active' : '';
      return `${i + 1}. ${p.name} (${p.type})${marker}`;
    });
    await ctx.reply(`Providers:\n${lines.join('\n')}\n\nUse /provider <number> to switch.`);
  });

  bot.command('provider', async (ctx) => {
    const args = ctx.match?.trim();
    const cfg = config.getConfig();
    if (!args) {
      await ctx.reply('Usage: /provider <number> — use /providers to list');
      return;
    }
    const idx = parseInt(args, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= cfg.providers.length) {
      await ctx.reply('Usage: /provider <number> — use /providers to list');
      return;
    }
    const prov = cfg.providers[idx];
    config.setActiveProvider(prov.name);

    // Re-target active model: keep current if it belongs, else pick first matching, else AUTO for local
    const activeModelId = cfg.activeModel;
    const currentBelongs = cfg.models.some(m => m.id === activeModelId && m.provider === prov.name);
    if (!currentBelongs) {
      const firstForProv = cfg.models.find(m => m.provider === prov.name && m.id !== AUTO_MODEL);
      if (firstForProv) {
        config.setActiveModel(firstForProv.id);
      } else if (LOCAL_PROVIDER_TYPES.has(prov.type)) {
        config.setActiveModel(AUTO_MODEL);
      }
    }

    await ctx.reply(`Switched provider to ${prov.name} (${prov.type})`);
  });

  bot.command('removeprovider', async (ctx) => {
    const args = ctx.match?.trim();
    const cfg = config.getConfig();
    if (!args) {
      await ctx.reply('Usage: /removeprovider <number|name> — use /providers to list');
      return;
    }
    let prov: { name: string; type: string } | undefined;
    const idx = parseInt(args, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < cfg.providers.length) {
      prov = cfg.providers[idx];
    } else {
      prov = cfg.providers.find(p => p.name === args);
    }
    if (!prov) {
      await ctx.reply(`Provider not found: ${args}. Use /providers to list.`);
      return;
    }
    const removed = config.removeProvider(prov.name);
    if (!removed) {
      await ctx.reply(`Failed to remove ${prov.name}.`);
      return;
    }
    const newActive = config.getConfig().activeProvider || '(none)';
    await ctx.reply(`Removed ${prov.name}. Active provider: ${newActive}`);
  });

  bot.command('apikey', async (ctx) => {
    const raw = ctx.match?.trim() ?? '';
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      await ctx.reply(
        'Usage: /apikey <providerName> <key|clear>\n' +
        '⚠ Anyone with access to this chat can read the key. Delete the message after.',
      );
      return;
    }
    const [name, ...rest] = parts;
    const value = rest.join(' ');
    const prov = config.getProviderByName(name);
    if (!prov) {
      await ctx.reply(`Provider not found: ${name}. Use /providers to list.`);
      return;
    }
    if (value === 'clear') {
      config.setProviderApiKey(name, undefined);
      await ctx.reply(`Cleared apiKey for ${name}`);
      return;
    }
    config.setProviderApiKey(name, value);
    await ctx.reply(`Set apiKey for ${name}: ${maskKey(value)}`);
  });
}
