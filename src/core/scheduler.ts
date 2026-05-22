import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from '../config.js';
import type { ConfigManager } from '../config.js';
import { listStarted } from '../channels/registry.js';
import { resolveAgent } from './agents.js';
import { runTurn } from './run-turn.js';
import type { InboundContext, InboundMessage, ChannelCallbacks } from '../channels/types.js';

export interface ScheduledTask {
  id:          string;
  schedule:    string;        // 5-field cron expression (min hour dom month dow)
  channelType: string;
  platformId:  string;
  threadId?:   string | null;
  agentName?:  string;
  prompt:      string;
  lastRunAt?:  string;        // ISO timestamp
  enabled?:    boolean;       // default true
  note?:       string;
}

const SCHEDULE_FILE = path.join(CONFIG_DIR, 'scheduled.json');
const TICK_MS = 60_000;

let ticker: NodeJS.Timeout | null = null;
let lastTickMinute = -1;

export function loadTasks(): ScheduledTask[] {
  if (!fs.existsSync(SCHEDULE_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.tasks)) return raw.tasks;
    return [];
  } catch { return []; }
}

export function saveTasks(tasks: ScheduledTask[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(tasks, null, 2), { mode: 0o600 });
}

export function addTask(task: ScheduledTask): void {
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
}

export function removeTask(id: string): boolean {
  const tasks = loadTasks();
  const next = tasks.filter(t => t.id !== id);
  if (next.length === tasks.length) return false;
  saveTasks(next);
  return true;
}

export function updateTask(id: string, patch: Partial<ScheduledTask>): boolean {
  const tasks = loadTasks();
  const t = tasks.find(x => x.id === id);
  if (!t) return false;
  Object.assign(t, patch);
  saveTasks(tasks);
  return true;
}

// ── 5-field cron parser ────────────────────────────────────────────────────

interface CronFields {
  minute:    number[];
  hour:      number[];
  dom:       number[];
  month:     number[];
  dow:       number[];
}

function expandField(spec: string, min: number, max: number): number[] {
  // Comma list of single | range | step parts.
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`Bad cron field: ${spec}`);
    const isStar  = m[1] === '*';
    const stepStr = m[4];
    const step    = stepStr ? parseInt(stepStr, 10) : 1;
    let from: number;
    let to:   number;
    if (isStar) { from = min; to = max; }
    else {
      from = parseInt(m[2], 10);
      to   = m[3] ? parseInt(m[3], 10) : (stepStr ? max : from);
    }
    if (from < min || to > max || from > to) throw new Error(`Cron range out of bounds: ${spec}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields {
  const norm = expr.trim().toUpperCase()
    .replace(/SUN/g, '0').replace(/MON/g, '1').replace(/TUE/g, '2').replace(/WED/g, '3')
    .replace(/THU/g, '4').replace(/FRI/g, '5').replace(/SAT/g, '6')
    .replace(/JAN/g, '1').replace(/FEB/g, '2').replace(/MAR/g, '3').replace(/APR/g, '4')
    .replace(/MAY/g, '5').replace(/JUN/g, '6').replace(/JUL/g, '7').replace(/AUG/g, '8')
    .replace(/SEP/g, '9').replace(/OCT/g, '10').replace(/NOV/g, '11').replace(/DEC/g, '12');
  const parts = norm.split(/\s+/);
  if (parts.length !== 5) throw new Error(`Expected 5 cron fields, got ${parts.length}: ${expr}`);
  return {
    minute: expandField(parts[0], 0, 59),
    hour:   expandField(parts[1], 0, 23),
    dom:    expandField(parts[2], 1, 31),
    month:  expandField(parts[3], 1, 12),
    dow:    expandField(parts[4], 0, 6),
  };
}

export function matchesCron(expr: string, date: Date): boolean {
  let f: CronFields;
  try { f = parseCron(expr); } catch { return false; }
  const dow = date.getDay();
  return f.minute.includes(date.getMinutes())
      && f.hour.includes(date.getHours())
      && f.dom.includes(date.getDate())
      && f.month.includes(date.getMonth() + 1)
      && f.dow.includes(dow);
}

// ── Tick loop ──────────────────────────────────────────────────────────────

async function fireTask(
  task:      ScheduledTask,
  config:    ConfigManager,
  callbacks: ChannelCallbacks,
): Promise<void> {
  const adapter = listStarted().find(a => a.channelType === task.channelType);
  if (!adapter) {
    console.error(`Scheduled task ${task.id}: no adapter for channel "${task.channelType}"`);
    return;
  }
  const agent = resolveAgent(task.agentName);
  const state = adapter.getOrCreateState(task.platformId, task.threadId ?? null);

  const ctx: InboundContext = {
    channelType: task.channelType,
    platformId:  task.platformId,
    threadId:    task.threadId ?? null,
    adapterId:   'cron',
  };
  const msg: InboundMessage = {
    id:        `cron-${task.id}-${Date.now()}`,
    text:      task.prompt,
    timestamp: new Date().toISOString(),
    isMention: true,
    isGroup:   false,
  };

  // Skip the channel's engagement gate — scheduled tasks are explicit.
  // Run the agent loop directly via runTurn rather than cb.onInbound so we
  // can override agent selection (task.agentName takes priority over wiring).
  void callbacks; // kept for symmetry / future hooks

  await runTurn({
    text:             msg.text,
    state,
    agent,
    config,
    adapter,
    platformId:       ctx.platformId,
    threadId:         ctx.threadId,
    formatOutbound:   adapter.formatOutbound   ?? ((t) => (t ? [t] : [])),
    onToolCallText:   adapter.formatToolCall   ?? (() => null),
    onToolResultText: adapter.formatToolResult ?? (() => null),
  });
}

function tick(config: ConfigManager, callbacks: ChannelCallbacks): void {
  const now    = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  if (minute === lastTickMinute) return; // de-dup within same wall-clock minute
  lastTickMinute = minute;

  const tasks = loadTasks();
  for (const t of tasks) {
    if (t.enabled === false) continue;
    if (!matchesCron(t.schedule, now)) continue;

    // Idempotency — don't refire if lastRunAt is in the same minute window.
    if (t.lastRunAt) {
      const last = new Date(t.lastRunAt);
      if (Math.abs(last.getTime() - now.getTime()) < 60_000) continue;
    }

    updateTask(t.id, { lastRunAt: now.toISOString() });
    fireTask(t, config, callbacks).catch((e) => {
      console.error(`Scheduled task ${t.id} failed:`, e?.message ?? e);
    });
  }
}

export function startScheduler(config: ConfigManager, callbacks: ChannelCallbacks): void {
  if (ticker) return;
  // Align first tick to next 30s boundary so we sample close to minute boundaries.
  const align = 30_000 - (Date.now() % 30_000);
  setTimeout(() => {
    tick(config, callbacks);
    ticker = setInterval(() => tick(config, callbacks), TICK_MS);
  }, align);
  console.log('Scheduler started — checking every 60s.');
}

export function stopScheduler(): void {
  if (ticker) { clearInterval(ticker); ticker = null; }
}
