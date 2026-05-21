import * as fs from 'fs';
import * as path from 'path';

const HOME      = process.env.HOME || '/tmp';
const DEBUG_DIR = path.join(HOME, '.agentnexus');
const DEBUG_LOG = path.join(DEBUG_DIR, 'debug.log');

let inited = false;
function ensureDir(): void {
  if (inited) return;
  try { fs.mkdirSync(DEBUG_DIR, { recursive: true, mode: 0o700 }); } catch {}
  inited = true;
}

export function dbg(tag: string, data?: unknown): void {
  ensureDir();
  const ts  = new Date().toISOString();
  const pid = process.pid;
  let line  = `[${ts}] pid=${pid} ${tag}`;
  if (data !== undefined) {
    try { line += ' ' + (typeof data === 'string' ? data : JSON.stringify(data)); }
    catch { line += ' [unserializable]'; }
  }
  try { fs.appendFileSync(DEBUG_LOG, line + '\n'); } catch {}
}

export function dbgErr(tag: string, err: unknown): void {
  const e: any = err as any;
  const msg    = e?.message ?? String(err);
  const stack  = e?.stack    ?? '';
  dbg(tag, { msg, stack });
}

export function dbgPath(): string { return DEBUG_LOG; }
