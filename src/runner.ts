/**
 * P4b — Container-side runner entrypoint.
 *
 * Compiled to dist/runner.js and executed inside the agentnexus-runner image.
 * Reads a `runTurn` message from stdin, runs the agent loop with an LLM provider
 * pointed at the host's cred-proxy, and proxies all tool calls back to the host
 * via the same stdio channel.
 *
 * Keys are never present in this process — the LLM endpoint is the cred-proxy on
 * the host, which injects the real credentials.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import {
  ProviderFactory,
  AnthropicProvider,
  OpenAICompatibleProvider,
  type ProviderConfig,
  type LLMProvider,
  type ToolSpec,
} from './providers.js';
import { runAgentLoop } from './lib/agent-loop.js';
import { ConsentManager } from './lib/consent.js';
import type { ToolResult } from './tools.js';
import type { RunTurnPayload } from './core/runner-bridge.js';

// ── Env ───────────────────────────────────────────────────────────────────────

const PROXY_BASE_URL = process.env.PROXY_BASE_URL ?? '';
const AGENT_TOKEN    = process.env.AGENT_TOKEN    ?? '';

if (!PROXY_BASE_URL || !AGENT_TOKEN) {
  process.stderr.write('[runner] PROXY_BASE_URL and AGENT_TOKEN must be set\n');
  process.exit(1);
}

// ── Stdio protocol ────────────────────────────────────────────────────────────

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Pending host-side tool results, keyed by callId
const pendingToolResults = new Map<string, (r: { output: string; isError: boolean }) => void>();

// Global abort controller — set by 'abort' message from host
const abortCtrl = new AbortController();

// ── Provider factory (proxy-aware) ────────────────────────────────────────────

/**
 * Build an LLMProvider that talks to the cred-proxy instead of the real API.
 * `proxyBase` = http://host.docker.internal:<port>/proxy/<providerName>
 */
function buildProxiedProvider(type: string, proxyBase: string, modelId: string): LLMProvider {
  // Inject AGENT_TOKEN as the apiKey so providers send it as Authorization: Bearer <token>
  // or x-api-key: <token>. The cred-proxy accepts the token from any of those headers,
  // strips it, then injects the real provider credentials before forwarding upstream.
  const withToken = (base: ProviderConfig): ProviderConfig => ({
    ...base,
    apiKey: AGENT_TOKEN,
  });

  switch (type.toLowerCase()) {
    case 'anthropic':
      // AnthropicProvider uses config.endpoint as the full messages URL
      return new AnthropicProvider(withToken({
        endpoint: proxyBase + '/v1/messages',
        model: modelId,
      }));

    case 'ollama':
      // Ollama supports OAI-compat at /v1/chat/completions — simpler to use that
      // path here so we avoid Ollama's URL origin-stripping behaviour.
      return new OpenAICompatibleProvider(withToken({
        endpoint: proxyBase + '/v1/chat/completions',
        model: modelId,
      }), 'Ollama (proxy)');

    case 'google':
    case 'google-ai':
      // Google OAI-compat path
      return new OpenAICompatibleProvider(withToken({
        endpoint: proxyBase + '/v1beta/openai/chat/completions',
        model: modelId,
      }), 'Google AI (proxy)');

    default:
      // lmstudio, custom, openai-compat
      return new OpenAICompatibleProvider(withToken({
        endpoint: proxyBase + '/v1/chat/completions',
        model: modelId,
      }));
  }
}

// ── Stdin line handler ────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

// Resolve pending tool result or handle abort
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === 'toolResult') {
    const cb = pendingToolResults.get(msg.callId);
    if (cb) {
      pendingToolResults.delete(msg.callId);
      cb({ output: msg.output as string, isError: msg.isError as boolean });
    }
  } else if (msg.type === 'abort') {
    abortCtrl.abort();
  }
});

// ── Custom tool executor (proxy to host) ──────────────────────────────────────

async function remoteExecuteTool(name: string, args: unknown): Promise<ToolResult> {
  const callId = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  send({ type: 'toolCall', callId, name, args });

  const result = await new Promise<{ output: string; isError: boolean }>((resolve) => {
    pendingToolResults.set(callId, resolve);
  });

  return {
    success: !result.isError,
    output:  result.isError ? '' : result.output,
    error:   result.isError ? result.output : undefined,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Touch /heartbeat at startup so the file exists before sweep first checks.
  try { fs.utimesSync('/heartbeat', new Date(), new Date()); } catch {}

  // Background heartbeat — update mtime every 30s while a turn is in progress.
  let hbInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
    try { const now = new Date(); fs.utimes('/heartbeat', now, now, () => {}); } catch {}
  }, 30_000);

  const stopHeartbeat = (): void => {
    if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
  };

  // Read the initial runTurn message
  const firstLine = await new Promise<string>((resolve, reject) => {
    rl.once('line', resolve);
    rl.once('close', () => reject(new Error('stdin closed before runTurn message')));
  });

  let initMsg: { type: string; payload: RunTurnPayload };
  try { initMsg = JSON.parse(firstLine); }
  catch { process.stderr.write('[runner] Failed to parse initial message\n'); process.exit(1); }

  if (initMsg.type !== 'runTurn') {
    process.stderr.write(`[runner] Expected runTurn, got ${initMsg.type}\n`);
    process.exit(1);
  }

  const {
    text, history, systemPrompt, tools,
    proxyBaseUrl, modelId, providerType, maxIter,
  } = initMsg.payload;

  const llm = buildProxiedProvider(providerType, proxyBaseUrl, modelId);

  // bypassPermissions: consent is managed by the host bridge
  const consent = new ConsentManager(() => 'bypassPermissions');

  try {
    const result = await runAgentLoop(
      text,
      history,
      llm,
      () => tools as ToolSpec[],
      systemPrompt,
      consent,
      {
        onText:    async (content) => { send({ type: 'text', content }); },
        onStream:  (chunk)         => { send({ type: 'stream', chunk }); },
        // Tool call / result are reported via the host bridge (toolCall event and
        // the result it sends back). These callbacks are no-ops in the container.
        onToolCall:       async () => {},
        onToolResult:     async () => {},
        onConsentRequest: async () => false,
        onTodosUpdate:    async () => {},
      },
      abortCtrl.signal,
      maxIter,
      remoteExecuteTool,
    );

    stopHeartbeat();
    send({ type: 'done', history: result.history, usage: result.usage });
  } catch (e: any) {
    stopHeartbeat();
    send({ type: 'error', message: e?.message ?? String(e) });
  }

  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[runner] Fatal: ${e?.message ?? e}\n`);
  process.exit(1);
});
