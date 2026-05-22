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

interface TokenInfo {
  agentName:    string;
  providerName: string;
}

// token → { agentName, providerName } (opaque random token, one per container spawn).
// Provider binding prevents container A from calling upstream as container B's agent
// even if it somehow learns B's token.
const _tokens = new Map<string, TokenInfo>();

export function registerAgentToken(token: string, agentName: string, providerName: string): void {
  _tokens.set(token, { agentName, providerName });
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
    const rawAuth    = c.req.header('Authorization') ?? '';
    const bearerTok  = rawAuth.startsWith('Bearer ') ? rawAuth.slice(7) : '';
    const token =
      c.req.header('X-Agent-Token') ||
      c.req.header('x-api-key')     ||
      bearerTok                     ||
      '';
    const info = token ? _tokens.get(token) : undefined;
    if (!info) {
      return c.text('Unauthorized', 401);
    }

    // 2. Look up provider; reject if token's bound provider differs from URL param.
    //    Stops one container from calling upstream as another agent.
    const providerName = c.req.param('providerName');
    if (info.providerName !== providerName) {
      return c.text('Unauthorized: token not bound to this provider', 401);
    }
    const provider = opts.getProviders().find((p) => p.name === providerName);
    if (!provider) {
      return c.text(`Provider "${providerName}" not configured`, 404);
    }

    // 3. Build upstream URL: strip /proxy/<name> prefix, append to provider endpoint
    const provBase = (provider.endpoint ?? defaultEndpointForType(provider.type)).replace(/\/$/, '');
    if (!provBase) {
      return c.text(`No endpoint configured for provider "${providerName}"`, 502);
    }

    let provBaseOrigin: string;
    try {
      provBaseOrigin = new URL(provBase).origin;
    } catch {
      return c.text(`Invalid endpoint configured for provider "${providerName}"`, 502);
    }

    const rawPath = c.req.path.slice(`/proxy/${providerName}`.length) || '/';
    // Reject path components that could bend the URL parser onto another host
    // (userinfo `@`, scheme-relative `//host`, backslash tricks, control chars).
    if (
      !rawPath.startsWith('/') ||
      rawPath.startsWith('//') ||
      rawPath.includes('@') ||
      rawPath.includes('\\') ||
      /[\x00-\x1f]/.test(rawPath)
    ) {
      return c.text('Forbidden: suspicious path', 403);
    }

    const upstreamSearchParams = new URL(c.req.url, 'http://localhost').search;
    const finalUrl = provBase + rawPath + (upstreamSearchParams || '');

    // 4. SSRF guard: parsed origin must match provider's origin exactly.
    let finalOrigin: string;
    try {
      finalOrigin = new URL(finalUrl).origin;
    } catch {
      return c.text('Forbidden: cannot parse upstream URL', 403);
    }
    if (finalOrigin !== provBaseOrigin) {
      return c.text('Forbidden: upstream URL not in provider allowlist', 403);
    }

    // 5. Build forwarded headers: strip inbound auth, inject real auth.
    //    Also strip hop-by-hop headers per RFC 7230 §6.1.
    const HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
    ]);
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of c.req.raw.headers.entries()) {
      const lk = k.toLowerCase();
      // Strip secrets the container may have sent (should be absent, but scrub defensively)
      if (lk === 'x-agent-token' || lk === 'authorization' || lk === 'x-api-key') continue;
      // Skip accept-encoding (we set identity below to keep SSE intact)
      if (lk === 'accept-encoding') continue;
      // Skip host: will be overridden by target URL
      if (lk === 'host') continue;
      // Skip hop-by-hop headers
      if (HOP_BY_HOP.has(lk)) continue;
      fwdHeaders[k] = v;
    }
    // Force identity so upstream doesn't gzip an SSE stream
    fwdHeaders['accept-encoding'] = 'identity';

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

    // 8. Build response headers (strip hop-by-hop per RFC 7230 §6.1)
    const RESP_HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
    ]);
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of upstream.headers.entries()) {
      if (RESP_HOP_BY_HOP.has(k.toLowerCase())) continue;
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
