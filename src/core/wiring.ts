import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from '../config.js';
import { DEFAULT_AGENT_NAME, type EngageMode } from './agents.js';

export interface Wiring {
  channelType:    string;
  /** Platform identifier; '*' matches all. */
  platformId:     string;
  /** Optional thread filter; '*' or omitted matches all. */
  threadId?:      string;
  agentName:      string;
  engageMode?:    EngageMode;
  engagePattern?: string;
  /** Higher = matched first. */
  priority?:      number;
}

const WIRING_FILE = path.join(CONFIG_DIR, 'wiring.json');

let cache: Wiring[] | null = null;

function readFromDisk(): Wiring[] {
  if (!fs.existsSync(WIRING_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(WIRING_FILE, 'utf-8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.wirings)) return raw.wirings;
    return [];
  } catch {
    return [];
  }
}

export function loadWirings(force = false): Wiring[] {
  if (force || !cache) cache = readFromDisk();
  return cache!;
}

export function saveWirings(rows: Wiring[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(WIRING_FILE, JSON.stringify(rows, null, 2), { mode: 0o600 });
  cache = rows;
}

export function addWiring(w: Wiring): void {
  const rows = loadWirings();
  rows.push(w);
  saveWirings(rows);
}

export function removeWiring(predicate: (w: Wiring) => boolean): number {
  const rows = loadWirings();
  const next = rows.filter(w => !predicate(w));
  const removed = rows.length - next.length;
  if (removed > 0) saveWirings(next);
  return removed;
}

export function resolveWiring(
  channelType: string,
  platformId:  string,
  threadId:    string | null,
): Wiring | undefined {
  const rows = loadWirings();
  return rows
    .filter(w => w.channelType === channelType)
    .filter(w => w.platformId === platformId || w.platformId === '*')
    .filter(w => !w.threadId || w.threadId === '*' || w.threadId === threadId)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
}

/** Synthetic fallback when no explicit wiring matches. Routes to the default agent in pattern-all mode. */
export function fallbackWiring(channelType: string, platformId: string): Wiring {
  return {
    channelType,
    platformId,
    agentName:     DEFAULT_AGENT_NAME,
    engageMode:    'pattern',
    engagePattern: '.',
  };
}
