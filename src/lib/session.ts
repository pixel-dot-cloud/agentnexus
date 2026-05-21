import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from '../providers.js';

const SESSIONS_DIR  = path.join(process.env.HOME || '', '.agentnexus', 'sessions');
const ARCHIVE_DIR   = path.join(SESSIONS_DIR, 'archive');
const SAVES_DIR     = path.join(process.env.HOME || '', '.agentnexus', 'chats');
const SESSIONS_KEEP = 200;

export type Message = ChatMessage;

export interface Session {
  id: string;
  createdAt: string;
  model: string;
  provider: string;
  summary?: string;
  history: ChatMessage[];
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  model: string;
  provider: string;
  summary?: string;
  firstUser?: string;
  messageCount: number;
}

export function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function writePrivate(filepath: string, data: string): void {
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, filepath);
}

export function saveSession(session: Session): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  writePrivate(
    path.join(SESSIONS_DIR, `${session.id}.json`),
    JSON.stringify(session, null, 2),
  );
  pruneSessions();
}

export function loadSession(id: string): Session | null {
  const p = path.join(SESSIONS_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function listSessions(): SessionMeta[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const out: SessionMeta[] = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')) as Session;
      const rawFirst = s.history.find(m => m.role === 'user')?.content;
      const firstUser =
        typeof rawFirst === 'string' ? rawFirst.slice(0, 80) :
        Array.isArray(rawFirst)      ? JSON.stringify(rawFirst).slice(0, 80) :
        undefined;
      out.push({
        id: s.id,
        createdAt: s.createdAt,
        model: s.model,
        provider: s.provider,
        summary: s.summary,
        firstUser,
        messageCount: s.history.length,
      });
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneSessions(): void {
  try {
    const all = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ f, mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (all.length <= SESSIONS_KEEP) return;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
    for (const { f } of all.slice(SESSIONS_KEEP)) {
      try { fs.renameSync(path.join(SESSIONS_DIR, f), path.join(ARCHIVE_DIR, f)); } catch {}
    }
  } catch {}
}

export function saveChatMarkdown(messages: ChatMessage[], name?: string): string {
  fs.mkdirSync(SAVES_DIR, { recursive: true, mode: 0o700 });
  const raw = name || `chat-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const safeName = path.basename(raw).replace(/\.md$/i, '') || `chat-${Date.now()}`;
  const filepath = path.join(SAVES_DIR, `${safeName}.md`);
  const lines = messages
    .filter(m => m.role !== 'system' && m.role !== 'tool')
    .map(m => `**${m.role}**\n\n${m.content}`)
    .join('\n\n---\n\n');
  writePrivate(filepath, lines);
  return filepath;
}
