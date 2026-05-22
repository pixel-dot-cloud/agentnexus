import fetch from 'node-fetch';
import * as rl from 'readline';
import { GoogleGenAI } from '@google/genai';

export const AUTO_MODEL = '__auto__';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ChatResult {
  content:   string;
  toolCalls: ToolCall[];
  aborted?:  boolean;
  usage?: {
    inputTokens:          number;
    outputTokens:         number;
    cacheReadTokens?:     number;
    cacheCreationTokens?: number;
  };
}

export interface ProviderConfig {
  endpoint?: string;
  model: string;
  apiKey?: string;
  idleTimeoutMs?: number;
}

// 0 = disabled. Slow local models / reasoning models often pause >90s between
// chunks. User can still abort with Esc. Set idleTimeoutMs in provider config
// to re-enable an idle watchdog if desired.
const DEFAULT_IDLE_MS = 0;

function makeIdleTimer(ms: number, onTimeout: () => void) {
  let t: NodeJS.Timeout | null = null;
  return {
    reset() {
      if (t) clearTimeout(t);
      if (ms > 0) t = setTimeout(onTimeout, ms);
    },
    stop() {
      if (t) clearTimeout(t);
      t = null;
    },
  };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

let _toolCallSeq = 0;
function newToolCallId(): string {
  return `call_${Date.now()}_${_toolCallSeq++}`;
}

export abstract class LLMProvider {
  protected config: ProviderConfig;
  protected name: string;
  protected _resolvedModel = '';
  protected _resolvedAt = 0;
  protected static readonly RESOLVE_TTL_MS = 5_000;

  constructor(config: ProviderConfig, name: string) {
    this.config = config;
    this.name = name;
  }

  getResolvedModel(): string { return this._resolvedModel || this.config.model; }

  async resolveModel(_signal?: AbortSignal): Promise<string> { return this.config.model; }

  protected resolveCacheHit(): string | undefined {
    if (!this._resolvedModel) return undefined;
    if (Date.now() - this._resolvedAt >= LLMProvider.RESOLVE_TTL_MS) return undefined;
    return this._resolvedModel;
  }

  protected setResolved(id: string): string {
    this._resolvedModel = id;
    this._resolvedAt = Date.now();
    return id;
  }

  abstract chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult>;

  async listModels(): Promise<string[]> {
    return [];
  }

  protected handleError(error: any): ChatResult {
    if (error?.name === 'AbortError') return { content: '', toolCalls: [], aborted: true };
    return {
      content: `Error from ${this.name}: ${error?.message ?? String(error)}`,
      toolCalls: [],
    };
  }

  protected splitSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
    let system = '';
    const rest: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system = system ? `${system}\n\n${m.content}` : m.content;
      } else {
        rest.push(m);
      }
    }
    return { system, rest };
  }

  protected idleMs(): number {
    return this.config.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama
// ─────────────────────────────────────────────────────────────────────────────

export class OllamaProvider extends LLMProvider {
  constructor(config: ProviderConfig) {
    super(config, 'Ollama');
  }

  async resolveModel(signal?: AbortSignal): Promise<string> {
    if (this.config.model !== AUTO_MODEL) return this.config.model;
    const hit = this.resolveCacheHit();
    if (hit) return hit;
    try {
      const base = new URL(this.config.endpoint || 'http://localhost:11434/api/generate').origin;
      const res = await fetch(`${base}/api/ps`, { signal: signal as any });
      if (res.ok) {
        const json = (await res.json()) as any;
        const name: string | undefined = json.models?.[0]?.name;
        if (name) return this.setResolved(name);
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
    }
    const models = await this.listModels(signal);
    if (models[0]) return this.setResolved(models[0]);
    throw new Error('No model loaded in Ollama. Load one first.');
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const { system, rest } = this.splitSystem(messages);
    const apiMessages: any[] = [];
    if (system) apiMessages.push({ role: 'system', content: system });

    for (const m of rest) {
      if (m.role === 'tool') {
        for (const r of m.toolResults ?? []) {
          apiMessages.push({ role: 'tool', content: r.output, name: r.name });
        }
      } else if (m.role === 'assistant') {
        const msg: any = { role: 'assistant', content: m.content };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map(tc => ({
            function: { name: tc.name, arguments: tc.args },
          }));
        }
        apiMessages.push(msg);
      } else if (m.role === 'user') {
        apiMessages.push({ role: 'user', content: m.content });
      }
    }

    let model: string;
    try { model = await this.resolveModel(signal); }
    catch (e: any) { return this.handleError(e); }
    const body: any = {
      model,
      messages: apiMessages,
      stream: true,
    };
    if (tools.length) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
    }

    if (signal?.aborted) return { content: '', toolCalls: [], aborted: true };

    const internal = new AbortController();
    const idle = makeIdleTimer(this.idleMs(), () => internal.abort());
    const onUserAbort = () => internal.abort();
    signal?.addEventListener('abort', onUserAbort, { once: true });
    idle.reset();

    try {
      const endpoint = this.config.endpoint || 'http://localhost:11434/api/generate';
      const chatEndpoint = new URL(endpoint).origin + '/api/chat';

      const response = await fetch(chatEndpoint, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        signal: internal.signal as any,
      });
      idle.reset();

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`API error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
      }

      let buffer = '';
      let inputTokens  = 0;
      let outputTokens = 0;
      const toolCalls: ToolCall[] = [];
      const lineReader = rl.createInterface({ input: response.body as any, crlfDelay: Infinity });
      const onAbortClose = () => lineReader.close();
      signal?.addEventListener('abort', onAbortClose, { once: true });
      internal.signal.addEventListener('abort', onAbortClose, { once: true });

      try {
        for await (const line of lineReader) {
          idle.reset();
          if (signal?.aborted || internal.signal.aborted) break;
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const text: string | undefined = obj.message?.content;
            if (text) {
              onChunk(text);
              buffer += text;
            }
            const tcs: any[] = obj.message?.tool_calls;
            if (Array.isArray(tcs)) {
              for (const t of tcs) {
                const args = typeof t.function?.arguments === 'string'
                  ? safeJsonParse(t.function.arguments)
                  : ((t.function?.arguments ?? {}) as Record<string, unknown>);
                toolCalls.push({
                  id: newToolCallId(),
                  name: t.function?.name ?? '',
                  args,
                });
              }
            }
            if (obj.done) {
              if (typeof obj.prompt_eval_count === 'number') inputTokens  = obj.prompt_eval_count;
              if (typeof obj.eval_count        === 'number') outputTokens = obj.eval_count;
              break;
            }
          } catch {
            // ignore malformed JSON line
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbortClose);
      }

      const usage = (inputTokens > 0 || outputTokens > 0) ? { inputTokens, outputTokens } : undefined;
      if (signal?.aborted) return { content: buffer, toolCalls, aborted: true, usage };
      return { content: buffer, toolCalls, usage };
    } catch (err: any) {
      return this.handleError(err);
    } finally {
      idle.stop();
      signal?.removeEventListener('abort', onUserAbort);
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const endpoint = this.config.endpoint || 'http://localhost:11434/api/generate';
      const base = new URL(endpoint).origin;
      const res = await fetch(`${base}/api/tags`, { signal: signal as any });
      if (!res.ok) return [];
      const json = (await res.json()) as any;
      return (json.models || []).map((m: any) => m.name as string);
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible (LM Studio + Custom)
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAICompatibleProvider extends LLMProvider {
  constructor(config: ProviderConfig, name = 'OpenAI-compatible') {
    super(config, name);
  }

  async resolveModel(signal?: AbortSignal): Promise<string> {
    if (this.config.model !== AUTO_MODEL) return this.config.model;
    const hit = this.resolveCacheHit();
    if (hit) return hit;
    const models = await this.listModels(signal);
    if (models[0]) return this.setResolved(models[0]);
    throw new Error('No model loaded. Load one in LM Studio (or your custom endpoint) first.');
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const { system, rest } = this.splitSystem(messages);
    const apiMessages: any[] = [];
    if (system) apiMessages.push({ role: 'system', content: system });

    for (const m of rest) {
      if (m.role === 'tool') {
        for (const r of m.toolResults ?? []) {
          apiMessages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
        }
      } else if (m.role === 'assistant') {
        const msg: any = { role: 'assistant', content: m.content || null };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        apiMessages.push(msg);
      } else if (m.role === 'user') {
        apiMessages.push({ role: 'user', content: m.content });
      }
    }

    let model: string;
    try { model = await this.resolveModel(signal); }
    catch (e: any) { return this.handleError(e); }
    const body: any = {
      model,
      messages: apiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
    }

    if (signal?.aborted) return { content: '', toolCalls: [], aborted: true };

    const internal = new AbortController();
    const idle = makeIdleTimer(this.idleMs(), () => internal.abort());
    const onUserAbort = () => internal.abort();
    signal?.addEventListener('abort', onUserAbort, { once: true });
    idle.reset();

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;

      const response = await fetch(
        this.config.endpoint || 'http://localhost:1234/v1/chat/completions',
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers,
          signal: internal.signal as any,
        },
      );
      idle.reset();

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`API error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
      }

      let buffer = '';
      let inputTokens  = 0;
      let outputTokens = 0;
      let fallbackIdx  = 1_000_000;
      const tcByIdx = new Map<number, { id?: string; name?: string; argsBuf: string }>();
      const lineReader = rl.createInterface({ input: response.body as any, crlfDelay: Infinity });
      const onAbortClose = () => lineReader.close();
      signal?.addEventListener('abort', onAbortClose, { once: true });
      internal.signal.addEventListener('abort', onAbortClose, { once: true });

      try {
        for await (const line of lineReader) {
          idle.reset();
          if (signal?.aborted || internal.signal.aborted) break;
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') break;
          if (!data) continue;
          try {
            const obj = JSON.parse(data);
            if (obj.usage) {
              inputTokens  = obj.usage.prompt_tokens     ?? inputTokens;
              outputTokens = obj.usage.completion_tokens ?? outputTokens;
            }
            const delta = obj.choices?.[0]?.delta;
            const text: string | undefined = delta?.content;
            if (text) {
              onChunk(text);
              buffer += text;
            }
            const dtcs: any[] = delta?.tool_calls;
            if (Array.isArray(dtcs)) {
              for (const t of dtcs) {
                const idx: number = typeof t.index === 'number' ? t.index : fallbackIdx++;
                let entry = tcByIdx.get(idx);
                if (!entry) {
                  entry = { argsBuf: '' };
                  tcByIdx.set(idx, entry);
                }
                if (t.id) entry.id = t.id;
                if (t.function?.name) entry.name = t.function.name;
                if (typeof t.function?.arguments === 'string') entry.argsBuf += t.function.arguments;
              }
            }
          } catch {
            // ignore
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbortClose);
      }

      const toolCalls: ToolCall[] = [];
      for (const [idx, e] of [...tcByIdx.entries()].sort((a, b) => a[0] - b[0])) {
        toolCalls.push({
          id: e.id ?? `call_${idx}_${Date.now()}`,
          name: e.name ?? '',
          args: safeJsonParse(e.argsBuf),
        });
      }

      const usage = (inputTokens > 0 || outputTokens > 0)
        ? { inputTokens, outputTokens }
        : undefined;
      if (signal?.aborted) return { content: buffer, toolCalls, aborted: true, usage };
      return { content: buffer, toolCalls, usage };
    } catch (err: any) {
      return this.handleError(err);
    } finally {
      idle.stop();
      signal?.removeEventListener('abort', onUserAbort);
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const endpoint = this.config.endpoint || 'http://localhost:1234/v1/chat/completions';
      const base = new URL(endpoint).origin;
      const headers: Record<string, string> = {};
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      const res = await fetch(`${base}/v1/models`, { headers, signal: signal as any });
      if (!res.ok) return [];
      const json = (await res.json()) as any;
      return (json.data || []).map((m: any) => m.id as string);
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      return [];
    }
  }
}

export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(config, 'LM Studio');
  }

  // LM Studio's OpenAI-compat /v1/models returns all installed models on some
  // builds, so data[0] may be cold. Use LmStudioApi.getLoaded() which filters
  // by state === 'loaded' across native v1/v0 + OpenAI-compat shapes.
  async resolveModel(signal?: AbortSignal): Promise<string> {
    if (this.config.model !== AUTO_MODEL) return this.config.model;
    const hit = this.resolveCacheHit();
    if (hit) return hit;
    const { LmStudioApi } = await import('./lib/lmstudio-api.js');
    const api = new LmStudioApi(this.config.endpoint, this.config.apiKey);
    try {
      const loaded = await api.getLoaded(signal);
      const id = loaded[0]?.id;
      if (id) return this.setResolved(id);
      const all = await api.listModels(signal);
      if (all.length) {
        const sample = all.map(m => m.id).slice(0, 3).join(', ');
        throw new Error(`No model loaded in LM Studio. Installed: ${sample}${all.length > 3 ? '...' : ''}. Load one first.`);
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      if (e?.message?.startsWith('No model loaded')) throw e;
    }
    throw new Error('No model loaded in LM Studio. Load one first.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────────────────────────

export class AnthropicProvider extends LLMProvider {
  constructor(config: ProviderConfig) {
    super(config, 'Anthropic');
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const { system, rest } = this.splitSystem(messages);
    const apiMessages: any[] = [];

    for (const m of rest) {
      if (m.role === 'user') {
        apiMessages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        }
        apiMessages.push({ role: 'assistant', content: blocks.length ? blocks : '' });
      } else if (m.role === 'tool') {
        const blocks: any[] = [];
        for (const r of m.toolResults ?? []) {
          blocks.push({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.output,
            ...(r.isError ? { is_error: true } : {}),
          });
        }
        apiMessages.push({ role: 'user', content: blocks });
      }
    }

    const body: any = {
      model: this.config.model,
      max_tokens: 8192,
      messages: apiMessages,
      stream: true,
    };
    if (system) body.system = system;
    if (tools.length) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));
    }

    if (signal?.aborted) return { content: '', toolCalls: [], aborted: true };

    const internal = new AbortController();
    const idle = makeIdleTimer(this.idleMs(), () => internal.abort());
    const onUserAbort = () => internal.abort();
    signal?.addEventListener('abort', onUserAbort, { once: true });
    idle.reset();

    try {
      const response = await fetch(
        this.config.endpoint || 'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey || '',
            'anthropic-version': '2023-06-01',
          },
          signal: internal.signal as any,
        },
      );
      idle.reset();

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`API error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
      }

      let buffer = '';
      type Block =
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; argsBuf: string };
      const blocks = new Map<number, Block>();
      let inputTokens  = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;

      const lineReader = rl.createInterface({ input: response.body as any, crlfDelay: Infinity });
      const onAbortClose = () => lineReader.close();
      signal?.addEventListener('abort', onAbortClose, { once: true });
      internal.signal.addEventListener('abort', onAbortClose, { once: true });

      try {
        for await (const line of lineReader) {
          idle.reset();
          if (signal?.aborted || internal.signal.aborted) break;
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const obj = JSON.parse(data);
            const t = obj.type;
            if (t === 'message_start') {
              const u = obj.message?.usage;
              if (u) {
                inputTokens         = u.input_tokens  ?? 0;
                outputTokens        = u.output_tokens ?? 0;
                cacheReadTokens     = u.cache_read_input_tokens     ?? 0;
                cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
              }
            } else if (t === 'message_delta') {
              const u = obj.usage;
              if (u) outputTokens = u.output_tokens ?? outputTokens;
            } else if (t === 'content_block_start') {
              const idx: number = obj.index;
              const b = obj.content_block;
              if (b.type === 'text') blocks.set(idx, { type: 'text', text: '' });
              else if (b.type === 'tool_use')
                blocks.set(idx, { type: 'tool_use', id: b.id, name: b.name, argsBuf: '' });
            } else if (t === 'content_block_delta') {
              const idx: number = obj.index;
              const d = obj.delta;
              const b = blocks.get(idx);
              if (!b) continue;
              if (b.type === 'text' && d.type === 'text_delta') {
                b.text += d.text;
                onChunk(d.text);
                buffer += d.text;
              } else if (b.type === 'tool_use' && d.type === 'input_json_delta') {
                b.argsBuf += d.partial_json;
              }
            } else if (t === 'message_stop') {
              break;
            }
          } catch {
            // ignore
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbortClose);
      }

      const toolCalls: ToolCall[] = [];
      for (const [, b] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
        if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, name: b.name, args: safeJsonParse(b.argsBuf) });
        }
      }

      const usage = (inputTokens > 0 || outputTokens > 0)
        ? { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
        : undefined;
      if (signal?.aborted) return { content: buffer, toolCalls, aborted: true, usage };
      return { content: buffer, toolCalls, usage };
    } catch (err: any) {
      return this.handleError(err);
    } finally {
      idle.stop();
      signal?.removeEventListener('abort', onUserAbort);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Google AI — raw fetch via OAI-compat endpoint (P4b default)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Google AI via the OAI-compatible Gemini endpoint.
 * Endpoint default: https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 *
 * Dropped the @google/genai SDK dependency for this provider — the SDK does not
 * honour arbitrary base URLs, which breaks full-mode container routing via the
 * cred-proxy. Raw fetch is equivalent and simpler.
 *
 * The SDK-based implementation is preserved as GoogleAISDKProvider below for
 * reference (not wired into ProviderFactory).
 */
export class GoogleAIRawFetchProvider extends OpenAICompatibleProvider {
  private static readonly DEFAULT_ENDPOINT =
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  constructor(config: ProviderConfig) {
    super(
      { ...config, endpoint: config.endpoint ?? GoogleAIRawFetchProvider.DEFAULT_ENDPOINT },
      'Google AI',
    );
  }

  override async resolveModel(signal?: AbortSignal): Promise<string> {
    if (this.config.model === AUTO_MODEL) {
      throw new Error(
        'Google AI does not support auto model selection. Specify a model ID (e.g. gemini-2.0-flash).',
      );
    }
    return this.config.model;
  }

  override async listModels(_signal?: AbortSignal): Promise<string[]> {
    // Google AI's OAI-compat /v1/models endpoint requires auth and returns a
    // non-standard shape. Return empty; users configure the model explicitly.
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Google AI — SDK-based implementation (kept for reference, not in factory)
// ─────────────────────────────────────────────────────────────────────────────

export class GoogleAISDKProvider extends LLMProvider {
  constructor(config: ProviderConfig) {
    super(config, 'Google AI');
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    try {
      const ai = new GoogleGenAI({ apiKey: this.config.apiKey });
      const { system, rest } = this.splitSystem(messages);
      const contents: any[] = [];

      for (const m of rest) {
        if (m.role === 'user') {
          contents.push({ role: 'user', parts: [{ text: m.content }] });
        } else if (m.role === 'assistant') {
          const parts: any[] = [];
          if (m.content) parts.push({ text: m.content });
          for (const tc of m.toolCalls ?? []) {
            parts.push({ functionCall: { name: tc.name, args: tc.args } });
          }
          contents.push({ role: 'model', parts });
        } else if (m.role === 'tool') {
          const parts: any[] = [];
          for (const r of m.toolResults ?? []) {
            parts.push({
              functionResponse: {
                name: r.name,
                response: { content: r.output, ...(r.isError ? { isError: true } : {}) },
              },
            });
          }
          contents.push({ role: 'function', parts });
        }
      }

      const cfg: any = {
        model: this.config.model,
        contents,
      };
      if (system) cfg.systemInstruction = { parts: [{ text: system }] };
      if (tools.length) {
        cfg.tools = [{
          functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.schema,
          })),
        }];
      }

      if (signal?.aborted) return { content: '', toolCalls: [], aborted: true };
      const compositeCtrl = new AbortController();
      const idle = makeIdleTimer(this.idleMs(), () => compositeCtrl.abort());
      const onUserAbort = () => compositeCtrl.abort();
      signal?.addEventListener('abort', onUserAbort, { once: true });
      idle.reset();

      let buffer = '';
      const toolCalls: ToolCall[] = [];

      try {
        const stream = await ai.models.generateContentStream({
          ...(cfg as any),
          config: { ...((cfg as any).config ?? {}), abortSignal: compositeCtrl.signal },
        } as any);
        for await (const chunk of stream as any) {
          idle.reset();
          if (compositeCtrl.signal.aborted) break;
          const text: string = (chunk as any).text ?? '';
          if (text) {
            onChunk(text);
            buffer += text;
          }
          // SDK may expose functionCalls as method or array
          const fcsRaw = (chunk as any).functionCalls;
          const fcs = typeof fcsRaw === 'function' ? fcsRaw.call(chunk) : fcsRaw;
          if (Array.isArray(fcs)) {
            for (const fc of fcs) {
              toolCalls.push({
                id: newToolCallId(),
                name: fc.name,
                args: (fc.args ?? {}) as Record<string, unknown>,
              });
            }
          } else {
            const cands = (chunk as any).candidates ?? [];
            for (const c of cands) {
              for (const p of c.content?.parts ?? []) {
                if (p.functionCall) {
                  toolCalls.push({
                    id: newToolCallId(),
                    name: p.functionCall.name,
                    args: (p.functionCall.args ?? {}) as Record<string, unknown>,
                  });
                }
              }
            }
          }
        }
      } finally {
        idle.stop();
        signal?.removeEventListener('abort', onUserAbort);
      }

      if (signal?.aborted) return { content: buffer, toolCalls, aborted: true };
      return { content: buffer, toolCalls };
    } catch (err: any) {
      return this.handleError(err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export class ProviderFactory {
  static create(type: string, config: ProviderConfig): LLMProvider {
    switch (type.toLowerCase()) {
      case 'ollama':       return new OllamaProvider(config);
      case 'lmstudio':     return new LMStudioProvider(config);
      case 'google':
      case 'google-ai':    return new GoogleAIRawFetchProvider(config);
      case 'anthropic':    return new AnthropicProvider(config);
      case 'custom':       return new OpenAICompatibleProvider(config, 'Custom');
      default: throw new Error(`Unknown provider type: ${type}`);
    }
  }
}
