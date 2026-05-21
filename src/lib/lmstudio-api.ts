import fetch from 'node-fetch';

export interface LmsModel {
  id:           string;
  object?:      string;
  type?:        'llm' | 'embeddings' | 'vlm' | string;
  publisher?:   string;
  arch?:        string;
  display_name?: string;
  size_bytes?:   number;
  quantization?: string;
  state?:       'loaded' | 'not-loaded' | string;
  max_context_length?:    number;
  loaded_context_length?: number;
  instance_id?: string;
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean };
}

export interface LmsListResponse {
  data?:   LmsModel[];   // v0 / openai-compat shape
  models?: any[];        // v1 native shape
}

function normalizeV1(m: any): LmsModel {
  const hasInstances = Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0;
  const explicitState = typeof m.state === 'string' ? m.state : null;
  const loaded = hasInstances || m.loaded === true || explicitState === 'loaded';
  const inst   = hasInstances ? m.loaded_instances[0] : null;
  return {
    id:           m.key ?? m.id ?? m.modelKey ?? m.path ?? '',
    type:         m.type,
    publisher:    m.publisher,
    arch:         m.architecture ?? m.arch,
    display_name: m.display_name ?? m.displayName,
    size_bytes:   m.size_bytes,
    quantization: m.quantization?.name ?? m.quantization,
    state:        loaded ? 'loaded' : (explicitState ?? 'not-loaded'),
    max_context_length:    m.max_context_length,
    loaded_context_length: inst?.config?.context_length ?? inst?.context_length,
    instance_id:  inst?.id,
    capabilities: m.capabilities,
  };
}

function normalizeLegacy(m: any): LmsModel {
  const loaded = m.state === 'loaded' || m.loaded === true || !!m.instance_id;
  return {
    ...m,
    id:    m.id ?? m.key ?? '',
    state: loaded ? 'loaded' : (m.state ?? 'unknown'),
  };
}

// Match a configured model id against an LmsModel from the listing.
// Handles: exact, case-insensitive, publisher-prefix paths ("qwen/qwen3-30b-…"),
// display-name fallback, and key/id swaps across v1/v0/openai-compat shapes.
export function matchLmsModel(storedId: string, candidate: LmsModel): boolean {
  if (!storedId || !candidate) return false;
  const stored = storedId.toLowerCase();
  const candId = (candidate.id || '').toLowerCase();
  if (!candId) return false;
  if (candId === stored) return true;

  const stripPrefix = (s: string) => (s.includes('/') ? s.split('/').slice(1).join('/') : s);
  const storedTail = stripPrefix(stored);
  const candTail   = stripPrefix(candId);

  if (storedTail === candTail) return true;
  if (candId.endsWith('/' + stored) || stored.endsWith('/' + candId)) return true;

  // Variant suffix tolerance: stored may omit quantization/version suffixes
  // present on the LM Studio side, or vice versa.
  //   stored "qwen3-coder-30b"
  //   cand   "qwen/qwen3-coder-30b-a3b-instruct-2507"
  // Match when one tail is a hyphen-bounded prefix of the other.
  const hyphenPrefix = (a: string, b: string) =>
    a === b || (a.startsWith(b) && a[b.length] === '-') || (b.startsWith(a) && b[a.length] === '-');
  if (hyphenPrefix(candTail, storedTail)) return true;
  if (hyphenPrefix(candId, stored)) return true;

  const display = (candidate.display_name || '').toLowerCase();
  if (display && (display === stored || display === storedTail)) return true;
  // Some LM Studio builds expose a hyphen-flat display ("Qwen3 Coder 30B" -> "qwen3 coder 30b")
  const displayFlat = display.replace(/\s+/g, '-');
  if (displayFlat && (displayFlat === stored || displayFlat === storedTail)) return true;

  return false;
}

export interface LmsDownloadStatus {
  id?:           string;
  model?:        string;
  state?:        'downloading' | 'completed' | 'error' | 'queued' | string;
  progress?:     number;          // 0..1
  bytesReceived?: number;
  bytesTotal?:    number;
  detail?:        string;
}

export class LmStudioApi {
  private base:   string;
  private apiKey: string | undefined;

  constructor(endpoint: string | undefined, apiKey?: string) {
    const ep   = endpoint || 'http://localhost:1234/v1/chat/completions';
    this.base  = new URL(ep).origin;
    this.apiKey = apiKey;
  }

  setApiKey(k: string | undefined): void { this.apiKey = k; }
  setEndpoint(ep: string | undefined): void {
    this.base = new URL(ep || 'http://localhost:1234').origin;
  }
  getBase(): string { return this.base; }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  // ── Models list (native v1; falls back to v0 then OpenAI-compat) ────────────
  async listModels(signal?: AbortSignal): Promise<LmsModel[]> {
    const attempts: Array<{ url: string; v1: boolean }> = [
      { url: `${this.base}/api/v1/models`, v1: true  },
      { url: `${this.base}/api/v0/models`, v1: false },
      { url: `${this.base}/v1/models`,     v1: false },
    ];
    let lastErr = '';
    for (const a of attempts) {
      try {
        const r = await fetch(a.url, { headers: this.headers(), signal: signal as any });
        if (r.ok) {
          const j = (await r.json()) as LmsListResponse;
          if (a.v1 && Array.isArray(j.models)) return j.models.map(normalizeV1);
          if (Array.isArray(j.data))           return j.data.map(normalizeLegacy);
          return [];
        }
        lastErr = `${r.status} ${r.statusText}`;
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        lastErr = e.message;
      }
    }
    throw new Error(`LM Studio listModels failed: ${lastErr}`);
  }

  async getLoaded(signal?: AbortSignal): Promise<LmsModel[]> {
    const all = await this.listModels(signal);
    return all.filter(m => m.state === 'loaded');
  }

  // ── Load (native v1; fallback v0; final fallback JIT via chat) ─────────────
  async loadModel(id: string): Promise<{ ok: boolean; detail?: string }> {
    const tryPost = async (url: string, body: unknown) => {
      try {
        const r   = await fetch(url, {
          method: 'POST', headers: this.headers(), body: JSON.stringify(body),
        });
        const txt = await r.text().catch(() => '');
        let parsed: any = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch {}
        const errMsg =
          parsed?.error?.message ?? (typeof parsed?.error === 'string' ? parsed.error : null);
        if (r.ok && !errMsg) return { ok: true as const, body: parsed };
        return {
          ok:     false as const,
          status: r.status,
          text:   errMsg ?? txt.slice(0, 200),
        };
      } catch (e: any) {
        return { ok: false as const, status: 0, text: e.message };
      }
    };

    const r1 = await tryPost(`${this.base}/api/v1/models/load`, { model: id });
    if (r1.ok) return { ok: true };
    const r2 = await tryPost(`${this.base}/api/v0/models/load`, { model: id });
    if (r2.ok) return { ok: true };
    const r3 = await tryPost(`${this.base}/v1/chat/completions`, {
      model: id,
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 1,
      stream: false,
    });
    if (r3.ok) return { ok: true, detail: 'loaded via JIT chat completion' };
    return {
      ok: false,
      detail: `load failed — v1:${r1.status} ${r1.text} | v0:${r2.status} ${r2.text} | JIT:${r3.status} ${r3.text}`,
    };
  }

  // ── Unload (native v1 needs instance_id; fallback v0 takes model) ──────────
  async unloadModel(id: string): Promise<{ ok: boolean; detail?: string }> {
    const tryPost = async (url: string, body: unknown) => {
      try {
        const r   = await fetch(url, {
          method: 'POST', headers: this.headers(), body: JSON.stringify(body),
        });
        const txt = await r.text().catch(() => '');
        let parsed: any = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch {}
        const errMsg =
          parsed?.error?.message ?? (typeof parsed?.error === 'string' ? parsed.error : null);
        if (r.ok && !errMsg) return { ok: true as const };
        return { ok: false as const, status: r.status, text: errMsg ?? txt.slice(0, 200) };
      } catch (e: any) {
        return { ok: false as const, status: 0, text: e.message };
      }
    };

    // v1 native: find instance_id from listing
    let instanceId: string | undefined;
    try {
      const models = await this.listModels();
      const target = models.find(m => m.id === id && m.state === 'loaded');
      instanceId   = target?.instance_id;
    } catch {}

    if (instanceId) {
      const r1 = await tryPost(`${this.base}/api/v1/models/unload`, { instance_id: instanceId });
      if (r1.ok) return { ok: true };
      const r2 = await tryPost(`${this.base}/api/v0/models/unload`, { model: id });
      if (r2.ok) return { ok: true };
      return { ok: false, detail: `unload failed — v1:${r1.status} ${r1.text} | v0:${r2.status} ${r2.text}` };
    }

    const r2 = await tryPost(`${this.base}/api/v0/models/unload`, { model: id });
    if (r2.ok) return { ok: true };
    return { ok: false, detail: `unload failed — no loaded instance for '${id}' | v0:${r2.status} ${r2.text}` };
  }

  // ── Download (native v1) ────────────────────────────────────────────────────
  async downloadModel(id: string): Promise<{ ok: boolean; detail?: string; jobId?: string }> {
    try {
      const r = await fetch(`${this.base}/api/v1/models/download`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: id }),
      });
      const txt = await r.text().catch(() => '');
      if (!r.ok) return { ok: false, detail: `${r.status} ${r.statusText} ${txt.slice(0, 200)}` };
      let jobId: string | undefined;
      try {
        const j = JSON.parse(txt);
        jobId = j.id ?? j.jobId ?? j.downloadId;
      } catch {}
      return { ok: true, jobId, detail: txt.slice(0, 200) };
    } catch (e: any) {
      return { ok: false, detail: e.message };
    }
  }

  // Back-compat alias
  async pullModel(id: string): Promise<{ ok: boolean; detail?: string; jobId?: string }> {
    return this.downloadModel(id);
  }

  // ── Download status (native v1) ─────────────────────────────────────────────
  async downloadStatus(jobId?: string): Promise<LmsDownloadStatus[]> {
    const url = jobId
      ? `${this.base}/api/v1/models/download/status?id=${encodeURIComponent(jobId)}`
      : `${this.base}/api/v1/models/download/status`;
    try {
      const r = await fetch(url, { headers: this.headers() });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`${r.status} ${r.statusText} ${txt.slice(0, 200)}`);
      }
      const j = (await r.json()) as any;
      if (Array.isArray(j)) return j as LmsDownloadStatus[];
      if (Array.isArray(j.data)) return j.data as LmsDownloadStatus[];
      if (Array.isArray(j.jobs)) return j.jobs as LmsDownloadStatus[];
      return j ? [j as LmsDownloadStatus] : [];
    } catch (e: any) {
      throw new Error(`download status failed: ${e.message}`);
    }
  }

  // ── Ping (native v1 list) ───────────────────────────────────────────────────
  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const r = await fetch(`${this.base}/api/v1/models`, { headers: this.headers() });
      if (r.ok) return { ok: true };
      const r2 = await fetch(`${this.base}/v1/models`, { headers: this.headers() });
      return r2.ok
        ? { ok: true, detail: 'fallback /v1/models' }
        : { ok: false, detail: `${r.status} ${r.statusText} / ${r2.status} ${r2.statusText}` };
    } catch (e: any) {
      return { ok: false, detail: e.message };
    }
  }
}
