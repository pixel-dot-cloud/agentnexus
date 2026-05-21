import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCwd } from './cwd.js';

export type HookEvent = 'SessionStart' | `PreToolUse:${string}` | `PostToolUse:${string}`;

export interface HookEntry {
  command: string;
  args?: string[];
}

export type HookConfig = Record<string, HookEntry[]>;

const HOOK_TIMEOUT_MS = 10_000;

export class HookManager {
  constructor(private hooks: HookConfig = {}) {}

  run(event: HookEvent, ctx: Record<string, string> = {}): void {
    const entries = this.hooks[event] ?? [];
    if (!entries.length) return;

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    for (const [k, v] of Object.entries(ctx)) {
      env[`AN_${k.toUpperCase()}`] = v;
    }

    for (const h of entries) {
      if (!h.command) continue;
      try {
        execFileSync(h.command, h.args ?? [], {
          stdio: 'inherit',
          cwd: getCwd(),
          env,
          timeout: HOOK_TIMEOUT_MS,
        });
      } catch {
        process.stderr.write(`[hook] ${event} failed: ${h.command}\n`);
      }
    }
  }
}

function normalize(raw: unknown): HookConfig {
  const out: HookConfig = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [event, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const entries: HookEntry[] = [];
    for (const item of list) {
      if (typeof item === 'string') {
        if (/\{\{\w+\}\}/.test(item)) {
          process.stderr.write(
            `[hooks] dropped legacy "${event}" hook with {{interpolation}} — use {command,args} + $AN_* env vars\n`,
          );
          continue;
        }
        const parts = item.split(/\s+/).filter(Boolean);
        if (!parts.length) continue;
        const [command, ...args] = parts;
        entries.push({ command, args });
      } else if (
        item &&
        typeof item === 'object' &&
        typeof (item as any).command === 'string'
      ) {
        const e = item as HookEntry;
        entries.push({ command: e.command, args: Array.isArray(e.args) ? e.args : [] });
      }
    }
    if (entries.length) out[event] = entries;
  }
  return out;
}

export function loadHooksConfig(): HookConfig {
  const configs: HookConfig[] = [];

  const globalPath = path.join(process.env.HOME || '', '.agentnexus', 'hooks.json');
  if (fs.existsSync(globalPath)) {
    try { configs.push(normalize(JSON.parse(fs.readFileSync(globalPath, 'utf-8')))); } catch {}
  }

  const localPath = path.join(getCwd(), 'agentnexus.hooks.json');
  if (fs.existsSync(localPath)) {
    try { configs.push(normalize(JSON.parse(fs.readFileSync(localPath, 'utf-8')))); } catch {}
  }

  return configs.reduce((merged, cfg) => {
    for (const [k, v] of Object.entries(cfg)) {
      merged[k] = [...(merged[k] ?? []), ...v];
    }
    return merged;
  }, {} as HookConfig);
}
