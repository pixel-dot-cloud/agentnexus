/**
 * P4c — Heartbeat-based stuck-container detection and reap.
 *
 * Only operates on `full`-mode containers registered by run-turn.ts.
 * Tools-only containers (P4a) are short-lived and are not swept.
 * Sweep is a safety net — each RPC and provider call must still carry
 * its own deadline. Sweep catches what timeouts miss.
 */

import { spawn } from 'child_process';

export interface SweepEntry {
  containerId:    string;
  agentName:      string;
  startedAt:      number;    // epoch ms
  lastSeenMtime?: number;    // /heartbeat mtime, epoch s
  onStuck:        (reason: string) => Promise<void>;
}

export interface SweepConfig {
  enabled:          boolean;
  intervalMs:       number;    // default 60_000
  staleThresholdMs: number;    // default 120_000 (4× heartbeat period)
  startupGraceMs:   number;    // default 30_000
}

export class Sweeper {
  private entries    = new Map<string, SweepEntry>();
  private timer:       NodeJS.Timeout | null = null;
  private dockerPath = 'docker';
  private running   = false;

  start(cfg: SweepConfig, dockerPath = 'docker'): void {
    if (this.timer) return;
    if (!cfg.enabled) return;
    this.dockerPath = dockerPath;
    this.timer = setInterval(() => { this.tick(cfg).catch(() => {}); }, cfg.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  register(entry: SweepEntry): void {
    this.entries.set(entry.containerId, { ...entry });
  }

  unregister(containerId: string): void {
    this.entries.delete(containerId);
  }

  private async tick(cfg: SweepConfig): Promise<void> {
    // Re-entrancy lock: a slow tick must not overlap with the next interval
    // firing or the same container would be marked stale twice → double onStuck.
    if (this.running) return;
    this.running = true;
    try {
      const now   = Date.now();
      const stale: SweepEntry[] = [];

      for (const entry of this.entries.values()) {
        if (now - entry.startedAt < cfg.startupGraceMs) continue;

        const hb = await this.checkHeartbeat(entry.containerId);
        if (hb.failed) {
          stale.push(entry);
        } else if (hb.mtime !== undefined) {
          entry.lastSeenMtime = hb.mtime;
          if (now - hb.mtime * 1000 > cfg.staleThresholdMs) {
            stale.push(entry);
          }
        }
      }

      for (const entry of stale) {
        // Unregister BEFORE side effects so a concurrent register/unregister sees
        // a consistent registry, and so onStuck cannot recursively re-mark.
        this.unregister(entry.containerId);
        try { await entry.onStuck('container heartbeat stale'); } catch {}
        try { await this.killContainer(entry.containerId); } catch {}
      }
    } finally {
      this.running = false;
    }
  }

  private checkHeartbeat(containerId: string): Promise<{ failed: boolean; mtime?: number }> {
    return new Promise((resolve) => {
      const proc = spawn(
        this.dockerPath,
        ['exec', containerId, 'stat', '-c', '%Y', '/heartbeat'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let killed = false;

      const to = setTimeout(() => {
        killed = true;
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.on('error', () => { clearTimeout(to); resolve({ failed: true }); });
      proc.on('close', (code) => {
        clearTimeout(to);
        if (killed || code !== 0) { resolve({ failed: true }); return; }
        const mtime = parseInt(stdout.trim(), 10);
        if (isNaN(mtime)) { resolve({ failed: true }); return; }
        resolve({ failed: false, mtime });
      });

      try { proc.stdin.end(); } catch {}
    });
  }

  private killContainer(containerId: string): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn(this.dockerPath, ['kill', containerId], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const to = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 10_000);
      proc.on('error', () => { clearTimeout(to); resolve(); });
      proc.on('close', () => { clearTimeout(to); resolve(); });
      try { proc.stdin.end(); } catch {}
    });
  }
}

export const sweeper = new Sweeper();
