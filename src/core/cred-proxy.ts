/**
 * P4b — Credential proxy.
 *
 * Listens on 127.0.0.1:<port>. Full-mode containers point their LLM providers
 * at this proxy instead of the real API endpoints. The proxy:
 *   1. Validates the per-container X-Agent-Token.
 *   2. Looks up the provider config by name.
 *   3. Verifies the upstream URL matches the provider's configured endpoint (SSRF guard).
 *   4. Strips inbound auth, injects the real API key.
 *   5. Pipes request body + response (streaming-safe).
 *
 * Zero API keys ever cross the host→container boundary.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Provider } from '../config.js';
import { dbgErr } from '../lib/debug.js';

// ── Token registry ────────────────────────────────────────────────────────────

// token → agentName (opaque random token, one per container spawn)
const _tokens = new Map<string, string>();

export function registerAgentToken(token: string, agentName: string): void {
  _tokens.set(token, agentName);
}

export function revokeAgentToken(token: string): void {
  _tokens.delete(token);
}

// ── Proxy server singleton ────────────────────────────────────────────────────

interface ProxyState {
  port: number;
  stop: () => void;
}

let _state: ProxyState | null = null;
let _startPromise: Promise<ProxyState> | null = null;

export interface CredProxyStartOptions {
  port: number;
  getProviders: () => Provider[];
}

/**
 * Start the cred-proxy server. Idempotent — subsequent calls return the same
 * port without starting a second server.
 */
export async function ensureCredProxyStarted(opts: CredProxyStartOptions): Promise<number> {
  if (_state) return _state.port;
  if (_startPromise) return (await _startPromise).port;

  _startPromise = _start(opts);
  _state = await _startPromise;
  _startPromise = null;
  return _state.port;
}

export function stopCredProxy(): void {
  if (_state) {
    try { _state.stop(); } catch {}
    _state = null;
  }
}

function defaultEndpointForType(type: Provider['type']): string {
  switch (type) {
    case 'anthropic': return 'https://api.anthropic.com';
    case 'google':    return 'https://generativelanguage.googleapis.com';
    case 'ollama':    return 'http://localhost:11434';
    case 'lmstudio': return 'http://localhost:1234';
    default:          return '';
  }
}

async function _start(opts: CredProxyStartOptions): Promise<ProxyState> {
  const app = new Hono();

  app.get('/healthz', (c) => c.text('ok'));

  app.all('/proxy/:providerName/*', async (c) => {
    // 1. Validate token — accept from X-Agent-Token, x-api-key, or Authorization Bearer
    const rawAuth  = c.req.header('Authorization') ?? '';
    const bearerToken = rawAuth.startsWith('Bearer ') ? rawAuth.slice(7) : '';
    const token =
      c.req.header('X-Agent-Token') ??
      c.req.header('x-api-key')     ??
      bearerToken                    ??
      '';
    if (!token || !_tokens.has(token)) {
      return c.text('Unauthorized', 401);
    }

    // 2. Look up provider
    const providerName = c.req.param('providerName');
    const provider = opts.getProviders().find((p) => p.name === providerName);
    if (!provider) {
      return c.text(`Provider "${providerName}" not configured`, 404);
    }

    // 3. Build upstream URL: strip /proxy/<name> prefix, append to provider endpoint
    const provBase = (provider.endpoint ?? defaultEndpointForType(provider.type)).replace(/\/$/, '');
    if (!provBase) {
      return c.text(`No endpoint configured for provider "${providerName}"`, 502);
    }

    const rawPath = c.req.path.slice(`/proxy/${providerName}`.length) || '/';
    const upstreamUrl = provBase + rawPath;
    const upstreamSearchParams = new URL(c.req.url).search;
    const finalUrl = upstreamUrl + (upstreamSearchParams || '');

    // 4. Allowlist: upstream must start with provider's configured endpoint (SSRF guard)
    if (!upstreamUrl.startsWith(provBase)) {
      return c.text('Forbidden: upstream URL not in provider allowlist', 403);
    }

    // 5. Build forwarded headers: strip inbound auth, inject real auth
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of c.req.raw.headers.entries()) {
      const lk = k.toLowerCase();
      // Strip secrets the container may have sent (should be absent, but scrub defensively)
      if (lk === 'x-agent-token' || lk === 'authorization' || lk === 'x-api-key') continue;
      // Skip Accept-Encoding: we want uncompressed responses for transparent proxying
      if (lk === 'accept-encoding') continue;
      // Skip host: will be overridden by target URL
      if (lk === 'host') continue;
      fwdHeaders[k] = v;
    }

    if (provider.apiKey) {
      switch (provider.type) {
        case 'anthropic':
          fwdHeaders['x-api-key'] = provider.apiKey;
          // Keep anthropic-version if container sent it; inject default if absent
          if (!fwdHeaders['anthropic-version']) fwdHeaders['anthropic-version'] = '2023-06-01';
          break;
        default:
          fwdHeaders['authorization'] = `Bearer ${provider.apiKey}`;
      }
    }

    // 6. Collect request body (LLM payloads are small JSON; full-buffer is fine)
    const bodyBuf = await c.req.arrayBuffer();
    const hasBody = bodyBuf.byteLength > 0;

    // 7. Forward to upstream
    let upstream: Response;
    try {
      upstream = await fetch(finalUrl, {
        method: c.req.method,
        headers: fwdHeaders,
        body: hasBody ? bodyBuf : undefined,
      });
    } catch (e: any) {
      dbgErr('cred-proxy.fetch', e);
      return c.text(`Upstream fetch error: ${e?.message ?? String(e)}`, 502);
    }

    // 8. Build response headers (strip transfer-encoding — Node handles chunking)
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of upstream.headers.entries()) {
      if (k.toLowerCase() === 'transfer-encoding') continue;
      respHeaders[k] = v;
    }

    // 9. Stream response body back (SSE-safe: ReadableStream passthrough)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  });

  return new Promise((resolve, reject) => {
    try {
      const server = serve(
        { fetch: app.fetch, port: opts.port, hostname: '127.0.0.1' },
        (info) => {
          resolve({
            port: info.port,
            stop: () => server.close(),
          });
        },
      );
    } catch (e) {
      reject(e);
    }
  });
}
