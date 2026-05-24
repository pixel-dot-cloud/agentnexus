import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from '../config.js';
import type { PermissionMode } from '../lib/permission-modes.js';

export type EngageMode = 'pattern' | 'mention' | 'mention-sticky';

export type ContainerMode = 'full' | 'tools-only';

export interface AgentContainerSpec {
  enabled:      boolean;
  /** Default 'tools-only'. 'full' is planned for P4b (cred-proxy + runner image). */
  mode?:        ContainerMode;
  /** Default 'node:20-slim' for tools-only mode. */
  image?:       string;
  mounts?:      { hostPath: string; containerPath: string; readonly?: boolean }[];
  /** Default 'none' for tools-only sandbox. */
  network?:     'none' | 'bridge';
  /** Docker --cpus flag, e.g. '0.5'. */
  cpuLimit?:    string;
  /** Docker --memory flag, e.g. '512m'. */
  memoryLimit?: string;
}

export interface AgentDefinition {
  name:            string;
  displayName?:    string;
  /** Path to per-agent system prompt overlay (markdown). Defaults to `<dir>/system.md`. */
  systemPath?:     string;
  /** Per-agent memory directory. Defaults to `<dir>/memory`. */
  memoryDir?:      string;
  /** Per-agent skills dir. Defaults to `<dir>/skills`. */
  skillsDir?:      string;
  /** Provider override (else uses active). */
  providerName?:   string;
  modelId?:        string;
  /** Restrict tool surface (else all registered). */
  toolsEnabled?:   string[];
  /** Default engagement when wiring doesn't override. */
  engageMode?:     EngageMode;
  engagePattern?:  string;
  permissionMode?: PermissionMode;
  /** Opt-in container isolation (P4). */
  container?:      AgentContainerSpec;
}

export const AGENTS_DIR = path.join(CONFIG_DIR, 'agents');
export const DEFAULT_AGENT_NAME = 'default';

export function agentDir(name: string): string {
  return path.join(AGENTS_DIR, name);
}

function autoResolvePaths(def: AgentDefinition): AgentDefinition {
  const dir = agentDir(def.name);
  if (!def.systemPath) {
    const sys = path.join(dir, 'system.md');
    if (fs.existsSync(sys)) def.systemPath = sys;
  }
  if (!def.memoryDir) {
    const mem = path.join(dir, 'memory');
    if (fs.existsSync(mem)) def.memoryDir = mem;
  }
  if (!def.skillsDir) {
    const sk = path.join(dir, 'skills');
    if (fs.existsSync(sk)) def.skillsDir = sk;
  }
  return def;
}

export function getAgent(name: string): AgentDefinition | undefined {
  const file = path.join(agentDir(name), 'agent.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    const data: AgentDefinition = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data.name) data.name = name;
    return autoResolvePaths(data);
  } catch {
    return undefined;
  }
}

export function listAgents(): AgentDefinition[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  const out: AgentDefinition[] = [];
  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    const a = getAgent(entry);
    if (a) out.push(a);
  }
  return out;
}

export function saveAgent(def: AgentDefinition): void {
  const dir = agentDir(def.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(def, null, 2), { mode: 0o600 });
}

export function deleteAgent(name: string): boolean {
  const dir = agentDir(name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Synthetic default agent — used when no agents folder exists or wiring resolves
 * to default. Preserves legacy single-agent behavior of pre-port agentnexus.
 */
export function getDefaultAgent(): AgentDefinition {
  return getAgent(DEFAULT_AGENT_NAME) ?? { name: DEFAULT_AGENT_NAME };
}

export function resolveAgent(name: string | undefined): AgentDefinition {
  if (!name || name === DEFAULT_AGENT_NAME) return getDefaultAgent();
  return getAgent(name) ?? getDefaultAgent();
}

export function agentDisplayName(agent: AgentDefinition): string {
  return agent.displayName ?? agent.name ?? 'agent';
}
