import * as fs from 'fs';
import type { ChatMessage } from '../providers.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { ConfigManager } from '../config.js';
import type { AgentDefinition } from './agents.js';
import type { PermissionMode } from '../lib/permission-modes.js';

import { defaultToolRegistry } from '../tools.js';
import { ProviderFactory } from '../providers.js';
import { runAgentLoop, type ToolExecutor } from '../lib/agent-loop.js';
import { ConsentManager } from '../lib/consent.js';
import { loadPrompt } from '../lib/prompts.js';
import { loadSoulFiles, loadMemoryFiles, loadProjectContext } from '../lib/context.js';
import { getCwd } from '../lib/cwd.js';
import { saveSession, newId } from '../lib/session.js';
import { dbgErr } from '../lib/debug.js';
import { loadFromDir, type Skill } from '../lib/skills.js';
import { setActiveSkills, getActiveSkills } from './skill-context.js';
import { ensureDockerAvailable, spawnSandbox, teardownSandbox, type ContainerHandle } from './container.js';
import { buildSandboxedExecutor } from './tool-sandbox.js';

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
export async function runTurn(a: RunTurnArgs): Promise<void> {
  const { text, state, agent, config, adapter, platformId, threadId, formatOutbound } = a;

  if (state.isRunning) {
    await adapter.deliver(platformId, threadId, { text: 'Task in progress. Use /abort to cancel.' }).catch(() => {});
    return;
  }

  state.isRunning = true;
  const ac = new AbortController();
  state.abortCtrl = ac;

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
    await adapter.deliver(platformId, threadId, { text: 'No model configured. Use /config.' }).catch(() => {});
    return;
  }

  const llm = ProviderFactory.create(provider.type, {
    endpoint: provider.endpoint,
    model:    model.id,
    apiKey:   provider.apiKey,
  });

  const systemPrompt   = buildSystemPrompt(agent);
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

  // Opt-in Docker sandbox (P4a). Default: in-process. Set per-agent in agent.json.
  let sandbox: ContainerHandle | null = null;
  let toolExecutor: ToolExecutor | undefined;
  const containerSpec = agent.container;
  const containerDefaults = config.getContainerDefaults();
  if (containerSpec?.enabled && containerDefaults.enabled) {
    const mode = containerSpec.mode ?? 'tools-only';
    if (mode === 'full') {
      clearInterval(typingInterval);
      state.isRunning = false;
      state.abortCtrl = undefined;
      if (overlay.length) setActiveSkills(baselineSkills);
      await adapter.deliver(platformId, threadId, {
        text: "Error: agent.container.mode='full' is planned for P4b — use 'tools-only' for now.",
      }).catch(() => {});
      return;
    }
    if (!(await ensureDockerAvailable(containerDefaults.dockerPath))) {
      clearInterval(typingInterval);
      state.isRunning = false;
      state.abortCtrl = undefined;
      if (overlay.length) setActiveSkills(baselineSkills);
      await adapter.deliver(platformId, threadId, {
        text: 'Error: Docker not available. Install Docker or disable agent.container.enabled.',
      }).catch(() => {});
      return;
    }
    try {
      sandbox = await spawnSandbox(agent, containerDefaults);
    } catch (e: any) {
      clearInterval(typingInterval);
      state.isRunning = false;
      state.abortCtrl = undefined;
      if (overlay.length) setActiveSkills(baselineSkills);
      await adapter.deliver(platformId, threadId, {
        text: `Error: sandbox spawn failed: ${e?.message ?? String(e)}`,
      }).catch(() => {});
      return;
    }
    const baseExec = (name: string, args: any) => defaultToolRegistry.executeTool(name, args);
    toolExecutor = buildSandboxedExecutor(agent, baseExec, sandbox);
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
        onText: async (t) => {
          for (const chunk of formatOutbound(t)) {
            await adapter.deliver(platformId, threadId, { text: chunk }).catch((e) => dbgErr('runTurn.deliver', e));
          }
        },
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
  }
}
