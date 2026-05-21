import { Bot, InlineKeyboard } from 'grammy';
import { randomUUID } from 'crypto';
import type { ConfigManager } from '../config.js';
import { AUTO_MODEL } from '../config.js';
import { ProviderFactory } from '../providers.js';
import { LmStudioApi, matchLmsModel } from '../lib/lmstudio-api.js';
import { dbg, dbgErr } from '../lib/debug.js';

export interface PickerEntry {
  kind: 'auto' | 'model' | 'live' | 'empty' | 'offline';
  providerName: string;
  modelId?: string;
  label: string;
  active?: boolean;
  loaded?: boolean;  // lmstudio only
}

interface PickerSession {
  chatId:    number;
  entries:   PickerEntry[];
  page:      number;
  messageId: number;
  loading:   boolean;
  expiresAt: number;
}

const LOCAL_LIVE_TYPES = new Set(['ollama', 'lmstudio']);
const SESSION_TTL_MS   = 10 * 60 * 1000;
const PAGE_SIZE        = 6;

const sessions = new Map<string, PickerSession>();

function gcSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(id);
  }
}

function totalPages(entries: PickerEntry[]): number {
  return Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
}

function entryPrefix(e: PickerEntry): string {
  if (e.active)            return '▸ ';
  if (e.loaded === true)   return '● ';
  return '  ';
}

function renderText(s: PickerSession): string {
  const pages   = totalPages(s.entries);
  const page    = Math.min(s.page, pages - 1);
  const start   = page * PAGE_SIZE;
  const slice   = s.entries.slice(start, start + PAGE_SIZE);
  const header  = `🤖 Pick a model (page ${page + 1}/${pages})${s.loading ? ' (loading live...)' : ''}`;
  if (!s.entries.length) {
    return `${header}\n\nNo providers configured.`;
  }
  const lines = slice.map((e, i) => `${start + i + 1}. ${entryPrefix(e)}${e.label}`);
  return `${header}\n\n${lines.join('\n')}`;
}

function renderKeyboard(s: PickerSession, sessionId: string): InlineKeyboard {
  const pages = totalPages(s.entries);
  const page  = Math.min(s.page, pages - 1);
  const start = page * PAGE_SIZE;
  const slice = s.entries.slice(start, start + PAGE_SIZE);

  const kb = new InlineKeyboard();
  // Number buttons in rows of 3
  for (let i = 0; i < slice.length; i++) {
    const globalIdx = start + i;
    kb.text(String(globalIdx + 1), `model:${sessionId}:${globalIdx}`);
    if ((i + 1) % 3 === 0 || i === slice.length - 1) kb.row();
  }
  // Nav row
  if (page > 0)          kb.text('◀ Prev', `model:${sessionId}:nav:prev`);
  kb.text('✕ Cancel',    `model:${sessionId}:nav:cancel`);
  if (page < pages - 1)  kb.text('Next ▶', `model:${sessionId}:nav:next`);
  return kb;
}

function buildInitialEntries(config: ConfigManager): PickerEntry[] {
  const cfg = config.getConfig();
  const entries: PickerEntry[] = [];

  for (const prov of cfg.providers) {
    const isLocal = LOCAL_LIVE_TYPES.has(prov.type) || (prov.type === 'custom' && prov.listModels);
    if (!isLocal) continue;
    const isActive = cfg.activeProvider === prov.name && cfg.activeModel === AUTO_MODEL;
    entries.push({
      kind:         'auto',
      providerName: prov.name,
      label:        `auto — currently loaded (${prov.name})`,
      active:       isActive,
    });
  }

  for (const m of cfg.models) {
    if (m.id === AUTO_MODEL) continue;
    const isActive = cfg.activeModel === m.id && cfg.activeProvider === m.provider;
    entries.push({
      kind:         'model',
      providerName: m.provider,
      modelId:      m.id,
      label:        `${m.name} [${m.provider}]`,
      active:       isActive,
    });
  }

  return entries;
}

async function fetchLive(config: ConfigManager): Promise<{ provider: string; entries: PickerEntry[] }[]> {
  const cfg = config.getConfig();
  const locals = cfg.providers.filter(p =>
    LOCAL_LIVE_TYPES.has(p.type) || (p.type === 'custom' && p.listModels),
  );

  return Promise.all(locals.map(async prov => {
    const isActive = cfg.activeProvider === prov.name;
    try {
      let liveEntries: PickerEntry[] = [];
      if (prov.type === 'lmstudio') {
        const api = new LmStudioApi(prov.endpoint, prov.apiKey);
        const models = await api.listModels();
        liveEntries = models.map(m => ({
          kind:         'live' as const,
          providerName: prov.name,
          modelId:      m.id,
          label:        `${m.display_name || m.id} [${prov.name}]`,
          active:       isActive && cfg.activeModel === m.id,
          loaded:       m.state === 'loaded',
        }));
      } else {
        const tempProv = ProviderFactory.create(prov.type, {
          endpoint: prov.endpoint,
          model:    '_',
          apiKey:   prov.apiKey,
        });
        const ids = await tempProv.listModels();
        liveEntries = ids.map(id => ({
          kind:         'live' as const,
          providerName: prov.name,
          modelId:      id,
          label:        `${id} [${prov.name}]`,
          active:       isActive && cfg.activeModel === id,
        }));
      }
      if (!liveEntries.length) {
        return {
          provider: prov.name,
          entries: [{
            kind:         'empty' as const,
            providerName: prov.name,
            label:        `${prov.name}: no downloaded models`,
          }],
        };
      }
      return { provider: prov.name, entries: liveEntries };
    } catch (e: any) {
      dbgErr('modelPicker.live.fail', { provider: prov.name, msg: e?.message });
      return {
        provider: prov.name,
        entries: [{
          kind:         'offline' as const,
          providerName: prov.name,
          label:        `${prov.name}: offline`,
        }],
      };
    }
  }));
}

function mergeLive(base: PickerEntry[], live: { provider: string; entries: PickerEntry[] }[]): PickerEntry[] {
  // Drop placeholder live/empty/offline rows for these providers from base, then append fresh.
  const providers = new Set(live.map(l => l.provider));
  const kept = base.filter(e => {
    if (providers.has(e.providerName) &&
        (e.kind === 'live' || e.kind === 'empty' || e.kind === 'offline')) {
      return false;
    }
    return true;
  });
  const extra = live.flatMap(l => l.entries);
  return [...kept, ...extra];
}

export async function openModelPicker(
  bot: Bot,
  chatId: number,
  config: ConfigManager,
): Promise<void> {
  gcSessions();

  const sessionId = randomUUID();
  const entries   = buildInitialEntries(config);

  const session: PickerSession = {
    chatId,
    entries,
    page:      0,
    messageId: 0,
    loading:   true,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  const msg = await bot.api.sendMessage(chatId, renderText(session), {
    reply_markup: renderKeyboard(session, sessionId),
  }).catch((e) => { dbgErr('modelPicker.send', e); return null; });

  if (!msg) return;
  session.messageId = msg.message_id;
  sessions.set(sessionId, session);

  // Kick off live fetch in background
  void fetchLive(config).then(async (live) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.entries = mergeLive(s.entries, live);
    s.loading = false;
    s.expiresAt = Date.now() + SESSION_TTL_MS;
    await bot.api.editMessageText(s.chatId, s.messageId, renderText(s), {
      reply_markup: renderKeyboard(s, sessionId),
    }).catch((e) => dbgErr('modelPicker.editLive', e));
  }).catch((e) => dbgErr('modelPicker.fetchLive', e));
}

async function handleSelection(
  bot: Bot,
  config: ConfigManager,
  sessionId: string,
  s: PickerSession,
  entry: PickerEntry,
): Promise<void> {
  const cfg = config.getConfig();

  if (entry.kind === 'empty' || entry.kind === 'offline') {
    return;
  }

  if (entry.kind === 'auto') {
    const prov = cfg.providers.find(p => p.name === entry.providerName);
    if (!prov) {
      await bot.api.editMessageText(s.chatId, s.messageId, '❌ Provider not found').catch(() => {});
      sessions.delete(sessionId);
      return;
    }
    config.setActiveProvider(prov.name);
    config.setActiveModel(AUTO_MODEL);
    await bot.api.editMessageText(s.chatId, s.messageId, `✅ Switched to ${entry.label}`).catch(() => {});
    sessions.delete(sessionId);
    return;
  }

  if (entry.kind === 'live') {
    const prov = cfg.providers.find(p => p.name === entry.providerName);
    if (!prov) {
      await bot.api.editMessageText(s.chatId, s.messageId, '❌ Provider not found').catch(() => {});
      sessions.delete(sessionId);
      return;
    }
    const modelId = entry.modelId!;

    if (prov.type === 'lmstudio' && entry.loaded === false) {
      const lms = new LmStudioApi(prov.endpoint, prov.apiKey);
      let all;
      try {
        all = await lms.listModels();
      } catch (e: any) {
        await bot.api.editMessageText(s.chatId, s.messageId, `❌ LM Studio unreachable: ${e.message}`).catch(() => {});
        sessions.delete(sessionId);
        return;
      }
      const target = all.find(m => matchLmsModel(modelId, m));
      if (!target) {
        await bot.api.editMessageText(s.chatId, s.messageId, `❌ Model '${modelId}' not found in LM Studio`).catch(() => {});
        sessions.delete(sessionId);
        return;
      }
      const autoUnload  = (cfg as any).autoUnloadOnModelSwitch !== false;
      const loadedOther = all.filter(m => m.state === 'loaded' && !matchLmsModel(modelId, m));

      if (autoUnload && loadedOther.length) {
        for (const o of loadedOther) {
          await bot.api.sendMessage(s.chatId, `Unloading ${o.id}...`).catch(() => {});
          const ur = await lms.unloadModel(o.id);
          if (!ur.ok) {
            dbg('modelPicker.unload.warn', { model: o.id, detail: ur.detail });
          }
        }
      }

      await bot.api.sendMessage(s.chatId, `Loading ${target.id}...`).catch(() => {});
      const lr = await lms.loadModel(target.id);
      if (!lr.ok) {
        await bot.api.editMessageText(s.chatId, s.messageId, `❌ Load failed: ${lr.detail}`).catch(() => {});
        sessions.delete(sessionId);
        return;
      }
    }

    config.setActiveProvider(prov.name);
    config.setActiveModel(modelId);
    await bot.api.editMessageText(s.chatId, s.messageId, `✅ Switched to ${entry.label}`).catch(() => {});
    sessions.delete(sessionId);
    return;
  }

  // 'model'
  const sel = cfg.models.find(m => m.id === entry.modelId && m.provider === entry.providerName);
  if (!sel) {
    await bot.api.editMessageText(s.chatId, s.messageId, '❌ Model not found in config').catch(() => {});
    sessions.delete(sessionId);
    return;
  }
  config.setActiveModelById(sel.id, sel.provider);
  await bot.api.editMessageText(s.chatId, s.messageId, `✅ Switched to ${sel.name}`).catch(() => {});
  sessions.delete(sessionId);
}

export function installModelPickerHandler(bot: Bot, config: ConfigManager): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data?.startsWith('model:')) return;

    await ctx.answerCallbackQuery().catch(() => {});

    const parts = data.split(':');
    // model:<sessionId>:<idx | "nav">[:dir]
    if (parts.length < 3) return;
    const sessionId = parts[1];
    const s = sessions.get(sessionId);
    if (!s) {
      const msgId = ctx.callbackQuery.message?.message_id;
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (msgId && chatId) {
        await bot.api.editMessageText(chatId, msgId, '⏱️ Picker expired. Use /models to reopen.').catch(() => {});
      }
      return;
    }

    if (parts[2] === 'nav') {
      const dir = parts[3];
      if (dir === 'cancel') {
        sessions.delete(sessionId);
        await bot.api.editMessageText(s.chatId, s.messageId, '✕ Picker cancelled').catch(() => {});
        return;
      }
      const pages = totalPages(s.entries);
      if (dir === 'prev' && s.page > 0)          s.page--;
      if (dir === 'next' && s.page < pages - 1)  s.page++;
      s.expiresAt = Date.now() + SESSION_TTL_MS;
      await bot.api.editMessageText(s.chatId, s.messageId, renderText(s), {
        reply_markup: renderKeyboard(s, sessionId),
      }).catch((e) => dbgErr('modelPicker.editNav', e));
      return;
    }

    const idx = parseInt(parts[2], 10);
    if (isNaN(idx) || idx < 0 || idx >= s.entries.length) return;
    const entry = s.entries[idx];
    try {
      await handleSelection(bot, config, sessionId, s, entry);
    } catch (e: any) {
      dbgErr('modelPicker.select', e);
      await bot.api.editMessageText(s.chatId, s.messageId, `❌ Selection failed: ${e?.message ?? e}`).catch(() => {});
      sessions.delete(sessionId);
    }
  });
}
