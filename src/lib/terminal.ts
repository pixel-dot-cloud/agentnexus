import * as pty from 'node-pty';
import { randomUUID } from 'crypto';
import stripAnsi from 'strip-ansi';
import { getCwd } from './cwd.js';

export interface ExecResult {
  output: string;
  exitCode: number;
}

export type DisplayListener = () => void;

const EXEC_HARD_TIMEOUT_MS = 5 * 60 * 1000;

export class TerminalManager {
  private proc:     pty.IPty | null = null;
  private lines:    string[]        = [];
  private partial:  string          = '';
  private readonly  MAX_LINES       = 2000;
  private listeners: DisplayListener[] = [];

  constructor(private shell = process.env.SHELL ?? '/bin/bash') {}

  private processRaw(data: string) {
    const clean = stripAnsi(data);
    for (const ch of clean) {
      if      (ch === '\n')               { this.commitLine();                         }
      else if (ch === '\r')               { this.partial = '';                         }
      else if (ch === '\b')               { this.partial = this.partial.slice(0, -1);  }
      else if (ch.charCodeAt(0) >= 32)    { this.partial += ch;                        }
    }
    this.notify();
  }

  private commitLine(line?: string) {
    const l = line ?? this.partial;
    this.lines.push(l);
    if (this.lines.length > this.MAX_LINES) this.lines.shift();
    this.partial = '';
  }

  private notify() { this.listeners.forEach(fn => fn()); }

  addListener(fn: DisplayListener): void    { this.listeners.push(fn); }
  removeListener(fn: DisplayListener): void { this.listeners = this.listeners.filter(l => l !== fn); }

  getLines(): string[] {
    return this.partial ? [...this.lines, this.partial] : this.lines;
  }

  spawn(cols: number, rows: number): void {
    if (this.proc) return;
    this.proc = pty.spawn(this.shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: getCwd(),
      env: process.env as Record<string, string>,
    });
    this.proc.onData(data => this.processRaw(data));
    this.proc.onExit(() => { this.proc = null; });
  }

  write(data: string): void    { this.proc?.write(data); }
  sendSigInt(): void           { this.proc?.write('\x03'); }
  resize(cols: number, rows: number): void { this.proc?.resize(cols, rows); }
  isAlive(): boolean           { return this.proc !== null; }

  async execute(command: string, signal?: AbortSignal): Promise<ExecResult> {
    this.commitLine(`\x1b[90m▶ ${stripAnsi(command)}\x1b[0m`);
    this.notify();

    const sentinel = `__AN_END_${randomUUID()}__`;
    const exitMarker = `__AN_EXIT_${randomUUID()}__`;
    const wrapped = `${command}; printf "${exitMarker}%s\\n${sentinel}\\n" "$?"`;

    let buf = '';
    let displayedUpTo = 0;
    let killed = false;

    return new Promise<ExecResult>((resolve, reject) => {
      const p = pty.spawn('bash', ['-c', wrapped], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: getCwd(),
        env: process.env as Record<string, string>,
      });

      const cleanup = () => {
        try { p.kill(); } catch {}
      };

      const hardTimeout = setTimeout(() => {
        killed = true;
        cleanup();
        reject(new Error(`command timed out after ${EXEC_HARD_TIMEOUT_MS / 1000}s`));
      }, EXEC_HARD_TIMEOUT_MS);

      const onAbort = () => {
        killed = true;
        clearTimeout(hardTimeout);
        cleanup();
        reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const flushDisplay = (cleanFinal: string) => {
        const newPart = cleanFinal.slice(displayedUpTo);
        displayedUpTo = cleanFinal.length;
        for (const rawLine of newPart.split(/\r?\n/)) {
          const line = rawLine.replace(/\r/g, '').trimEnd();
          if (!line) continue;
          if (line.includes(sentinel) || line.includes(exitMarker)) continue;
          this.commitLine(line);
        }
        this.notify();
      };

      p.onData(data => {
        if (killed) return;
        buf += data;
        const cleanBuf = stripAnsi(buf);
        const lastNl = cleanBuf.lastIndexOf('\n');
        if (lastNl > displayedUpTo) {
          flushDisplay(cleanBuf.slice(0, lastNl + 1));
          displayedUpTo = lastNl + 1;
        }

        if (cleanBuf.includes(sentinel)) {
          clearTimeout(hardTimeout);
          signal?.removeEventListener('abort', onAbort);
          cleanup();

          const sentinelIdx = cleanBuf.indexOf(sentinel);
          flushDisplay(cleanBuf.slice(0, cleanBuf.lastIndexOf('\n', sentinelIdx) + 1));

          const exitMatch = cleanBuf.match(new RegExp(`${exitMarker}(\\d+)`));
          const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;

          const output = cleanBuf
            .split('\n')
            .filter(l => !l.includes(sentinel) && !l.includes(exitMarker))
            .join('\n')
            .trim();

          resolve({ output, exitCode });
        }
      });

      p.onExit(({ exitCode }) => {
        if (killed) return;
        clearTimeout(hardTimeout);
        signal?.removeEventListener('abort', onAbort);
        const cleanBuf = stripAnsi(buf);
        flushDisplay(cleanBuf);
        const output = cleanBuf
          .split('\n')
          .filter(l => !l.includes(sentinel) && !l.includes(exitMarker))
          .join('\n')
          .trim();
        resolve({ output, exitCode: exitCode ?? 0 });
      });
    });
  }

  destroy(): void {
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }
}
