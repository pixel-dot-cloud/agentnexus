/**
 * P4b — Stdio JSON-RPC bridge between host and the runner container.
 *
 * Host spawns the runner container via `docker run -i`. Communication is
 * newline-delimited JSON on stdin/stdout (one message per line).
 *
 * Host → Container (stdin):
 *   { type: 'runTurn',    payload: RunTurnPayload }       — initial request
 *   { type: 'toolResult', callId, output, isError }       — tool execution result
 *   { type: 'abort' }                                      — cancel in-flight turn
 *
 * Container → Host (stdout):
 *   { type: 'stream',   chunk }                           — streaming text delta
 *   { type: 'text',     content }                         — completed assistant text
 *   { type: 'toolCall', callId, name, args }              — request host tool execution
 *   { type: 'done',     history, usage }                  — turn complete
 *   { type: 'error',    message }                         — unrecoverable error
 */

import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ChatMessage, ToolSpec } from '../providers.js';
import type { AgentLoopCallbacks, AgentLoopResult } from '../lib/agent-loop.js';
import type { ToolResult } from '../tools.js';
import type { ConsentRequest } from '../lib/consent.js';
import { ConsentManager } from '../lib/consent.js';
import { computeDiff, colorDiff } from '../lib/diff.js';
import { spawnRunnerProc } from './container.js';
import { dbgErr } from '../lib/debug.js';

// ── Protocol types ────────────────────────────────────────────────────────────

export interface RunTurnPayload {
  text:         string;
  history:      ChatMessage[];
  systemPrompt: string;
  tools:        ToolSpec[];
  proxyBaseUrl: string;   // http://host.docker.internal:<port>/proxy/<providerName>
  agentToken:   string;
  modelId:      string;
  providerType: string;
  maxIter:      number;
}

type H2CMsg =
  | { type: 'runTurn';    payload: RunTurnPayload }
  | { type: 'toolResult'; callId: string; output: string; isError: boolean }
  | { type: 'abort' };

type C2HMsg =
  | { type: 'stream';   chunk: string }
  | { type: 'text';     content: string }
  | { type: 'toolCall'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'done';     history: ChatMessage[]; usage: AgentLoopResult['usage'] }
  | { type: 'error';    message: string };

// ── Bridge args ───────────────────────────────────────────────────────────────

export interface RunnerBridgeArgs {
  // Container spawn
  dockerPath:   string;
  runnerImage:  string;
  networkName:  string;
  addHostArg:   string;   // e.g. 'host.docker.internal:host-gateway'
  mounts:       { hostPath: string; containerPath: string; readonly?: boolean }[];
  cpuLimit?:    string;
  memoryLimit?: string;

  // Turn data
  payload:      RunTurnPayload;

  // Callbacks (same surface as agent-loop callbacks)
  callbacks:    AgentLoopCallbacks;

  // Tool execution on host (already consent-checked by caller)
  executeHostTool: (name: string, args: unknown) => Promise<ToolResult>;

  // Consent (applied on host for container-requested tool calls)
  consentManager:    ConsentManager;
  onConsentRequest:  (req: ConsentRequest) => Promise<false | import('../lib/consent.js').ConsentDecision>;

  signal?: AbortSignal;

  /** Called once the container ID is known (P4c sweep registration). */
  onContainerSpawned?: (containerId: string) => void;
}

// ── Cidfile helpers (P4c) ─────────────────────────────────────────────────────

/**
 * Poll for a Docker --cidfile to appear and contain a non-empty container ID.
 * Calls cb once the ID is available. Cleans up the file afterwards.
 *
 * Timeout: 30s. If the file never appears (slow image pull, slow disk, daemon
 * stall), log a warning to stderr — the container is still spawning but the
 * sweep loop will never get a chance to register it, so a wedged runner will
 * not be reaped automatically.
 */
async function waitForCidFile(cidFile: string, cb: (id: string) => void): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const id = fs.readFileSync(cidFile, 'utf-8').trim();
      if (id) {
        cb(id);
        try { fs.unlinkSync(cidFile); } catch {}
        return;
      }
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  process.stderr.write(
    `[runner-bridge] cidfile ${cidFile} never populated within 30s — sweep cannot reap this container if it wedges\n`,
  );
  try { fs.unlinkSync(cidFile); } catch {}
}

// ── Bridge ────────────────────────────────────────────────────────────────────

export async function runTurnViaRunner(args: RunnerBridgeArgs): Promise<AgentLoopResult> {
  const {
    dockerPath, runnerImage, networkName, addHostArg,
    mounts, cpuLimit, memoryLimit,
    payload, callbacks,
    executeHostTool, consentManager, onConsentRequest,
    signal,
  } = args;

  // P4c: unique cidfile so the sweeper can look up the container ID.
  const cidFile = path.join(os.tmpdir(), `agentnexus-cid-${crypto.randomBytes(8).toString('hex')}`);

  const proc: ChildProcess = spawnRunnerProc(dockerPath, {
    image: runnerImage,
    networkName,
    addHostArg,
    proxyBaseUrl: payload.proxyBaseUrl,
    agentToken: payload.agentToken,
    mounts,
    cpuLimit,
    memoryLimit,
    cidFile,
  });

  // Start background poll — calls onContainerSpawned once the container ID is known.
  if (args.onContainerSpawned) {
    waitForCidFile(cidFile, args.onContainerSpawned).catch(() => {});
  } else {
    // Still clean up the cidfile even if nobody is listening.
    waitForCidFile(cidFile, () => {}).catch(() => {});
  }

  function sendToContainer(msg: H2CMsg): void {
    try { proc.stdin!.write(JSON.stringify(msg) + '\n'); } catch {}
  }

  return new Promise<AgentLoopResult>((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // ── Send initial runTurn ─────────────────────────────────────────────────
    sendToContainer({ type: 'runTurn', payload });

    // ── Read stdout line-by-line ─────────────────────────────────────────────
    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: C2HMsg;
        try { msg = JSON.parse(line); }
        catch { continue; }

        handleMessage(msg).catch((e) => dbgErr('runner-bridge.handleMessage', e));
      }
    });

    async function handleMessage(msg: C2HMsg): Promise<void> {
      switch (msg.type) {
        case 'stream':
          callbacks.onStream(msg.chunk);
          break;

        case 'text':
          await callbacks.onText(msg.content);
          break;

        case 'toolCall': {
          const { callId, name, args } = msg;

          // Compute diff for file_write (display only)
          let diff: string | undefined;
          if (name === 'file_write' && args.path && args.content) {
            try { diff = colorDiff(computeDiff(args.path as string, args.content as string)); } catch {}
          }

          // Plan-mode hard-block
          if (consentManager.isBlocked(name)) {
            await callbacks.onToolResult(name, 'Blocked: plan mode', true);
            sendToContainer({ type: 'toolResult', callId, output: 'Blocked: plan mode', isError: true });
            return;
          }

          // Consent check
          const req: ConsentRequest = { toolName: name, args: args as Record<string, unknown>, diff };
          if (consentManager.needsConsent(name, args as Record<string, unknown>)) {
            const decision = await onConsentRequest(req);
            if (decision === false || decision === 'deny') {
              await callbacks.onToolResult(name, 'denied by user', true);
              sendToContainer({ type: 'toolResult', callId, output: 'denied by user', isError: true });
              return;
            }
            const allowed = consentManager.applyDecision(req, decision);
            if (!allowed) {
              await callbacks.onToolResult(name, 'denied by user', true);
              sendToContainer({ type: 'toolResult', callId, output: 'denied by user', isError: true });
              return;
            }
          }

          // Announce tool call
          await callbacks.onToolCall(name, args as Record<string, unknown>);

          // Execute on host
          let output: string;
          let isError: boolean;
          try {
            const r = await executeHostTool(name, args);
            output  = r.success ? r.output : `Error: ${r.error}`;
            isError = !r.success;
          } catch (e: any) {
            output  = `Tool error: ${e?.message ?? String(e)}`;
            isError = true;
          }

          await callbacks.onToolResult(name, output, isError);
          sendToContainer({ type: 'toolResult', callId, output, isError });
          break;
        }

        case 'done':
          settle(() => resolve({ history: msg.history, usage: msg.usage }));
          break;

        case 'error':
          settle(() => reject(new Error(msg.message)));
          break;
      }
    }

    // ── Process-level events ─────────────────────────────────────────────────
    proc.stderr!.on('data', (d: Buffer) => {
      dbgErr('runner-bridge.stderr', d.toString().trim());
    });

    proc.on('error', (e) => settle(() => reject(e)));

    proc.on('close', (code) => {
      settle(() => {
        if (code === 0 || code === null) {
          reject(new Error('Runner exited without sending done message'));
        } else {
          reject(new Error(`Runner exited with code ${code}`));
        }
      });
    });

    // ── Abort ────────────────────────────────────────────────────────────────
    signal?.addEventListener('abort', () => {
      if (!settled) {
        sendToContainer({ type: 'abort' });
        // Give container 3s to exit cleanly, then force-kill
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          settle(() => reject(new Error('Runner aborted')));
        }, 3000);
      }
    }, { once: true });
  }).finally(() => {
    // Ensure process is dead on any exit path
    try { proc.kill('SIGKILL'); } catch {}
  });
}
