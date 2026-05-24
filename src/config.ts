import * as fs from 'fs';
import * as path from 'path';
import type { PermissionMode } from './lib/permission-modes.js';

export interface Provider {
  name: string;
  type: 'ollama' | 'google' | 'anthropic' | 'lmstudio' | 'custom';
  endpoint?: string;
  apiKey?: string;
  listModels?: boolean;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  memoryEstimate?: string;
}

export interface Tool {
  name: string;
  description: string;
  enabled: boolean;
}

export type BusyMode = 'interrupt' | 'queue';

export interface BotInstance {
  name:            string;
  botToken:        string;
  allowedUsers:    number[];
  permissionMode?: PermissionMode;
  /** True → bot belongs to the pool; managed by AssignBotTool / ReleaseBotTool. */
  pool?:           boolean;
  /**
   * What to do when a message arrives while the agent is already running.
   * 'interrupt' — abort current turn, process new message immediately.
   * 'queue'     — queue the message; send "wait" to abort + clear queue.
   * Overrides telegram.defaults.busyMode.
   */
  busyMode?:       BusyMode;
}

export interface TelegramConfig {
  bots:     BotInstance[];
  defaults?: { permissionMode?: PermissionMode; busyMode?: BusyMode };
}

/** P4c — sweep config (lives under container.sweep). */
export interface SweepConfig {
  /** Default true. */
  enabled?:           boolean;
  /** Sweep tick interval. Default 60. */
  intervalSec?:       number;
  /** Heartbeat stale threshold. Default 120 (4× heartbeat period). */
  staleThresholdSec?: number;
  /** Skip sweep for containers younger than this. Default 30. */
  startupGraceSec?:   number;
}

/** P4b — credential proxy config (lives under container.credProxy). */
export interface CredProxyConfig {
  /** Default true when any agent uses full mode. */
  enabled?:     boolean;
  /** Port to listen on. Default 40571. */
  port?:        number;
  /** Docker network name for full-mode containers. Default 'agentnexus-internal'. */
  networkName?: string;
  /** Runner image tag. Default 'agentnexus-runner:latest'. */
  runnerImage?: string;
}

export interface ContainerDefaults {
  /** Master kill-switch. Default true — per-agent flag still required to opt in. */
  enabled?:            boolean;
  /** Default image for tools-only mode. */
  defaultImage?:       string;
  defaultNetwork?:     'none' | 'bridge';
  defaultCpuLimit?:    string;
  defaultMemoryLimit?: string;
  /** Docker binary path. Default 'docker'. */
  dockerPath?:         string;
  /** P4b — cred-proxy settings. */
  credProxy?:          CredProxyConfig;
  /** P4c — sweep settings. */
  sweep?:              SweepConfig;
}

// Legacy single-bot shape retained only for migration on load.
interface LegacyTelegramConfig {
  botToken:        string;
  allowedUsers:    number[];
  permissionMode?: PermissionMode;
}

export interface AgentNexusConfig {
  activeProvider:           string;
  activeModel:              string;
  providers:                Provider[];
  models:                   Model[];
  tools:                    Tool[];
  scrollback?:              number;
  effortLevel?:             'low' | 'normal' | 'high';

  // Toggleable behavior knobs (all optional with sensible defaults).
  autoUnloadOnModelSwitch?: boolean;
  consentTimeoutSec?:       number;
  maxToolIter?:             number;
  typingIntervalSec?:       number;
  toolResultTruncChars?:    number;

  telegram?:                TelegramConfig;
  container?:               ContainerDefaults;
}

export const DEFAULTS = {
  autoUnloadOnModelSwitch: true,
  consentTimeoutSec:       300,
  maxToolIter:             200,
  typingIntervalSec:       4,
  toolResultTruncChars:    1500,
  scrollback:              5000,
  effortLevel:             'normal' as const,
  defaultPermissionMode:   'default' as PermissionMode,
  container: {
    enabled:            true,
    defaultImage:       'node:20-slim',
    defaultNetwork:     'none' as const,
    defaultCpuLimit:    '',
    defaultMemoryLimit: '',
    dockerPath:         'docker',
    credProxy: {
      enabled:     true,
      port:        40571,
      networkName: 'agentnexus-internal',
      runnerImage: 'agentnexus-runner:latest',
    },
    sweep: {
      enabled:           true,
      intervalSec:       60,
      staleThresholdSec: 120,
      startupGraceSec:   30,
    },
  },
};

const HOME = process.env.HOME || '/home/user';
export const CONFIG_DIR  = path.join(HOME, '.agentnexus');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const LOCAL_PROVIDER_TYPES = new Set<Provider['type']>(['ollama', 'lmstudio', 'custom']);
export const AUTO_MODEL = '__auto__';

function migrateTelegram(raw: any): TelegramConfig | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw.bots)) return raw as TelegramConfig;
  const legacy = raw as LegacyTelegramConfig;
  if (typeof legacy.botToken === 'string' && legacy.botToken) {
    return {
      bots: [{
        name:           'default',
        botToken:       legacy.botToken,
        allowedUsers:   Array.isArray(legacy.allowedUsers) ? legacy.allowedUsers : [],
        permissionMode: legacy.permissionMode ?? 'default',
      }],
      defaults: { permissionMode: legacy.permissionMode ?? 'default' },
    };
  }
  return { bots: [] };
}

export class ConfigManager {
  private config: AgentNexusConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): AgentNexusConfig {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const cfg: AgentNexusConfig = JSON.parse(data);
        cfg.providers = cfg.providers || [];
        cfg.models    = cfg.models    || [];
        cfg.tools     = cfg.tools     || [];
        cfg.telegram  = migrateTelegram(cfg.telegram as any);
        if (!cfg.activeProvider && cfg.providers.length) cfg.activeProvider = cfg.providers[0].name;
        if (!cfg.activeModel    && cfg.models.length)    cfg.activeModel    = cfg.models[0].id;
        return cfg;
      } catch {
        try { fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak'); } catch {}
        process.stderr.write('[agentnexus] Corrupt config — backed up, starting fresh\n');
        return this.getDefaultConfig();
      }
    }
    return this.getDefaultConfig();
  }

  private getDefaultConfig(): AgentNexusConfig {
    return {
      activeProvider: '',
      activeModel: '',
      providers: [],
      models: [],
      tools: [
        { name: 'shell_execute',  description: 'Execute shell commands', enabled: true },
        { name: 'file_read',      description: 'Read files',             enabled: true },
        { name: 'file_write',     description: 'Write files',            enabled: true },
        { name: 'directory_list', description: 'List directory',         enabled: true },
      ],
      scrollback: DEFAULTS.scrollback,
    };
  }

  save(): void {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      }
      const tmp = CONFIG_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }

  getConfig(): AgentNexusConfig { return this.config; }

  // ── Telegram ──────────────────────────────────────────────────────────────
  getTelegramConfig(): TelegramConfig | undefined { return this.config.telegram; }

  setTelegramConfig(tg: TelegramConfig): void {
    this.config.telegram = tg;
    this.save();
  }

  getBots(): BotInstance[] {
    return this.config.telegram?.bots ?? [];
  }

  getBot(name: string): BotInstance | undefined {
    return this.getBots().find(b => b.name === name);
  }

  addBot(bot: BotInstance): boolean {
    if (!this.config.telegram) this.config.telegram = { bots: [] };
    if (this.config.telegram.bots.find(b => b.name === bot.name)) return false;
    this.config.telegram.bots.push(bot);
    this.save();
    return true;
  }

  removeBot(name: string): boolean {
    const bots = this.config.telegram?.bots;
    if (!bots) return false;
    const idx = bots.findIndex(b => b.name === name);
    if (idx < 0) return false;
    bots.splice(idx, 1);
    this.save();
    return true;
  }

  updateBot(name: string, patch: Partial<BotInstance>): boolean {
    const bot = this.getBot(name);
    if (!bot) return false;
    if (patch.name !== undefined)           bot.name           = patch.name;
    if (patch.botToken !== undefined)       bot.botToken       = patch.botToken;
    if (patch.allowedUsers !== undefined)   bot.allowedUsers   = patch.allowedUsers;
    if (patch.permissionMode !== undefined) bot.permissionMode = patch.permissionMode;
    this.save();
    return true;
  }

  addAllowedUser(botName: string, userId: number): boolean {
    const bot = this.getBot(botName);
    if (!bot) return false;
    if (bot.allowedUsers.includes(userId)) return false;
    bot.allowedUsers.push(userId);
    this.save();
    return true;
  }

  removeAllowedUser(botName: string, userId: number): boolean {
    const bot = this.getBot(botName);
    if (!bot) return false;
    const idx = bot.allowedUsers.indexOf(userId);
    if (idx < 0) return false;
    bot.allowedUsers.splice(idx, 1);
    this.save();
    return true;
  }

  setDefaultPermissionMode(mode: PermissionMode): void {
    if (!this.config.telegram) this.config.telegram = { bots: [] };
    this.config.telegram.defaults = { ...(this.config.telegram.defaults ?? {}), permissionMode: mode };
    this.save();
  }

  getDefaultPermissionMode(): PermissionMode {
    return this.config.telegram?.defaults?.permissionMode ?? DEFAULTS.defaultPermissionMode;
  }

  // ── Providers / models ────────────────────────────────────────────────────
  getActiveProvider(): Provider | undefined {
    return this.config.providers.find(p => p.name === this.config.activeProvider);
  }

  getActiveModel(): Model | undefined {
    const id   = this.config.activeModel;
    const prov = this.config.activeProvider;
    if (!id || !prov) return undefined;
    const found = this.config.models.find(m =>
      m.id === id && (id !== AUTO_MODEL || m.provider === prov)
    );
    if (found) return found;
    const provider = this.config.providers.find(p => p.name === prov);
    if (provider && LOCAL_PROVIDER_TYPES.has(provider.type)) {
      return { id, name: id, provider: prov };
    }
    return undefined;
  }

  setActiveProvider(name: string): void {
    this.config.activeProvider = name;
    this.save();
  }

  setActiveModel(id: string): void {
    this.config.activeModel = id;
    this.save();
  }

  setActiveModelById(modelId: string, providerName: string): void {
    this.config.activeModel    = modelId;
    this.config.activeProvider = providerName;
    this.save();
  }

  addProvider(provider: Provider): void {
    if (!this.config.providers.find(p => p.name === provider.name)) {
      this.config.providers.push(provider);
      if (!this.config.activeProvider) this.config.activeProvider = provider.name;
      this.save();
    }
  }

  removeProvider(name: string): boolean {
    const idx = this.config.providers.findIndex(p => p.name === name);
    if (idx < 0) return false;
    this.config.providers.splice(idx, 1);
    this.config.models = this.config.models.filter(m => m.provider !== name);
    if (this.config.activeProvider === name) {
      const next = this.config.providers[0];
      this.config.activeProvider = next?.name ?? '';
      const nextModel = next ? this.config.models.find(m => m.provider === next.name) : undefined;
      this.config.activeModel = nextModel?.id
        ?? (next && LOCAL_PROVIDER_TYPES.has(next.type) ? AUTO_MODEL : '');
    }
    this.save();
    return true;
  }

  updateProvider(name: string, patch: Partial<Provider>): boolean {
    const prov = this.config.providers.find(p => p.name === name);
    if (!prov) return false;
    const oldName = prov.name;
    if (patch.name       !== undefined && patch.name !== oldName) {
      if (this.config.providers.some(p => p.name === patch.name)) return false;
      prov.name = patch.name;
      this.config.models.forEach(m => { if (m.provider === oldName) m.provider = patch.name!; });
      if (this.config.activeProvider === oldName) this.config.activeProvider = patch.name;
    }
    if (patch.type       !== undefined) prov.type       = patch.type;
    if (patch.endpoint   !== undefined) prov.endpoint   = patch.endpoint;
    if (patch.apiKey     !== undefined) {
      if (patch.apiKey === '') delete prov.apiKey;
      else prov.apiKey = patch.apiKey;
    }
    if (patch.listModels !== undefined) prov.listModels = patch.listModels;
    this.save();
    return true;
  }

  addModel(model: Model): boolean {
    const isAuto  = model.id === AUTO_MODEL;
    const dupId   = this.config.models.find(m =>
      m.id === model.id && (!isAuto || m.provider === model.provider)
    );
    if (dupId) return false;
    this.config.models.push(model);
    if (!this.config.activeModel) this.config.activeModel = model.id;
    this.save();
    return true;
  }

  removeModel(id: string, provider?: string): boolean {
    const before = this.config.models.length;
    this.config.models = this.config.models.filter(m =>
      !(m.id === id && (!provider || m.provider === provider))
    );
    if (this.config.models.length === before) return false;
    if (this.config.activeModel === id) {
      this.config.activeModel = this.config.models[0]?.id ?? '';
    }
    this.save();
    return true;
  }

  getEnabledTools(): Tool[] {
    return this.config.tools.filter(t => t.enabled);
  }

  toggleTool(name: string): boolean {
    const t = this.config.tools.find(x => x.name === name);
    if (!t) return false;
    t.enabled = !t.enabled;
    this.save();
    return true;
  }

  getProviderByName(name: string): Provider | undefined {
    return this.config.providers.find(p => p.name === name);
  }

  setProviderApiKey(name: string, key: string | undefined): boolean {
    const prov = this.config.providers.find(p => p.name === name);
    if (!prov) return false;
    if (key === undefined) delete prov.apiKey;
    else prov.apiKey = key;
    this.save();
    return true;
  }

  // ── Toggleable behavior ───────────────────────────────────────────────────
  setAutoUnload(b: boolean): void          { this.config.autoUnloadOnModelSwitch = b; this.save(); }
  getAutoUnload(): boolean                  { return this.config.autoUnloadOnModelSwitch ?? DEFAULTS.autoUnloadOnModelSwitch; }

  setConsentTimeoutSec(n: number): void     { this.config.consentTimeoutSec = n; this.save(); }
  getConsentTimeoutSec(): number            { return this.config.consentTimeoutSec ?? DEFAULTS.consentTimeoutSec; }

  setMaxToolIter(n: number): void           { this.config.maxToolIter = n; this.save(); }
  getMaxToolIter(): number                  { return this.config.maxToolIter ?? DEFAULTS.maxToolIter; }

  setTypingIntervalSec(n: number): void     { this.config.typingIntervalSec = n; this.save(); }
  getTypingIntervalSec(): number            { return this.config.typingIntervalSec ?? DEFAULTS.typingIntervalSec; }

  setToolResultTruncChars(n: number): void  { this.config.toolResultTruncChars = n; this.save(); }
  getToolResultTruncChars(): number         { return this.config.toolResultTruncChars ?? DEFAULTS.toolResultTruncChars; }

  setScrollback(n: number): void            { this.config.scrollback = n; this.save(); }
  getScrollback(): number                   { return this.config.scrollback ?? DEFAULTS.scrollback; }

  setEffortLevel(v: 'low' | 'normal' | 'high'): void { this.config.effortLevel = v; this.save(); }
  getEffortLevel(): 'low' | 'normal' | 'high'        { return this.config.effortLevel ?? DEFAULTS.effortLevel; }

  // ── Container defaults ────────────────────────────────────────────────────
  getContainerDefaults(): Required<Omit<ContainerDefaults, 'credProxy' | 'sweep'>> & {
    credProxy: Required<CredProxyConfig>;
    sweep:     Required<SweepConfig>;
  } {
    const c  = this.config.container ?? {};
    const cp = c.credProxy ?? {};
    const sw = c.sweep ?? {};
    return {
      enabled:            c.enabled            ?? DEFAULTS.container.enabled,
      defaultImage:       c.defaultImage       ?? DEFAULTS.container.defaultImage,
      defaultNetwork:     c.defaultNetwork     ?? DEFAULTS.container.defaultNetwork,
      defaultCpuLimit:    c.defaultCpuLimit    ?? DEFAULTS.container.defaultCpuLimit,
      defaultMemoryLimit: c.defaultMemoryLimit ?? DEFAULTS.container.defaultMemoryLimit,
      dockerPath:         c.dockerPath         ?? DEFAULTS.container.dockerPath,
      credProxy: {
        enabled:     cp.enabled     ?? DEFAULTS.container.credProxy.enabled,
        port:        cp.port        ?? DEFAULTS.container.credProxy.port,
        networkName: cp.networkName ?? DEFAULTS.container.credProxy.networkName,
        runnerImage: cp.runnerImage ?? DEFAULTS.container.credProxy.runnerImage,
      },
      sweep: {
        enabled:           sw.enabled           ?? DEFAULTS.container.sweep.enabled,
        intervalSec:       sw.intervalSec       ?? DEFAULTS.container.sweep.intervalSec,
        staleThresholdSec: sw.staleThresholdSec ?? DEFAULTS.container.sweep.staleThresholdSec,
        startupGraceSec:   sw.startupGraceSec   ?? DEFAULTS.container.sweep.startupGraceSec,
      },
    };
  }

  setContainerDefaults(patch: Partial<ContainerDefaults>): void {
    this.config.container = { ...(this.config.container ?? {}), ...patch };
    this.save();
  }

  getCredProxyConfig(): Required<CredProxyConfig> {
    return this.getContainerDefaults().credProxy;
  }

  setCredProxyConfig(patch: Partial<CredProxyConfig>): void {
    const current = this.config.container?.credProxy ?? {};
    this.config.container = {
      ...(this.config.container ?? {}),
      credProxy: { ...current, ...patch },
    };
    this.save();
  }

  // ── Sweep config (P4c) ────────────────────────────────────────────────────
  getSweepConfig(): Required<SweepConfig> {
    const sw = this.config.container?.sweep ?? {};
    return {
      enabled:           sw.enabled           ?? DEFAULTS.container.sweep.enabled,
      intervalSec:       sw.intervalSec       ?? DEFAULTS.container.sweep.intervalSec,
      staleThresholdSec: sw.staleThresholdSec ?? DEFAULTS.container.sweep.staleThresholdSec,
      startupGraceSec:   sw.startupGraceSec   ?? DEFAULTS.container.sweep.startupGraceSec,
    };
  }

  setSweepConfig(patch: Partial<SweepConfig>): void {
    const current = this.config.container?.sweep ?? {};
    this.config.container = {
      ...(this.config.container ?? {}),
      sweep: { ...current, ...patch },
    };
    this.save();
  }

  resetToDefaults(): void {
    const keepProviders = this.config.providers;
    const keepTelegram  = this.config.telegram;
    const keepActiveP   = this.config.activeProvider;
    const keepActiveM   = this.config.activeModel;
    const keepModels    = this.config.models;
    this.config = this.getDefaultConfig();
    this.config.providers      = keepProviders;
    this.config.telegram       = keepTelegram;
    this.config.activeProvider = keepActiveP;
    this.config.activeModel    = keepActiveM;
    this.config.models         = keepModels;
    this.save();
  }
}
