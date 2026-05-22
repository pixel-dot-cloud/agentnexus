import type { ConfigManager, Provider, BotInstance } from '../config.js';
import { AUTO_MODEL, LOCAL_PROVIDER_TYPES } from '../config.js';
import type { PermissionMode } from './permission-modes.js';

// ── Types ────────────────────────────────────────────────────────────────────
export interface MenuCtx {
  config: ConfigManager;
}

export type MenuResult =
  | { kind: 'back' }
  | { kind: 'message'; text: string }
  | { kind: 'reopen' }   // re-enter same node (e.g., refresh list after edit)
  | { kind: 'stay' };    // no transition

export interface ListNode {
  kind:     'list';
  id:       string;
  label:    string;
  children: (ctx: MenuCtx) => MenuNode[];
}

export interface ActionNode {
  kind:  'action';
  id:    string;
  label: string;
  run:   (ctx: MenuCtx) => Promise<MenuResult>;
}

export interface InputNode {
  kind:        'input';
  id:          string;
  label:       string;
  prompt:      string;
  initial?:    (ctx: MenuCtx) => string;
  parse:       (s: string) => unknown | Error;
  apply:       (ctx: MenuCtx, v: any) => Promise<MenuResult>;
  sensitive?:  boolean;
}

export interface ChoiceNode {
  kind:    'choice';
  id:      string;
  label:   string;
  options: { value: string; label: string }[];
  current: (ctx: MenuCtx) => string;
  apply:   (ctx: MenuCtx, v: string) => Promise<MenuResult>;
}

export interface ToggleNode {
  kind:    'toggle';
  id:      string;
  label:   string;
  current: (ctx: MenuCtx) => boolean;
  apply:   (ctx: MenuCtx, v: boolean) => Promise<MenuResult>;
}

export interface ConfirmNode {
  kind:    'confirm';
  id:      string;
  label:   string;
  prompt:  string;
  run:     (ctx: MenuCtx) => Promise<MenuResult>;
}

export type MenuNode = ListNode | ActionNode | InputNode | ChoiceNode | ToggleNode | ConfirmNode;

// ── Helpers ──────────────────────────────────────────────────────────────────
function maskSecret(v: string): string {
  if (!v) return '(unset)';
  if (v.length > 12) return `${v.slice(0, 4)}***${v.slice(-4)}`;
  return '***';
}

function intParse(s: string): number | Error {
  const n = parseInt(s.trim(), 10);
  if (isNaN(n) || n < 0) return new Error('Enter a non-negative integer.');
  return n;
}

const PROVIDER_TYPES: Provider['type'][] = ['ollama', 'lmstudio', 'anthropic', 'google', 'custom'];
const PERMISSION_MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
const EFFORT_LEVELS = ['low', 'normal', 'high'] as const;

// ── Tree builders ────────────────────────────────────────────────────────────
function providerEditNode(name: string): ListNode {
  return {
    kind:  'list',
    id:    `prov-edit:${name}`,
    label: `Edit ${name}`,
    children: ({ config }) => {
      const p = config.getProviderByName(name);
      if (!p) return [];
      const items: MenuNode[] = [
        {
          kind:      'input',
          id:        'apiKey',
          label:     `API key: ${p.apiKey ? maskSecret(p.apiKey) : '(unset)'}`,
          prompt:    `New API key for ${name} (empty to clear):`,
          parse:     (s) => s,
          sensitive: true,
          apply:     async ({ config }, v: string) => {
            config.updateProvider(name, { apiKey: v });
            return { kind: 'message', text: `API key updated for ${name}.` };
          },
        },
        {
          kind:    'input',
          id:      'endpoint',
          label:   `Endpoint: ${p.endpoint ?? '(unset)'}`,
          prompt:  `New endpoint for ${name}:`,
          initial: () => p.endpoint ?? '',
          parse:   (s) => s.trim(),
          apply:   async ({ config }, v: string) => {
            config.updateProvider(name, { endpoint: v || undefined });
            return { kind: 'message', text: `Endpoint updated for ${name}.` };
          },
        },
        {
          kind:    'input',
          id:      'rename',
          label:   `Rename`,
          prompt:  `New name for ${name}:`,
          initial: () => p.name,
          parse:   (s) => {
            const v = s.trim();
            if (!v) return new Error('Name cannot be empty.');
            return v;
          },
          apply:   async ({ config }, v: string) => {
            const ok = config.updateProvider(name, { name: v });
            if (!ok) return { kind: 'message', text: `Rename failed (name conflict?).` };
            return { kind: 'message', text: `Renamed to ${v}.` };
          },
        },
      ];

      if (p.type === 'custom') {
        items.push({
          kind:    'toggle',
          id:      'listModels',
          label:   `listModels flag (custom): [${p.listModels ? '✓' : ' '}]`,
          current: () => p.listModels === true,
          apply:   async ({ config }, v: boolean) => {
            config.updateProvider(name, { listModels: v });
            return { kind: 'message', text: `listModels = ${v}.` };
          },
        });
      }
      return items;
    },
  };
}

function providerAddNode(): ListNode {
  // Type picker: each option is a small flow node that collects fields then adds.
  return {
    kind:  'list',
    id:    'prov-add',
    label: 'Add provider',
    children: () => PROVIDER_TYPES.map((type) => providerAddFlowFor(type)),
  };
}

function providerAddFlowFor(type: Provider['type']): ActionNode {
  return {
    kind:  'action',
    id:    `prov-add-flow:${type}`,
    label: `Add ${type}`,
    run:   async ({ config }) => {
      // Collect fields via the menu input pipeline by storing draft state inline.
      // CLI/Telegram renderers call this directly via collectProviderFields hook.
      // To keep the schema declarative, expose draft helper instead — see below.
      const cfg = config.getConfig();
      const provName = `${type}-${cfg.providers.length + 1}`;
      const isLocal  = LOCAL_PROVIDER_TYPES.has(type);
      config.addProvider({
        name: provName,
        type,
        endpoint: defaultEndpoint(type),
      });
      if (isLocal && !cfg.activeModel) config.setActiveModel(AUTO_MODEL);
      return {
        kind: 'message',
        text: `Added ${provName} (${type}) with default endpoint. ` +
              `Edit it to set apiKey / endpoint / listModels.`,
      };
    },
  };
}

function defaultEndpoint(type: Provider['type']): string | undefined {
  switch (type) {
    case 'ollama':   return 'http://localhost:11434';
    case 'lmstudio': return 'http://localhost:1234';
    case 'custom':   return undefined;
    default:         return undefined;
  }
}

function providerRemoveNode(): ListNode {
  return {
    kind:  'list',
    id:    'prov-remove',
    label: 'Remove provider',
    children: ({ config }) => config.getConfig().providers.map((p) => ({
      kind:   'confirm',
      id:     `rm:${p.name}`,
      label:  `Remove ${p.name} (${p.type})`,
      prompt: `Remove ${p.name} and all its models?`,
      run:    async ({ config }) => {
        config.removeProvider(p.name);
        return { kind: 'message', text: `Removed ${p.name}.` };
      },
    } satisfies ConfirmNode)),
  };
}

function providersRoot(): ListNode {
  return {
    kind:  'list',
    id:    'providers',
    label: '1. Providers',
    children: ({ config }) => {
      const provs = config.getConfig().providers;
      const dyn: MenuNode[] = provs.map((p) => {
        const marker = p.name === config.getConfig().activeProvider ? '▸ ' : '  ';
        return providerEditNode(p.name) as MenuNode;
        // label gets overridden below via shim
      });
      // Shim labels with active marker
      provs.forEach((p, i) => {
        const node = dyn[i] as ListNode;
        const marker = p.name === config.getConfig().activeProvider ? '▸ ' : '  ';
        dyn[i] = { ...node, label: `${marker}${p.name} (${p.type})` };
      });
      return [
        ...dyn,
        providerAddNode(),
        providerRemoveNode(),
      ];
    },
  };
}

// ── Telegram (bots) ──────────────────────────────────────────────────────────
function botEditNode(name: string): ListNode {
  return {
    kind:  'list',
    id:    `bot-edit:${name}`,
    label: `Edit ${name}`,
    children: ({ config }) => {
      const b = config.getBot(name);
      if (!b) return [];
      const items: MenuNode[] = [
        {
          kind:      'input',
          id:        'botToken',
          label:     `Bot token: ${maskSecret(b.botToken)}`,
          prompt:    `New bot token for ${name}:`,
          parse:     (s) => {
            const v = s.trim();
            if (!v) return new Error('Token cannot be empty.');
            return v;
          },
          sensitive: true,
          apply:     async ({ config }, v: string) => {
            config.updateBot(name, { botToken: v });
            return { kind: 'message', text: `Token updated for ${name}. Restart daemon to apply.` };
          },
        },
        {
          kind:  'list',
          id:    'allowedUsers',
          label: `Allowed users (${b.allowedUsers.length})`,
          children: () => buildAllowedUsersChildren(name),
        },
        {
          kind:    'choice',
          id:      'permMode',
          label:   `Permission mode: ${b.permissionMode ?? 'default'}`,
          options: PERMISSION_MODES.map((m) => ({ value: m, label: m })),
          current: () => b.permissionMode ?? 'default',
          apply:   async ({ config }, v: string) => {
            config.updateBot(name, { permissionMode: v as PermissionMode });
            return { kind: 'message', text: `Permission mode for ${name}: ${v}.` };
          },
        },
        {
          kind:    'input',
          id:      'rename',
          label:   `Rename`,
          prompt:  `New name for bot ${name}:`,
          initial: () => b.name,
          parse:   (s) => {
            const v = s.trim();
            if (!v) return new Error('Name cannot be empty.');
            return v;
          },
          apply:   async ({ config }, v: string) => {
            const ok = config.updateBot(name, { name: v });
            if (!ok) return { kind: 'message', text: `Rename failed.` };
            return { kind: 'message', text: `Renamed to ${v}. Restart daemon to apply.` };
          },
        },
      ];
      return items;
    },
  };
}

function buildAllowedUsersChildren(botName: string): MenuNode[] {
  return [
    {
      kind:   'input',
      id:     'add-user',
      label:  '+ Add user ID',
      prompt: 'Telegram user ID to allow:',
      parse:  (s) => {
        const n = parseInt(s.trim(), 10);
        if (isNaN(n) || n <= 0) return new Error('Enter a positive integer user ID.');
        return n;
      },
      apply:  async ({ config }, v: number) => {
        const ok = config.addAllowedUser(botName, v);
        return { kind: 'message', text: ok ? `Added user ${v}.` : `User ${v} already present.` };
      },
    } satisfies InputNode,
    {
      kind:  'list',
      id:    'remove-user',
      label: '- Remove user',
      children: ({ config }) => {
        const b = config.getBot(botName);
        if (!b) return [];
        return b.allowedUsers.map((uid) => ({
          kind:   'confirm',
          id:     `rm-user:${uid}`,
          label:  String(uid),
          prompt: `Remove user ${uid} from ${botName}?`,
          run:    async ({ config }) => {
            config.removeAllowedUser(botName, uid);
            return { kind: 'message', text: `Removed user ${uid}.` };
          },
        } satisfies ConfirmNode));
      },
    },
  ];
}

function botAddNode(): ActionNode {
  // Like providers: one-shot creation with placeholder token; user edits to fill in.
  return {
    kind:  'action',
    id:    'bot-add',
    label: 'Add bot',
    run:   async ({ config }) => {
      const bots = config.getBots();
      const name = `bot-${bots.length + 1}`;
      const ok = config.addBot({
        name,
        botToken: '',
        allowedUsers: [],
        permissionMode: 'default',
      });
      if (!ok) return { kind: 'message', text: `Failed to add bot (name conflict).` };
      return {
        kind: 'message',
        text: `Added ${name}. Now edit it to set the botToken and allowed users.`,
      };
    },
  };
}

function botRemoveNode(): ListNode {
  return {
    kind:  'list',
    id:    'bot-remove',
    label: 'Remove bot',
    children: ({ config }) => config.getBots().map((b) => ({
      kind:   'confirm',
      id:     `rm-bot:${b.name}`,
      label:  `${b.name} (${maskSecret(b.botToken)})`,
      prompt: `Remove bot ${b.name}?`,
      run:    async ({ config }) => {
        config.removeBot(b.name);
        return { kind: 'message', text: `Removed bot ${b.name}.` };
      },
    } satisfies ConfirmNode)),
  };
}

function telegramRoot(): ListNode {
  return {
    kind:  'list',
    id:    'telegram',
    label: '2. Telegram config',
    children: ({ config }) => {
      const bots = config.getBots();
      const dyn: MenuNode[] = bots.map((b) => {
        const node = botEditNode(b.name) as ListNode;
        return { ...node, label: `  ${b.name} (${maskSecret(b.botToken)})` };
      });
      return [
        ...dyn,
        botAddNode(),
        botRemoveNode(),
      ];
    },
  };
}

// ── General configs ──────────────────────────────────────────────────────────
function generalRoot(): ListNode {
  return {
    kind:  'list',
    id:    'general',
    label: '3. General configs',
    children: ({ config }) => {
      const cfg = config.getConfig();
      const items: MenuNode[] = [
        {
          kind:    'choice',
          id:      'defaultPermMode',
          label:   `Default permission mode: ${config.getDefaultPermissionMode()}`,
          options: PERMISSION_MODES.map((m) => ({ value: m, label: m })),
          current: () => config.getDefaultPermissionMode(),
          apply:   async ({ config }, v: string) => {
            config.setDefaultPermissionMode(v as PermissionMode);
            return { kind: 'message', text: `Default mode: ${v}.` };
          },
        },
        {
          kind:    'toggle',
          id:      'autoUnload',
          label:   `Auto-unload LM Studio model on switch: [${config.getAutoUnload() ? '✓' : ' '}]`,
          current: () => config.getAutoUnload(),
          apply:   async ({ config }, v: boolean) => {
            config.setAutoUnload(v);
            return { kind: 'message', text: `autoUnload = ${v}.` };
          },
        },
        {
          kind:    'input',
          id:      'scrollback',
          label:   `Scrollback: ${config.getScrollback()}`,
          prompt:  'Scrollback lines:',
          initial: () => String(config.getScrollback()),
          parse:   intParse,
          apply:   async ({ config }, v: number) => {
            config.setScrollback(v);
            return { kind: 'message', text: `Scrollback = ${v}.` };
          },
        },
        {
          kind:    'choice',
          id:      'effortLevel',
          label:   `Effort level: ${config.getEffortLevel()}`,
          options: EFFORT_LEVELS.map((e) => ({ value: e, label: e })),
          current: () => config.getEffortLevel(),
          apply:   async ({ config }, v: string) => {
            config.setEffortLevel(v as 'low' | 'normal' | 'high');
            return { kind: 'message', text: `Effort level: ${v}.` };
          },
        },
        {
          kind:    'input',
          id:      'consentTimeout',
          label:   `Consent timeout (sec): ${config.getConsentTimeoutSec()}`,
          prompt:  'Consent timeout in seconds:',
          initial: () => String(config.getConsentTimeoutSec()),
          parse:   intParse,
          apply:   async ({ config }, v: number) => {
            config.setConsentTimeoutSec(v);
            return { kind: 'message', text: `Consent timeout = ${v}s.` };
          },
        },
        {
          kind:    'input',
          id:      'maxToolIter',
          label:   `Max tool iterations: ${config.getMaxToolIter()}`,
          prompt:  'Max tool iterations:',
          initial: () => String(config.getMaxToolIter()),
          parse:   intParse,
          apply:   async ({ config }, v: number) => {
            config.setMaxToolIter(v);
            return { kind: 'message', text: `Max tool iter = ${v}.` };
          },
        },
        {
          kind:    'input',
          id:      'typingInterval',
          label:   `Typing indicator interval (sec): ${config.getTypingIntervalSec()}`,
          prompt:  'Typing indicator interval in seconds:',
          initial: () => String(config.getTypingIntervalSec()),
          parse:   intParse,
          apply:   async ({ config }, v: number) => {
            config.setTypingIntervalSec(v);
            return { kind: 'message', text: `Typing interval = ${v}s.` };
          },
        },
        {
          kind:    'input',
          id:      'toolResultTrunc',
          label:   `Tool result truncation chars: ${config.getToolResultTruncChars()}`,
          prompt:  'Tool result truncation in chars:',
          initial: () => String(config.getToolResultTruncChars()),
          parse:   intParse,
          apply:   async ({ config }, v: number) => {
            config.setToolResultTruncChars(v);
            return { kind: 'message', text: `Tool result trunc = ${v} chars.` };
          },
        },
        {
          kind:  'list',
          id:    'tools',
          label: `Tools enable/disable (${cfg.tools.filter(t => t.enabled).length}/${cfg.tools.length} enabled)`,
          children: ({ config }) => config.getConfig().tools.map((t) => ({
            kind:    'toggle',
            id:      `tool:${t.name}`,
            label:   `[${t.enabled ? '✓' : ' '}] ${t.name} — ${t.description}`,
            current: () => t.enabled,
            apply:   async ({ config }) => {
              config.toggleTool(t.name);
              return { kind: 'reopen' };
            },
          } satisfies ToggleNode)),
        },
        {
          kind:   'confirm',
          id:     'reset',
          label:  'Reset to defaults (keeps providers + bots)',
          prompt: 'Reset general settings to defaults? Providers and bots are kept.',
          run:    async ({ config }) => {
            config.resetToDefaults();
            return { kind: 'message', text: 'General settings reset.' };
          },
        },
      ];
      return items;
    },
  };
}

// ── Container defaults ───────────────────────────────────────────────────────
function credProxyNode(): ListNode {
  return {
    kind:  'list',
    id:    'cred-proxy',
    label: 'Cred-proxy (full mode)',
    children: ({ config }) => {
      const cp = config.getCredProxyConfig();
      return [
        {
          kind:    'toggle',
          id:      'cp-enabled',
          label:   `Enabled: [${cp.enabled ? '✓' : ' '}]`,
          current: () => cp.enabled,
          apply:   async ({ config }, v: boolean) => {
            config.setCredProxyConfig({ enabled: v });
            return { kind: 'message', text: `Cred-proxy enabled = ${v}.` };
          },
        } satisfies ToggleNode,
        {
          kind:    'input',
          id:      'cp-port',
          label:   `Port: ${cp.port}`,
          prompt:  'Cred-proxy port (default 40571):',
          initial: () => String(cp.port),
          parse:   (s) => {
            const n = parseInt(s.trim(), 10);
            if (isNaN(n) || n < 1024 || n > 65535) return new Error('Enter a port between 1024 and 65535.');
            return n;
          },
          apply:   async ({ config }, v: number) => {
            config.setCredProxyConfig({ port: v });
            return { kind: 'message', text: `Cred-proxy port = ${v}. Restart daemon to apply.` };
          },
        } satisfies InputNode,
        {
          kind:    'input',
          id:      'cp-network',
          label:   `Docker network: ${cp.networkName}`,
          prompt:  'Docker network for full-mode containers:',
          initial: () => cp.networkName,
          parse:   (s) => s.trim() || new Error('Network name cannot be empty.'),
          apply:   async ({ config }, v: string) => {
            config.setCredProxyConfig({ networkName: v });
            return { kind: 'message', text: `Network = ${v}.` };
          },
        } satisfies InputNode,
        {
          kind:    'input',
          id:      'cp-image',
          label:   `Runner image: ${cp.runnerImage}`,
          prompt:  'Runner image tag (build with container/build.sh):',
          initial: () => cp.runnerImage,
          parse:   (s) => s.trim() || new Error('Image tag cannot be empty.'),
          apply:   async ({ config }, v: string) => {
            config.setCredProxyConfig({ runnerImage: v });
            return { kind: 'message', text: `Runner image = ${v}.` };
          },
        } satisfies InputNode,
      ];
    },
  };
}

function containerRoot(): ListNode {
  return {
    kind:  'list',
    id:    'container',
    label: '4. Container defaults (opt-in per agent)',
    children: ({ config }) => {
      const c = config.getContainerDefaults();
      return [
        {
          kind:    'toggle',
          id:      'cnt-enabled',
          label:   `Master switch: [${c.enabled ? '✓' : ' '}] (per-agent flag still required)`,
          current: () => c.enabled,
          apply:   async ({ config }, v: boolean) => {
            config.setContainerDefaults({ enabled: v });
            return { kind: 'message', text: `Container master switch = ${v}.` };
          },
        } satisfies ToggleNode,
        {
          kind:    'input',
          id:      'cnt-image',
          label:   `Default image: ${c.defaultImage}`,
          prompt:  'Default Docker image (e.g. node:20-slim):',
          initial: () => c.defaultImage,
          parse:   (s) => s.trim() || new Error('Image cannot be empty.'),
          apply:   async ({ config }, v: string) => {
            config.setContainerDefaults({ defaultImage: v });
            return { kind: 'message', text: `Default image = ${v}.` };
          },
        } satisfies InputNode,
        {
          kind:    'choice',
          id:      'cnt-network',
          label:   `Default network: ${c.defaultNetwork}`,
          options: [{ value: 'none', label: 'none (isolated)' }, { value: 'bridge', label: 'bridge (internet)' }],
          current: () => c.defaultNetwork,
          apply:   async ({ config }, v: string) => {
            config.setContainerDefaults({ defaultNetwork: v as 'none' | 'bridge' });
            return { kind: 'message', text: `Default network = ${v}.` };
          },
        } satisfies ChoiceNode,
        {
          kind:    'input',
          id:      'cnt-cpu',
          label:   `Default CPU limit: ${c.defaultCpuLimit || '(unset)'}`,
          prompt:  'CPU limit (e.g. 0.5, empty to clear):',
          initial: () => c.defaultCpuLimit,
          parse:   (s) => s.trim(),
          apply:   async ({ config }, v: string) => {
            config.setContainerDefaults({ defaultCpuLimit: v });
            return { kind: 'message', text: `CPU limit = ${v || '(unset)'}.` };
          },
        } satisfies InputNode,
        {
          kind:    'input',
          id:      'cnt-mem',
          label:   `Default memory limit: ${c.defaultMemoryLimit || '(unset)'}`,
          prompt:  'Memory limit (e.g. 512m, empty to clear):',
          initial: () => c.defaultMemoryLimit,
          parse:   (s) => s.trim(),
          apply:   async ({ config }, v: string) => {
            config.setContainerDefaults({ defaultMemoryLimit: v });
            return { kind: 'message', text: `Memory limit = ${v || '(unset)'}.` };
          },
        } satisfies InputNode,
        {
          kind:    'input',
          id:      'cnt-docker',
          label:   `Docker binary: ${c.dockerPath}`,
          prompt:  'Docker binary path (default "docker"):',
          initial: () => c.dockerPath,
          parse:   (s) => s.trim() || new Error('Path cannot be empty.'),
          apply:   async ({ config }, v: string) => {
            config.setContainerDefaults({ dockerPath: v });
            return { kind: 'message', text: `Docker path = ${v}.` };
          },
        } satisfies InputNode,
        credProxyNode(),
      ];
    },
  };
}

// ── Root ─────────────────────────────────────────────────────────────────────
export function buildRoot(_config: ConfigManager): ListNode {
  return {
    kind:  'list',
    id:    'root',
    label: 'AgentNexus Config',
    children: () => [
      providersRoot(),
      telegramRoot(),
      generalRoot(),
      containerRoot(),
    ],
  };
}
