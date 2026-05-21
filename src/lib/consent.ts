import type { PermissionMode } from './permission-modes.js';

export type ConsentDecision =
  | 'deny'
  | 'allow-once'
  | 'always-tool'
  | 'always-exact'
  | 'always-binary';

export interface ConsentRequest {
  toolName: string;
  args:     Record<string, unknown>;
  diff?:    string;
}

export type ConsentPromptFn = (req: ConsentRequest) => Promise<ConsentDecision>;

export type ToolCategory = 'free' | 'edit' | 'exec';

type AllowEntry = { tool: string; scope: string };

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)?[^|;&]*[/~*]/,
  /\bsudo\b/,
  /\bdoas\b/,
  /\bdd\b[^|;&]*\bof=/,
  /\bmkfs(\.|\s)/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  /\bgit\s+push\b[^|;&]*(--force|-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*[fF]/,
  /\bgit\s+branch\s+-D\b/,
  />\s*\/(?!tmp\/|dev\/null)/,
  /\bcurl\b[^|]*\|\s*(sh|bash|zsh|fish)\b/,
  /\bwget\b[^|]*\|\s*(sh|bash|zsh|fish)\b/,
  /\bnpm\s+(uninstall|unpublish)\b/,
  /\byarn\s+remove\b/,
  /\bpnpm\s+remove\b/,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bkubectl\s+delete\b/,
  /\bdocker\s+(rm|rmi|system\s+prune)\b/,
];

export function isDestructive(command: string): boolean {
  if (!command) return false;
  return DESTRUCTIVE_PATTERNS.some(p => p.test(command));
}

export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

export function firstToken(cmd: string): string {
  const norm = normalizeCommand(cmd);
  if (!norm) return '';
  const tokens = norm.split(' ');
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'sudo' || t === 'doas') { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    const base = t.split('/').pop() ?? t;
    return base;
  }
  return '';
}

function extractShellCommand(args: Record<string, unknown>): string {
  const c = args.command ?? args.cmd;
  return typeof c === 'string' ? c : '';
}

export class ConsentManager {
  private allowed: AllowEntry[] = [];
  private readonly FREE  = new Set(['file_read', 'directory_list']);
  private readonly EDIT  = new Set(['file_write']);
  private readonly EXEC  = new Set(['shell_execute']);
  private getMode: () => PermissionMode;
  private _promptFn: ConsentPromptFn;

  constructor(promptFn: ConsentPromptFn, getMode: () => PermissionMode = () => 'default') {
    this._promptFn = promptFn;
    this.getMode   = getMode;
  }

  private isGated(name: string): boolean {
    return this.EDIT.has(name) || this.EXEC.has(name);
  }

  private scopeKeysForCall(toolName: string, args: Record<string, unknown>): string[] {
    if (toolName === 'shell_execute') {
      const cmd  = extractShellCommand(args);
      const norm = normalizeCommand(cmd);
      const bin  = firstToken(cmd);
      const keys = ['*', `exact:${norm}`];
      if (bin) keys.push(`binary:${bin}`);
      return keys;
    }
    return ['*'];
  }

  needsConsent(toolName: string, args: Record<string, unknown> = {}): boolean {
    const mode = this.getMode();
    if (mode === 'bypassPermissions') return false;
    if (mode === 'acceptEdits' && this.EDIT.has(toolName)) return false;
    if (this.FREE.has(toolName)) return false;
    if (!this.isGated(toolName)) return false;

    if (toolName === 'shell_execute') {
      const cmd = extractShellCommand(args);
      if (isDestructive(cmd)) return true;
    }

    const scopes = this.scopeKeysForCall(toolName, args);
    const matched = this.allowed.some(e => e.tool === toolName && scopes.includes(e.scope));
    return !matched;
  }

  async requestConsent(req: ConsentRequest): Promise<boolean> {
    const mode = this.getMode();

    if (mode === 'plan') {
      if (this.isGated(req.toolName)) return false;
    }

    if (mode === 'bypassPermissions') return true;
    if (mode === 'acceptEdits' && this.EDIT.has(req.toolName)) return true;

    if (!this.needsConsent(req.toolName, req.args)) return true;

    const d = await this._promptFn(req);

    if (d === 'always-tool') {
      this.allowed.push({ tool: req.toolName, scope: '*' });
    } else if (d === 'always-exact' && req.toolName === 'shell_execute') {
      const cmd = extractShellCommand(req.args);
      this.allowed.push({ tool: 'shell_execute', scope: `exact:${normalizeCommand(cmd)}` });
    } else if (d === 'always-binary' && req.toolName === 'shell_execute') {
      const cmd = extractShellCommand(req.args);
      const bin = firstToken(cmd);
      if (bin) this.allowed.push({ tool: 'shell_execute', scope: `binary:${bin}` });
    }

    return d !== 'deny';
  }

  register(name: string, category: ToolCategory): void {
    if (category === 'free') this.FREE.add(name);
    else if (category === 'edit') this.EDIT.add(name);
    else this.EXEC.add(name);
  }

  resetSession(): void {
    this.allowed = [];
  }

  isBlocked(name: string): boolean {
    return this.getMode() === 'plan' && this.isGated(name);
  }
}
