import { spawn, type ChildProcess } from 'child_process';
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
export function defaultMounts(agent: AgentDefinition): { hostPath: string; containerPath: string; readonly?: boolean }[] {
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

// ── P4b: network helpers + runner spawn ───────────────────────────────────────

/**
 * Ensure the named Docker network exists. Creates it if absent.
 * Safe to call concurrently — `docker network create` is idempotent-ish
 * (returns exit 1 if already present, which we ignore).
 */
export async function ensureNetworkExists(networkName: string, dockerPath: string): Promise<void> {
  const check = await dockerExec(dockerPath, ['network', 'inspect', networkName], { timeoutMs: 5000 });
  if (check.exitCode === 0) return;

  // enable_ip_masquerade=false disables NAT egress so containers can't reach the
  // public internet. They can still reach the host bridge gateway (cred-proxy
  // via host.docker.internal --add-host). enable_icc=false prevents lateral
  // movement between containers on the same network.
  const createArgs = [
    'network', 'create', networkName,
    '--opt', 'com.docker.network.bridge.enable_ip_masquerade=false',
    '--opt', 'com.docker.network.bridge.enable_icc=false',
  ];
  const create = await dockerExec(dockerPath, createArgs, { timeoutMs: 10000 });
  if (create.exitCode !== 0) {
    // Race: another daemon process may have created it between inspect and create
    const recheck = await dockerExec(dockerPath, ['network', 'inspect', networkName], { timeoutMs: 5000 });
    if (recheck.exitCode !== 0) {
      throw new Error(`Failed to create Docker network "${networkName}": ${create.stderr.trim()}`);
    }
  }
}

export interface HostGatewaySpec {
  /** Value for --add-host flag, e.g. 'host.docker.internal:host-gateway' */
  addHostArg: string;
  /** True if we fell back to a hardcoded IP (Docker < 20.10) */
  usedFallback: boolean;
}

/**
 * Determine the --add-host argument to use so containers can reach the host.
 * Docker 20.10+ supports the `host-gateway` special value. Older versions need
 * the actual bridge gateway IP.
 */
export async function resolveHostGatewaySpec(dockerPath: string): Promise<HostGatewaySpec> {
  // Check Docker server version
  const ver = await dockerExec(dockerPath, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
  if (ver.exitCode === 0) {
    const raw = ver.stdout.trim();
    const [maj, min] = raw.split('.').map(Number);
    if (maj > 20 || (maj === 20 && min >= 10)) {
      return { addHostArg: 'host.docker.internal:host-gateway', usedFallback: false };
    }
  }

  // Fallback: read gateway IP from bridge network
  try {
    const inspect = await dockerExec(
      dockerPath,
      ['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'],
      { timeoutMs: 5000 },
    );
    if (inspect.exitCode === 0 && inspect.stdout.trim()) {
      const ip = inspect.stdout.trim();
      process.stderr.write(
        `[agentnexus] Docker < 20.10: host-gateway unsupported, using bridge IP ${ip}\n`,
      );
      return { addHostArg: `host.docker.internal:${ip}`, usedFallback: true };
    }
  } catch {}

  // Last resort
  process.stderr.write('[agentnexus] Could not detect host gateway IP, using 172.17.0.1\n');
  return { addHostArg: 'host.docker.internal:172.17.0.1', usedFallback: true };
}

/**
 * Check whether a runner image with the given tag exists locally.
 */
export async function checkRunnerImageExists(image: string, dockerPath: string): Promise<boolean> {
  const r = await dockerExec(
    dockerPath,
    ['image', 'inspect', image, '--format', '{{.Id}}'],
    { timeoutMs: 5000 },
  );
  return r.exitCode === 0;
}

export interface RunnerProcOptions {
  image:        string;
  networkName:  string;
  addHostArg:   string;
  proxyBaseUrl: string;
  agentToken:   string;
  mounts:       { hostPath: string; containerPath: string; readonly?: boolean }[];
  cpuLimit?:    string;
  memoryLimit?: string;
  /** Path to a file where Docker writes the container ID on start. Caller reads and cleans up. */
  cidFile?:     string;
}

/**
 * Spawn the runner container with stdio piped (interactive mode).
 * Returns the ChildProcess — lifecycle managed by the caller (runner-bridge).
 * Uses argv form — no shell, injection-safe.
 */
export function spawnRunnerProc(dockerPath: string, opts: RunnerProcOptions): ChildProcess {
  const args: string[] = [
    'run', '--rm', '-i',
    `--network=${opts.networkName}`,
    `--add-host=${opts.addHostArg}`,
    '-e', `PROXY_BASE_URL=${opts.proxyBaseUrl}`,
    '-e', `AGENT_TOKEN=${opts.agentToken}`,
  ];

  if (opts.cpuLimit)    args.push(`--cpus=${opts.cpuLimit}`);
  if (opts.memoryLimit) args.push(`--memory=${opts.memoryLimit}`);
  if (opts.cidFile)     args.push(`--cidfile=${opts.cidFile}`);

  for (const mt of opts.mounts) {
    const ro = mt.readonly ? ':ro' : '';
    args.push('-v', `${mt.hostPath}:${mt.containerPath}${ro}`);
  }

  // Start in the work directory so relative file paths resolve inside the container.
  args.push('-w', '/work');
  args.push(opts.image);

  return spawn(dockerPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}
