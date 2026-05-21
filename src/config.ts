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

export interface TelegramConfig {
  botToken: string;
  allowedUsers: number[];
  permissionMode: PermissionMode;
}

export interface AgentNexusConfig {
  activeProvider: string;
  activeModel:    string;
  providers:      Provider[];
  models:         Model[];
  tools:          Tool[];
  scrollback?:    number;
  effortLevel?:   'low' | 'normal' | 'high';
  telegram?:      TelegramConfig;
}

const HOME = process.env.HOME || '/home/user';
export const CONFIG_DIR  = path.join(HOME, '.agentnexus');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const LOCAL_PROVIDER_TYPES = new Set<Provider['type']>(['ollama', 'lmstudio', 'custom']);
export const AUTO_MODEL = '__auto__';

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
      scrollback: 5000,
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

  getTelegramConfig(): TelegramConfig | undefined { return this.config.telegram; }

  setTelegramConfig(tg: TelegramConfig): void {
    this.config.telegram = tg;
    this.save();
  }

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

  getEnabledTools(): Tool[] {
    return this.config.tools.filter(t => t.enabled);
  }
}
