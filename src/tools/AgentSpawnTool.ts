import { BaseTool } from '../tools.js';
import type { ToolResult, ToolRegistry } from '../tools.js';
import type { ChatMessage, LLMProvider } from '../providers.js';
import type { ConsentManager } from '../lib/consent.js';
import type { HookManager } from '../lib/hooks-manager.js';
import { runSubAgent, type SubAgentEvent, type SubAgentOptions } from '../lib/sub-agent.js';
import { subagentRegistry, MAX_RUNNING_SUBAGENTS, type SubagentSession } from '../lib/subagent-registry.js';
import { currentTurnContext } from '../core/turn-context.js';
import { MessageLeaderTool } from './MessageLeaderTool.js';
import { MessageUserTool } from './MessageUserTool.js';
import { ReadUserMessagesTool } from './ReadUserMessagesTool.js';
import { MessagePeerTool } from './MessagePeerTool.js';

export interface AgentSpawnDeps {
  getLLM:        (model?: string) => LLMProvider;
  getConfig?:    () => { parentMessages?: ChatMessage[] } | undefined;
  consent:       ConsentManager;
  hooks:         HookManager;
  registry:      ToolRegistry;
  onAgentEvent?: (ev: SubAgentEvent) => void;
}

export class AgentSpawnTool extends BaseTool {
  name        = 'agent_spawn';
  description = 'Spawn isolated sub-agent. kinds: general (full tools), explore (read-only), fork (inherits parent history). Returns agentId immediately; agent runs async.';
  usage       = 'agent_spawn({"task":"find all TODOs","kind":"explore"})';
  schema = {
    type: 'object',
    properties: {
      task:  { type: 'string',  description: 'Directive for the sub-agent' },
      kind:  { type: 'string',  enum: ['general', 'explore', 'fork'], description: 'Sub-agent kind' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool name whitelist' },
      model: { type: 'string', description: 'Optional model override' },
    },
    required: ['task', 'kind'],
  };
  readonly requiresConsent = true;

  constructor(private deps: AgentSpawnDeps) {
    super();
  }

  async execute(args: {
    task:   string;
    kind:   'general' | 'explore' | 'fork';
    tools?: string[];
    model?: string;
  }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['task', 'kind'])) {
      return { success: false, output: '', error: 'Missing required arguments: task, kind' };
    }
    if (args.kind !== 'general' && args.kind !== 'explore' && args.kind !== 'fork') {
      return { success: false, output: '', error: `Invalid kind: ${args.kind}` };
    }

    if (subagentRegistry.runningCount() >= MAX_RUNNING_SUBAGENTS) {
      return { success: false, output: '', error: `Max running subagents reached (${MAX_RUNNING_SUBAGENTS})` };
    }

    const id = typeof (globalThis as any).crypto?.randomUUID === 'function'
      ? (globalThis as any).crypto.randomUUID()
      : `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const abort = new AbortController();

    const cfg = this.deps.getConfig?.();
    const parentMessages = args.kind === 'fork' ? cfg?.parentMessages : undefined;

    const session: SubagentSession = {
      id,
      parentId:   undefined,
      task:       args.task,
      kind:       args.kind,
      status:     'running',
      inbox:      [],
      userInbox:  [],
      lastReadAt: Date.now(),
      history:    [],
      startedAt:  Date.now(),
      abort,
    };

    subagentRegistry.register(session);

    const childRegistry = this.deps.registry.clone();

    // Per-spawn tools
    childRegistry.registerTool(
      new MessageLeaderTool((msg) => {
        session.inbox.push(`[from ${session.name ?? id}] ${msg}`);
      }),
    );

    const turnCtx = currentTurnContext();
    if (turnCtx) {
      childRegistry.registerTool(
        new MessageUserTool(turnCtx, session.name ?? `agent:${id.slice(0, 8)}`, id),
      );
    }

    childRegistry.registerTool(new ReadUserMessagesTool(session));
    childRegistry.registerTool(new MessagePeerTool(id));

    const opts: SubAgentOptions = {
      task:           args.task,
      kind:           args.kind,
      tools:          args.tools,
      model:          args.model,
      parentMessages,
    };

    // Fire-and-forget
    (async () => {
      try {
        const llm = this.deps.getLLM(args.model);
        const output = await runSubAgent(opts, {
          llm,
          registry:         childRegistry,
          consent:          this.deps.consent,
          hooks:            this.deps.hooks,
          onEvent:          this.deps.onAgentEvent,
          signal:           abort.signal,
          id,
          onHistoryUpdate:  (h) => { session.history = h; },
        });
        session.result  = output;
        session.status  = 'done';
        session.endedAt = Date.now();
      } catch (err: any) {
        session.error   = err?.message ?? String(err);
        session.status  = err?.message === 'aborted' ? 'aborted' : 'error';
        session.endedAt = Date.now();
      }
    })();

    return { success: true, output: JSON.stringify({ agentId: id, status: 'running' }) };
  }
}
