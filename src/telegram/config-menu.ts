import { Bot, InlineKeyboard } from 'grammy';
import type { ConfigManager } from '../config.js';
import { buildRoot, type MenuNode, type MenuCtx, type ListNode, type MenuResult } from '../lib/menu-tree.js';
import { dbg, dbgErr } from '../lib/debug.js';

// ── Session state ────────────────────────────────────────────────────────────
interface MenuSession {
  chatId:      number;
  sessionId:   string;
  messageId:   number;
  stack:       string[];               // path of node ids from root (root excluded)
  awaiting?: {                          // text-input handoff
    nodeId:    string;
    expiresAt: number;
  };
  expiresAt:   number;
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const INPUT_TTL_MS   = 2  * 60 * 1000;

const sessions      = new Map<string, MenuSession>();   // sessionId → session
const chatToSession = new Map<number, string>();         // chatId → active sessionId

function newSessionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function gcExpired(): void {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.expiresAt < now) {
      sessions.delete(sid);
      if (chatToSession.get(s.chatId) === sid) chatToSession.delete(s.chatId);
    }
  }
}

// ── Tree walking ─────────────────────────────────────────────────────────────
function resolveStack(root: ListNode, stack: string[], ctx: MenuCtx): MenuNode {
  let cur: MenuNode = root;
  for (const id of stack) {
    if (cur.kind !== 'list') return cur;
    const next: MenuNode | undefined = cur.children(ctx).find((c) => c.id === id);
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

function flatId(stack: string[]): string {
  return stack.join('/');
}

// ── Rendering ────────────────────────────────────────────────────────────────
const PAGE_SIZE = 8;

function renderList(node: ListNode, ctx: MenuCtx, sessionId: string): { text: string; keyboard: InlineKeyboard } {
  const children = node.children(ctx);
  const text = `⚙️ ${node.label}\n\nPick an option:`;
  const kb = new InlineKeyboard();
  children.slice(0, PAGE_SIZE).forEach((c, i) => {
    kb.text(`${i + 1}. ${c.label}`, `cfg:${sessionId}:enter:${i}`).row();
  });
  kb.text('◀ Back', `cfg:${sessionId}:back`).text('✕ Close', `cfg:${sessionId}:close`);
  return { text, keyboard: kb };
}

function renderChoice(node: Extract<MenuNode, { kind: 'choice' }>, ctx: MenuCtx, sessionId: string): { text: string; keyboard: InlineKeyboard } {
  const cur = node.current(ctx);
  const text = `⚙️ ${node.label}\n\nCurrent: ${cur}\nPick a value:`;
  const kb = new InlineKeyboard();
  node.options.forEach((o, i) => {
    const marker = o.value === cur ? '▸ ' : '';
    kb.text(`${marker}${o.label}`, `cfg:${sessionId}:choose:${i}`).row();
  });
  kb.text('◀ Back', `cfg:${sessionId}:back`).text('✕ Close', `cfg:${sessionId}:close`);
  return { text, keyboard: kb };
}

function renderToggle(node: Extract<MenuNode, { kind: 'toggle' }>, ctx: MenuCtx, sessionId: string): { text: string; keyboard: InlineKeyboard } {
  const cur = node.current(ctx);
  const text = `⚙️ ${node.label}\n\nCurrent: ${cur ? 'on' : 'off'}\nToggle?`;
  const kb = new InlineKeyboard()
    .text('Toggle', `cfg:${sessionId}:toggle`).row()
    .text('◀ Back', `cfg:${sessionId}:back`).text('✕ Close', `cfg:${sessionId}:close`);
  return { text, keyboard: kb };
}

function renderConfirm(node: Extract<MenuNode, { kind: 'confirm' }>, sessionId: string): { text: string; keyboard: InlineKeyboard } {
  const text = `⚠️ ${node.prompt}`;
  const kb = new InlineKeyboard()
    .text('Yes', `cfg:${sessionId}:confirm-yes`)
    .text('No',  `cfg:${sessionId}:back`).row()
    .text('✕ Close', `cfg:${sessionId}:close`);
  return { text, keyboard: kb };
}

function renderInputPrompt(node: Extract<MenuNode, { kind: 'input' }>, sessionId: string): { text: string; keyboard: InlineKeyboard } {
  const sens = node.sensitive
    ? '\n\n⚠ This value is sensitive. Delete the message after sending.'
    : '';
  const text = `📝 ${node.prompt}\n\nSend your value in the next message. /cancel to abort.${sens}`;
  const kb = new InlineKeyboard()
    .text('✕ Cancel', `cfg:${sessionId}:cancel-input`);
  return { text, keyboard: kb };
}

async function renderAndEdit(bot: Bot, session: MenuSession, config: ConfigManager): Promise<void> {
  const ctx: MenuCtx = { config };
  const root = buildRoot(config);
  const node = resolveStack(root, session.stack, ctx);
  let payload: { text: string; keyboard: InlineKeyboard };
  switch (node.kind) {
    case 'list':    payload = renderList(node, ctx, session.sessionId);    break;
    case 'choice':  payload = renderChoice(node, ctx, session.sessionId);  break;
    case 'toggle':  payload = renderToggle(node, ctx, session.sessionId);  break;
    case 'confirm': payload = renderConfirm(node, session.sessionId);      break;
    case 'input':   payload = renderInputPrompt(node, session.sessionId);  break;
    case 'action': {
      // Run immediately, then return to parent
      try {
        const result = await node.run(ctx);
        await applyResult(bot, session, result, config);
      } catch (e: any) {
        dbgErr('cfg-menu.action.threw', e);
        await applyResult(bot, session, { kind: 'message', text: `Error: ${e.message}` }, config);
      }
      return;
    }
  }
  try {
    await bot.api.editMessageText(session.chatId, session.messageId, payload.text, {
      reply_markup: payload.keyboard,
    });
  } catch (e: any) {
    // If the message can't be edited (deleted, etc.), resend.
    dbg('cfg-menu.edit.failed', { reason: e.message });
    const msg = await bot.api.sendMessage(session.chatId, payload.text, {
      reply_markup: payload.keyboard,
    });
    session.messageId = msg.message_id;
  }
}

async function applyResult(bot: Bot, session: MenuSession, result: MenuResult, config: ConfigManager): Promise<void> {
  switch (result.kind) {
    case 'back':
      session.stack.pop();
      await renderAndEdit(bot, session, config);
      return;
    case 'reopen':
      await renderAndEdit(bot, session, config);
      return;
    case 'stay':
      await renderAndEdit(bot, session, config);
      return;
    case 'message':
      // Show toast-style line above re-rendered parent
      try {
        await bot.api.sendMessage(session.chatId, `✅ ${result.text}`);
      } catch {}
      session.stack.pop();
      await renderAndEdit(bot, session, config);
      return;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function openConfigMenu(bot: Bot, chatId: number, config: ConfigManager): Promise<void> {
  gcExpired();
  // Close prior session if any
  const prev = chatToSession.get(chatId);
  if (prev) sessions.delete(prev);

  const sessionId = newSessionId();
  const ctx: MenuCtx = { config };
  const root = buildRoot(config);
  const payload = renderList(root, ctx, sessionId);
  const msg = await bot.api.sendMessage(chatId, payload.text, { reply_markup: payload.keyboard });
  sessions.set(sessionId, {
    chatId,
    sessionId,
    messageId: msg.message_id,
    stack:     [],
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  chatToSession.set(chatId, sessionId);
}

export function installConfigMenuHandler(bot: Bot, config: ConfigManager): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data || !data.startsWith('cfg:')) return;
    await ctx.answerCallbackQuery().catch(() => {});

    const parts = data.split(':');
    const sessionId = parts[1];
    const op        = parts[2];

    const session = sessions.get(sessionId);
    if (!session) {
      await ctx.editMessageText('⏱️ Menu expired. Use /config to reopen.').catch(() => {});
      return;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    const cfg = config;
    const cfgCtx: MenuCtx = { config: cfg };
    const root = buildRoot(cfg);
    const node = resolveStack(root, session.stack, cfgCtx);

    try {
      switch (op) {
        case 'close': {
          sessions.delete(sessionId);
          chatToSession.delete(session.chatId);
          await ctx.editMessageText('Menu closed.').catch(() => {});
          return;
        }
        case 'back': {
          if (session.awaiting) session.awaiting = undefined;
          if (session.stack.length === 0) {
            sessions.delete(sessionId);
            chatToSession.delete(session.chatId);
            await ctx.editMessageText('Menu closed.').catch(() => {});
            return;
          }
          session.stack.pop();
          await renderAndEdit(bot, session, cfg);
          return;
        }
        case 'cancel-input': {
          session.awaiting = undefined;
          session.stack.pop();
          await renderAndEdit(bot, session, cfg);
          return;
        }
        case 'enter': {
          if (node.kind !== 'list') return;
          const idx = parseInt(parts[3], 10);
          const children = node.children(cfgCtx);
          const target = children[idx];
          if (!target) return;
          session.stack.push(target.id);
          if (target.kind === 'input') {
            session.awaiting = { nodeId: target.id, expiresAt: Date.now() + INPUT_TTL_MS };
          }
          await renderAndEdit(bot, session, cfg);
          return;
        }
        case 'choose': {
          if (node.kind !== 'choice') return;
          const idx = parseInt(parts[3], 10);
          const opt = node.options[idx];
          if (!opt) return;
          const result = await node.apply(cfgCtx, opt.value);
          await applyResult(bot, session, result, cfg);
          return;
        }
        case 'toggle': {
          if (node.kind !== 'toggle') return;
          const next = !node.current(cfgCtx);
          const result = await node.apply(cfgCtx, next);
          await applyResult(bot, session, result, cfg);
          return;
        }
        case 'confirm-yes': {
          if (node.kind !== 'confirm') return;
          const result = await node.run(cfgCtx);
          await applyResult(bot, session, result, cfg);
          return;
        }
      }
    } catch (e: any) {
      dbgErr('cfg-menu.handler.threw', e);
    }
  });
}

// ── Text-input routing ───────────────────────────────────────────────────────
// Called by the main message:text handler BEFORE the agent loop.
// Returns true if the message was consumed by a pending menu input.
export async function routeInputForChat(
  bot: Bot,
  chatId: number,
  text: string,
  config: ConfigManager,
): Promise<boolean> {
  gcExpired();
  const sessionId = chatToSession.get(chatId);
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session || !session.awaiting) return false;
  if (session.awaiting.expiresAt < Date.now()) {
    session.awaiting = undefined;
    return false;
  }

  if (text.trim() === '/cancel') {
    session.awaiting = undefined;
    session.stack.pop();
    await renderAndEdit(bot, session, config);
    return true;
  }

  const ctx: MenuCtx = { config };
  const root = buildRoot(config);
  const node = resolveStack(root, session.stack, ctx);
  if (node.kind !== 'input') {
    session.awaiting = undefined;
    return false;
  }

  const parsed = node.parse(text);
  if (parsed instanceof Error) {
    await bot.api.sendMessage(chatId, `Error: ${parsed.message}\nTry again or /cancel.`);
    return true;
  }
  session.awaiting = undefined;
  try {
    const result = await node.apply(ctx, parsed);
    await applyResult(bot, session, result, config);
  } catch (e: any) {
    dbgErr('cfg-menu.input.apply.threw', e);
    await bot.api.sendMessage(chatId, `Error: ${e.message}`);
  }
  return true;
}
