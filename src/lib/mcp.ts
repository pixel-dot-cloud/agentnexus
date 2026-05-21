import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { BaseTool, ToolResult } from '../tools.js';
import { getCwd } from './cwd.js';

interface RpcReq { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
interface RpcNotify { jsonrpc: '2.0'; method: string; params?: unknown }
interface RpcRes { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpCallResult {
  output: string;
  isError: boolean;
}

const STDERR_RING_LIMIT = 4096;
const RPC_TIMEOUT_MS = 30_000;

export class McpClient {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private pending = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }
  >();
  private seq = 1;
  private dead = false;
  private stderrRing = '';

  constructor(
    private serverName: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ) {
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: getCwd(),
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on('line', line => this.handleStdoutLine(line));

    if (this.proc.stderr) {
      this.proc.stderr.on('data', (data: Buffer | string) => {
        this.stderrRing = (this.stderrRing + String(data)).slice(-STDERR_RING_LIMIT);
      });
    }

    this.proc.on('error', err => this.die(err));
    this.proc.on('exit', code => this.die(new Error(`MCP "${serverName}" exited (code ${code ?? '?'})`)));
  }

  getStderrTail(): string { return this.stderrRing; }
  isAlive(): boolean { return !this.dead; }

  private die(reason: unknown): void {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    try { this.rl.close(); } catch {}
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;
    try {
      const r: RpcRes = JSON.parse(line);
      if (typeof r.id !== 'number') return;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      if (r.error) p.reject(new Error(r.error.message ?? 'MCP RPC error'));
      else p.resolve(r.result);
    } catch { /* ignore malformed line */ }
  }

  private rpc(method: string, params?: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(`MCP "${this.serverName}" is not alive`));
    return new Promise((resolve, reject) => {
      const id = this.seq++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP "${this.serverName}" RPC ${method} timed out after ${RPC_TIMEOUT_MS}ms`));
        }
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const req: RpcReq = { jsonrpc: '2.0', id, method, params };
        this.proc.stdin!.write(JSON.stringify(req) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.dead) return;
    try {
      const req: RpcNotify = { jsonrpc: '2.0', method, params };
      this.proc.stdin!.write(JSON.stringify(req) + '\n');
    } catch { /* ignore */ }
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agentnexus', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpToolDef[]> {
    const r = (await this.rpc('tools/list')) as any;
    return r?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const r = (await this.rpc('tools/call', { name, arguments: args })) as any;
    const output = (r?.content ?? [])
      .map((c: any) => {
        if (typeof c?.text === 'string') return c.text;
        if (c?.type && c.type !== 'text') return `[${c.type} content]`;
        return '';
      })
      .join('\n');
    return { output, isError: !!r?.isError };
  }

  destroy(): void {
    this.die(new Error(`MCP "${this.serverName}" destroyed`));
    try { this.proc.kill(); } catch {}
  }
}

export class McpTool extends BaseTool {
  readonly requiresConsent = true;

  constructor(
    public readonly name: string,
    public readonly description: string,
    private client: McpClient,
    public readonly schema: Record<string, unknown>,
  ) {
    super();
  }

  get usage(): string {
    return `${this.name}(${JSON.stringify(this.schema)})`;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const r = await this.client.callTool(this.name, args);
      if (r.isError) return { success: false, output: r.output, error: 'tool reported error' };
      return { success: true, output: r.output };
    } catch (e: any) {
      return { success: false, output: '', error: e.message };
    }
  }
}

export function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
  const p = path.join(cwd, '.mcp.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')).mcpServers ?? {};
  } catch {
    return {};
  }
}
