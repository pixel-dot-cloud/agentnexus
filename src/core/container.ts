import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { AgentDefinition } from './agents.js';
import type { ContainerDefaults } from '../config.js';
import { agentDir } from './agents.js';
import { dbgErr } from '../lib/debug.js';

export class DockerUnavailableError extends Error {
  constructor(msg = 'Docker is not available on this host. Install Docker or disable agent.container.enabled.') {
    super(msg);
    this.name = 'DockerUnavailableError';
  }
}

export interface DockerRunResult {
  stdout:   string;
  stderr:   string;
  exitCode: number;
}

export interface ContainerHandle {
  id:        string;
  agentName: string;
  run(cmd: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<DockerRunResult>;
  stop(): Promise<void>;
  isAlive(): Promise<boolean>;
}

interface DockerCtx {
  dockerPath: string;
}

let dockerAvailableCache: boolean | null = null;

/**
 * Spawn a `docker` subprocess with argv (no shell) and capture output.
 * No string interpolation reaches a shell — argv form is injection-safe.
 */
function dockerExec(
  dockerPath: string,
  args: string[],
  opts?: { timeoutMs?: number; input?: string },
): Promise<DockerRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(dockerPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const to = opts?.timeoutMs
      ? setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch {} }, opts.timeoutMs)
      : null;

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      if (to) clearTimeout(to);
      resolve({ stdout, stderr: stderr || String(e), exitCode: -1 });
    });
    proc.on('close', (code) => {
      if (to) clearTimeout(to);
      if (killed) stderr += '\n[killed: timeout]';
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    if (opts?.input) {
      try { proc.stdin.write(opts.input); proc.stdin.end(); } catch {}
    } else {
      try { proc.stdin.end(); } catch {}
    }
  });
}

export async function ensureDockerAvailable(dockerPath = 'docker'): Promise<boolean> {
  if (dockerAvailableCache !== null) return dockerAvailableCache;
  try {
    const r = await dockerExec(dockerPath, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
    dockerAvailableCache = r.exitCode === 0;
  } catch {
    dockerAvailableCache = false;
  }
  return dockerAvailableCache;
}

/** For tests / re-probing. */
export function resetDockerCache(): void { dockerAvailableCache = null; }

function mergeSpec(agent: AgentDefinition, defaults: ContainerDefaults) {
  const spec = agent.container ?? { enabled: false };
  return {
    image:       spec.image       ?? defaults.defaultImage       ?? 'node:20-slim',
    network:     spec.network     ?? defaults.defaultNetwork     ?? 'none',
    cpuLimit:    spec.cpuLimit    ?? defaults.defaultCpuLimit    ?? '',
    memoryLimit: spec.memoryLimit ?? defaults.defaultMemoryLimit ?? '',
    mounts:      spec.mounts      ?? [],
  };
}

/**
 * Default work mount: `~/.agentnexus/agents/<name>/work` -> `/work` (rw).
 * Auto-created on first spawn if absent. Only added when caller passes no mounts.
 */
function defaultMounts(agent: AgentDefinition): { hostPath: string; containerPath: string; readonly?: boolean }[] {
  const host = path.join(agentDir(agent.name), 'work');
  try { fs.mkdirSync(host, { recursive: true, mode: 0o700 }); } catch {}
  return [{ hostPath: host, containerPath: '/work', readonly: false }];
}

export async function spawnSandbox(
  agent: AgentDefinition,
  defaults: ContainerDefaults,
): Promise<ContainerHandle> {
  const dockerPath = defaults.dockerPath ?? 'docker';
  const ok = await ensureDockerAvailable(dockerPath);
  if (!ok) throw new DockerUnavailableError();

  const m = mergeSpec(agent, defaults);
  const mounts = m.mounts.length ? m.mounts : defaultMounts(agent);

  const args: string[] = ['run', '-d', '--rm', `--network=${m.network}`];
  if (m.cpuLimit)    args.push(`--cpus=${m.cpuLimit}`);
  if (m.memoryLimit) args.push(`--memory=${m.memoryLimit}`);
  for (const mt of mounts) {
    const ro = mt.readonly ? ':ro' : '';
    args.push('-v', `${mt.hostPath}:${mt.containerPath}${ro}`);
  }
  args.push('-w', '/work');
  args.push(m.image, 'sleep', 'infinity');

  const r = await dockerExec(dockerPath, args, { timeoutMs: 30000 });
  if (r.exitCode !== 0) {
    throw new Error(`docker run failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const id = r.stdout.trim().split('\n').pop()!.trim();
  if (!id) throw new Error('docker run returned no container id');

  const ctx: DockerCtx = { dockerPath };

  return {
    id,
    agentName: agent.name,
    async run(cmd, opts) {
      const execArgs = ['exec'];
      if (opts?.cwd) execArgs.push('-w', opts.cwd);
      execArgs.push(id, ...cmd);
      return dockerExec(ctx.dockerPath, execArgs, { timeoutMs: opts?.timeoutMs ?? 30000 });
    },
    async stop() {
      try {
        await dockerExec(ctx.dockerPath, ['stop', '-t', '2', id], { timeoutMs: 10000 });
      } catch (e) {
        dbgErr('container.stop', e);
      }
    },
    async isAlive() {
      const r2 = await dockerExec(ctx.dockerPath, ['inspect', '-f', '{{.State.Running}}', id], { timeoutMs: 5000 });
      return r2.exitCode === 0 && r2.stdout.trim() === 'true';
    },
  };
}

export async function teardownSandbox(handle: ContainerHandle): Promise<void> {
  await handle.stop();
}
