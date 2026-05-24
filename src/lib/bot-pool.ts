import * as fs from 'fs';
import * as path from 'path';
import type { BotInstance } from '../config.js';
import { CONFIG_DIR } from '../config.js';
import { subagentRegistry } from './subagent-registry.js';

const BOT_POOL_FILE = path.join(CONFIG_DIR, 'bot-pool.json');

export interface BotPoolEntry {
  name:    string;
  status:  'main' | 'available' | 'bound';
  boundTo?: string;        // agentId
}

class BotPool {
  private bound = new Map<string, string>();           // botName → agentId
  private lastUserChat = new Map<string, string>();    // botName → last user platformId
  private getBots: () => BotInstance[] = () => [];

  init(getBots: () => BotInstance[]): void {
    this.getBots = getBots;
  }

  isPoolBot(botName: string): boolean {
    const b = this.getBots().find(x => x.name === botName);
    return !!b && (b as any).pool === true;
  }

  getBoundAgent(botName: string): string | undefined {
    return this.bound.get(botName);
  }

  getBoundBot(agentId: string): string | undefined {
    for (const [bot, aid] of this.bound) if (aid === agentId) return bot;
    return undefined;
  }

  touchUserChat(botName: string, platformId: string): void {
    this.lastUserChat.set(botName, platformId);
  }

  getUserChat(botName: string): string | undefined {
    return this.lastUserChat.get(botName);
  }

  assign(botName: string, agentId: string): { ok: boolean; error?: string } {
    if (!this.isPoolBot(botName)) return { ok: false, error: `Bot "${botName}" is not in the pool` };
    if (this.bound.has(botName)) return { ok: false, error: `Bot "${botName}" already bound to agent "${this.bound.get(botName)}"` };
    const sess = subagentRegistry.get(agentId);
    if (!sess) return { ok: false, error: `Unknown agentId: ${agentId}` };
    if (sess.status !== 'running') return { ok: false, error: `Agent "${agentId}" is not running (status: ${sess.status})` };
    this.bound.set(botName, agentId);
    (sess as any).boundBotName = botName;
    return { ok: true };
  }

  release(botName: string): void {
    const agentId = this.bound.get(botName);
    this.bound.delete(botName);
    this.lastUserChat.delete(botName);
    if (agentId) {
      const sess = subagentRegistry.get(agentId);
      if (sess && (sess as any).boundBotName === botName) (sess as any).boundBotName = undefined;
    }
  }

  releaseAgent(agentId: string): void {
    const bot = this.getBoundBot(agentId);
    if (bot) this.release(bot);
  }

  save(): void {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      }
      const data = {
        bound: Array.from(this.bound.entries()),
        lastUserChat: Array.from(this.lastUserChat.entries()),
      };
      const tmp = BOT_POOL_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, BOT_POOL_FILE);
    } catch {
      // best-effort
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(BOT_POOL_FILE)) return;
      const raw = fs.readFileSync(BOT_POOL_FILE, 'utf-8');
      const data = JSON.parse(raw) as { bound?: [string, string][]; lastUserChat?: [string, string][] };
      this.bound.clear();
      this.lastUserChat.clear();
      for (const [bot, chat] of (data.lastUserChat ?? [])) {
        this.lastUserChat.set(bot, chat);
      }
      // Drop stale bindings — subagents don't survive restart.
      for (const [bot, agentId] of (data.bound ?? [])) {
        if (subagentRegistry.get(agentId)) {
          this.bound.set(bot, agentId);
        }
      }
    } catch {
      // ignore
    }
  }

  listAll(): BotPoolEntry[] {
    return this.getBots().map(b => {
      if ((b as any).pool !== true) return { name: b.name, status: 'main' as const };
      const aid = this.bound.get(b.name);
      return aid
        ? { name: b.name, status: 'bound' as const, boundTo: aid }
        : { name: b.name, status: 'available' as const };
    });
  }
}

export const botPool = new BotPool();
