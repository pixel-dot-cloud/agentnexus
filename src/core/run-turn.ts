import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ChatMessage } from '../providers.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { ConfigManager } from '../config.js';
import type { AgentDefinition } from './agents.js';
import type { PermissionMode } from '../lib/permission-modes.js';

import { defaultToolRegistry } from '../tools.js';
import { ProviderFactory, AUTO_MODEL } from '../providers.js';
import { runAgentLoop, type ToolExecutor } from '../lib/agent-loop.js';
import { ConsentManager } from '../lib/consent.js';
import { loadPrompt } from '../lib/prompts.js';
import { loadSoulFiles, loadMemoryFiles, loadProjectContext } from '../lib/context.js';
import { getCwd } from '../lib/cwd.js';
import { saveSession, newId } from '../lib/session.js';
import { dbgErr } from '../lib/debug.js';
import { loadFromDir, type Skill } from '../lib/skills.js';
import { setActiveSkills, getActiveSkills } from './skill-context.js';
import {
  ensureDockerAvailable,
  spawnSandbox, teardownSandbox,
  ensureNetworkExists, resolveHostGatewaySpec, checkRunnerImageExists,
  defaultMounts,
  type ContainerHandle,
} from './container.js';
import { buildSandboxedExecutor } from './tool-sandbox.js';
import {
  ensureCredProxyStarted,
  registerAgentToken, revokeAgentToken,
} from './cred-proxy.js';
import { runTurnViaRunner, type RunTurnPayload } from './runner-bridge.js';
import { sweeper } from './sweep.js';
import { pushTurnContext, popTurnContext } from './turn-context.js';
import { agentDisplayName } from './agents.js';
import { subagentRegistry } from '../lib/subagent-registry.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HTML_BODY_LIMIT = 4000;

/**
 * Per-conversation state owned by each adapter (per-platformId / per-threadId).
 * Identical shape across adapters so cross-channel features (cron, admin) can
 * share helpers later.
 */
export interface ChatState {
  history:    ChatMessage[];
  sessionId:  string;
  permMode:   PermissionMode;
  isRunning:  boolean;
  abortCtrl?: AbortController;
}

export function createState(permMode: PermissionMode): ChatState {
  return { history: [], sessionId: newId(), permMode, isRunning: false };
}

/**
 * Build the layered system prompt for a turn.
 *   1. main-agent base prompt (project-bundled).
 *   2. Per-agent overlay file (`system.md`) if present.
 *   3. Soul files — per-agent memoryDir overrides cwd.
 *   4. Memory files — same precedence.
 *   5. Project context (AGENTNEXUS.md if any).
 */
export function buildSystemPrompt(agent: AgentDefinition): string {
  const parts: string[] = [];
  try { parts.push(loadPrompt('main-agent')); } catch {}

  if (agent.systemPath && fs.existsSync(agent.systemPath)) {
    try {
      const overlay = fs.readFileSync(agent.systemPath, 'utf-8').trim();
      if (overlay) parts.push(`<agent>\n${overlay}\n</agent>`);
    } catch {}
  }

  const memRoot = agent.memoryDir ?? getCwd();
  const soul   = loadSoulFiles(memRoot);
  if (soul)    parts.push(`<soul>\n${soul}\n</soul>`);
  const memory = loadMemoryFiles(memRoot);
  if (memory)  parts.push(`<memory>\n${memory}\n</memory>`);
  const ctx    = loadProjectContext();
  if (ctx)     parts.push(ctx);

  return parts.join('\n\n');
}

export interface RunTurnArgs {
  text:       string;
  state:      ChatState;
  agent:      AgentDefinition;
  config:     ConfigManager;
  adapter:    ChannelAdapter;
  platformId: string;
  threadId:   string | null;
  /** Chunk an arbitrary outbound text into adapter-safe pieces. */
  formatOutbound(text: string): string[];
  /** Optional formatter for tool-call announcements; return null to suppress. */
  onToolCallText?(name: string, args: Record<string, unknown>): string | null;
  /** Optional formatter for tool-result announcements; return null to suppress. */
  onToolResultText?(name: string, output: string, isError: boolean): string | null;
}

/**
 * Adapter-agnostic agent turn driver.
 *
 * Sets typing indicator, builds LLM, runs agent loop, delivers chunks via the
 * adapter, persists the session. Channel-specific concerns (consent UI,
 * message chunking, tool-result formatting) come through callbacks.
 */
/**
 * Returns an onText callback that prefixes the first non-empty body with the
 * agent name. For Telegram (html parseMode available) uses HTML bold header;
 * for CLI uses plain `name:\n`. Subsequent chunks stream without prefix.
 */
function makeOnText(
  name: string,
  isTelegram: boolean,
  deliver: (payload: { text: string; parseMode?: string }) => Promise<void>,
  formatOutbound: (text: string) => string[],
): (t: string) => Promise<void> {
  let prefixed = false;
  return async (t: string) => {
    if (!prefixed && t.trim()) {
      prefixed = true;
      if (isTelegram) {
        const header = `<b>${escapeHtml(name)}</b>`;
        const bodyEscaped = escapeHtml(t);
        if (bodyEscaped.length <= HTML_BODY_LIMIT) {
          await deliver({ text: `${header}\n${bodyEscaped}`, parseMode: 'HTML' }).catch(() => {});
        } else {
          await deliver({ text: header, parseMode: 'HTML' }).catch(() => {});
          for (const chunk of formatOutbound(t)) {
            await deliver({ text: chunk }).catch(() => {});
          }
        }
      } else {
        for (const chunk of formatOutbound(`${name}:\n${t}`)) {
          await deliver({ text: chunk }).catch(() => {});
        }
      }
      return;
    }
    for (const chunk of formatOutbound(t)) {
      await deliver({ text: chunk }).catch(() => {});
    }
  };
}

export async function runTurn(a: RunTurnArgs): Promise<void> {
  const { text, state, agent, config, adapter, platformId, threadId, formatOutbound } = a;

  if (state.isRunning) {
    await adapter.deliver(platformId, threadId, { text: 'Task in progress. Use /abort to cancel.' }).catch(() => {});
    return;
  }

  state.isRunning = true;
  const ac = new AbortController();
  state.abortCtrl = ac;

  // F4: push turn context so per-spawn tools (e.g. MessageUserTool) can find it.
  pushTurnContext({ adapter, platformId, threadId, agentName: agent.name });

  await adapter.setTyping?.(platformId, threadId).catch(() => {});
  const typingMs = Math.max(1, config.getTypingIntervalSec()) * 1000;
  const typingInterval = setInterval(() => {
    adapter.setTyping?.(platformId, threadId).catch(() => {});
  }, typingMs);

  // Resolve provider + model — per-agent overrides win over active config.
  const provName = agent.providerName ?? config.getActiveProvider()?.name;
  const provider = provName ? config.getProviderByName(provName) : undefined;
  const models   = config.getConfig().models;
  const model    = agent.modelId
    ? models.find(m => m.id === agent.modelId)
      ?? { id: agent.modelId, name: agent.modelId, provider: provider?.name ?? '' }
    : config.getActiveModel();

  if (!provider || !model) {
    clearInterval(typingInterval);
    state.isRunning = false;
    state.abortCtrl = undefined;
    popTurnContext();
    await adapter.deliver(platformId, threadId, { text: 'No model configured. Use /config.' }).catch(() => {});
    return;
  }

  const llm = ProviderFactory.create(provider.type, {
    endpoint: provider.endpoint,
    model:    model.id,
    apiKey:   provider.apiKey,
  });

  // Build system prompt + inject subagent pending block (F3).
  let systemPrompt = buildSystemPrompt(agent);
  const pending = subagentRegistry.unreadSummary();
  if (pending.length > 0) {
    const lines = pending.map(p => `- ${p.id}: ${p.unread} unread messages`).join('\n');
    systemPrompt += `\n\n<subagent-pending>\n${lines}\n</subagent-pending>`;
  }

  const isTelegram = adapter.channelType === 'telegram';
  const name = agentDisplayName(agent);
  const deliverFn = async (payload: { text: string; parseMode?: string }): Promise<void> => {
    await adapter.deliver(platformId, threadId, payload as any);
  };
  const onTextWithPrefix = makeOnText(name, isTelegram, deliverFn, formatOutbound);

  const consent        = new ConsentManager(() => state.permMode);
  const buildToolSpecs = () => {
    let specs = defaultToolRegistry.getToolSpecs();
    if (agent.toolsEnabled?.length) {
      const allowed = new Set(agent.toolsEnabled);
      specs = specs.filter(s => allowed.has(s.name));
    }
    return specs;
  };

  // Overlay per-agent skills (folder drop). See core/skill-context.ts for race notes.
  const baselineSkills = getActiveSkills();
  let overlay: Skill[] = [];
  if (agent.skillsDir) {
    try { overlay = loadFromDir(agent.skillsDir, 'user'); } catch {}
  }
  if (overlay.length) {
    const seen = new Set<string>();
    const merged: Skill[] = [];
    for (const s of [...baselineSkills, ...overlay]) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      merged.push(s);
    }
    setActiveSkills(merged);
  }

  // Opt-in Docker sandbox (P4a / P4b). Default: in-process. Set per-agent in agent.json.
  let sandbox: ContainerHandle | null = null;
  let toolExecutor: ToolExecutor | undefined;
  const containerSpec = agent.container;
  const containerDefaults = config.getContainerDefaults();

  if (containerSpec?.enabled && containerDefaults.enabled) {
    const mode = containerSpec.mode ?? 'tools-only';

    if (!(await ensureDockerAvailable(containerDefaults.dockerPath))) {
      clearInterval(typingInterval);
      state.isRunning = false;
      state.abortCtrl = undefined;
      if (overlay.length) setActiveSkills(baselineSkills);
      popTurnContext();
      await adapter.deliver(platformId, threadId, {
        text: 'Error: Docker not available. Install Docker or disable agent.container.enabled.',
      }).catch(() => {});
      return;
    }

    if (mode === 'full') {
      // ── P4b: full mode — whole agent loop runs in the runner container ──────
      const credProxy = containerDefaults.credProxy;

      if (!credProxy.enabled) {
        clearInterval(typingInterval);
        state.isRunning = false;
        state.abortCtrl = undefined;
        if (overlay.length) setActiveSkills(baselineSkills);
        popTurnContext();
        await adapter.deliver(platformId, threadId, {
          text: "Error: container.credProxy.enabled is false — cannot use full mode.",
        }).catch(() => {});
        return;
      }

      // Check runner image
      const runnerImage = containerSpec.image ?? credProxy.runnerImage;
      const imageExists = await checkRunnerImageExists(runnerImage, containerDefaults.dockerPath);
      if (!imageExists) {
        clearInterval(typingInterval);
        state.isRunning = false;
        state.abortCtrl = undefined;
        if (overlay.length) setActiveSkills(baselineSkills);
        popTurnContext();
        await adapter.deliver(platformId, threadId, {
          text: `Error: runner image "${runnerImage}" not found. Build it first: bash container/build.sh`,
        }).catch(() => {});
        return;
      }

      // Start cred-proxy (idempotent singleton)
      let proxyPort: number;
      try {
        proxyPort = await ensureCredProxyStarted({
          port: credProxy.port,
          getProviders: () => config.getConfig().providers,
        });
      } catch (e: any) {
        clearInterval(typingInterval);
        state.isRunning = false;
        state.abortCtrl = undefined;
        if (overlay.length) setActiveSkills(baselineSkills);
        popTurnContext();
        await adapter.deliver(platformId, threadId, {
          text: `Error: failed to start cred-proxy: ${e?.message ?? String(e)}`,
        }).catch(() => {});
        return;
      }

      // Ensure network exists
      const networkName = credProxy.networkName;
      try {
        await ensureNetworkExists(networkName, containerDefaults.dockerPath);
      } catch (e: any) {
        clearInterval(typingInterval);
        state.isRunning = false;
        state.abortCtrl = undefined;
        if (overlay.length) setActiveSkills(baselineSkills);
        popTurnContext();
        await adapter.deliver(platformId, threadId, {
          text: `Error: failed to ensure Docker network "${networkName}": ${e?.message ?? String(e)}`,
        }).catch(() => {});
        return;
      }

      // Resolve host-gateway
      const gwSpec = await resolveHostGatewaySpec(containerDefaults.dockerPath);

      // Per-spawn agent token, bound to {agent, provider} for this turn.
      const agentToken = crypto.randomBytes(32).toString('hex');
      registerAgentToken(agentToken, agent.name, provider.name);

      // Provider info
      const proxyBaseUrl = `http://host.docker.internal:${proxyPort}/proxy/${provider.name}`;

      // Tool specs for container (exclude invoke_skill — not supported in full mode)
      const containerToolSpecs = buildToolSpecs().filter(s => s.name !== 'invoke_skill');

      // Mounts
      const specMounts = containerSpec.mounts ?? [];
      const mounts = specMounts.length ? specMounts : defaultMounts(agent);

      // Build consent-checked host tool executor for the bridge
      const hostToolExec = (name: string, args: unknown) =>
        defaultToolRegistry.executeTool(name, args as any);

      // Resolve __auto__ to a concrete model ID on the host before handing off
      // to the runner. The runner uses OpenAICompatibleProvider which can't
      // resolve AUTO_MODEL via the native LM Studio API.
      let resolvedModelId = model.id;
      if (model.id === AUTO_MODEL) {
        try { resolvedModelId = await llm.resolveModel(ac.signal); } catch {}
      }

      const bridgePayload: RunTurnPayload = {
        text,
        history: state.history,
        systemPrompt,
        tools:        containerToolSpecs,
        proxyBaseUrl,
        agentToken,
        modelId:      resolvedModelId,
        providerType: provider.type,
        maxIter:      config.getMaxToolIter(),
      };

      let sweptContainerId: string | null = null;

      try {
        const result = await runTurnViaRunner({
          dockerPath:    containerDefaults.dockerPath,
          runnerImage,
          networkName,
          addHostArg:    gwSpec.addHostArg,
          mounts,
          cpuLimit:      containerSpec.cpuLimit ?? containerDefaults.defaultCpuLimit,
          memoryLimit:   containerSpec.memoryLimit ?? containerDefaults.defaultMemoryLimit,
          payload:       bridgePayload,
          onContainerSpawned: (id) => {
            sweptContainerId = id;
            sweeper.register({
              containerId: id,
              agentName:   agent.name,
              startedAt:   Date.now(),
              onStuck: async (reason) => {
                await adapter.deliver(platformId, threadId, {
                  text: `Agent turn killed: ${reason}`,
                }).catch(() => {});
                ac.abort();
              },
            });
          },
          callbacks: {
            onText: onTextWithPrefix,
            onStream:   () => {},
            onToolCall: async (name, args) => {
              const t = a.onToolCallText?.(name, args);
              if (t) await adapter.deliver(platformId, threadId, { text: t }).catch(() => {});
            },
            onToolResult: async (name, output, isError) => {
              const t = a.onToolResultText?.(name, output, isError);
              if (t) await adapter.deliver(platformId, threadId, { text: t }).catch(() => {});
            },
            onConsentRequest: async (req) => {
              if (adapter.askConsent) {
                return adapter.askConsent(platformId, threadId, req, config.getConsentTimeoutSec() * 1000);
              }
              return false;
            },
            onTodosUpdate: async () => {},
          },
          executeHostTool: hostToolExec,
          consentManager: consent,
          onConsentRequest: async (req) => {
            if (adapter.askConsent) {
              return adapter.askConsent(platformId, threadId, req, config.getConsentTimeoutSec() * 1000);
            }
            return false;
          },
          signal: ac.signal,
        });

        state.history = result.history;
        saveSession({
          id:        state.sessionId,
          createdAt: new Date().toISOString(),
          model:     model.name,
          provider:  provider.name,
          history:   state.history,
        });
      } catch (e: any) {
        dbgErr('runTurn.full.threw', e);
        if (!ac.signal.aborted) {
          await adapter.deliver(platformId, threadId, { text: `Error: ${e.message}` }).catch(() => {});
        }
      } finally {
        clearInterval(typingInterval);
        state.isRunning = false;
        state.abortCtrl = undefined;
        if (overlay.length) setActiveSkills(baselineSkills);
        revokeAgentToken(agentToken);
        if (sweptContainerId) sweeper.unregister(sweptContainerId);
        popTurnContext();
      }
      return;  // full mode handled above; skip standard path below

    } else {
      // ── P4a: tools-only mode ────────────────────────────────────────────────
      try {
        sandbox = await spawnSandbox(agent, containerDefaults);
      } catch (e: any) {
        clearInterval(typingInterval);
        state.isRunning = false;
        state.abortCtrl = undefined;
        if (overlay.length) setActiveSkills(baselineSkills);
        popTurnContext();
        await adapter.deliver(platformId, threadId, {
          text: `Error: sandbox spawn failed: ${e?.message ?? String(e)}`,
        }).catch(() => {});
        return;
      }
      const baseExec = (name: string, args: any) => defaultToolRegistry.executeTool(name, args);
      toolExecutor = buildSandboxedExecutor(agent, baseExec, sandbox);
    }
  }

  try {
    const result = await runAgentLoop(
      text,
      state.history,
      llm,
      buildToolSpecs,
      systemPrompt,
      consent,
      {
        onText: onTextWithPrefix,
        onStream:   () => {},
        onToolCall: async (name, args) => {
          const t = a.onToolCallText?.(name, args);
          if (t) await adapter.deliver(platformId, threadId, { text: t }).catch(() => {});
        },
        onToolResult: async (name, output, isError) => {
          const t = a.onToolResultText?.(name, output, isError);
          if (t) await adapter.deliver(platformId, threadId, { text: t }).catch(() => {});
        },
        onConsentRequest: async (req) => {
          if (adapter.askConsent) {
            return adapter.askConsent(platformId, threadId, req, config.getConsentTimeoutSec() * 1000);
          }
          return false;
        },
        onTodosUpdate: async () => {},
      },
      ac.signal,
      config.getMaxToolIter(),
      toolExecutor,
    );

    state.history = result.history;
    saveSession({
      id:        state.sessionId,
      createdAt: new Date().toISOString(),
      model:     model.name,
      provider:  provider.name,
      history:   state.history,
    });
  } catch (e: any) {
    dbgErr('runTurn.threw', e);
    if (!ac.signal.aborted) {
      await adapter.deliver(platformId, threadId, { text: `Error: ${e.message}` }).catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
    state.isRunning = false;
    state.abortCtrl = undefined;
    if (overlay.length) setActiveSkills(baselineSkills);
    if (sandbox) {
      try { await teardownSandbox(sandbox); } catch (e) { dbgErr('runTurn.teardown', e); }
    }
    popTurnContext();
  }
}
