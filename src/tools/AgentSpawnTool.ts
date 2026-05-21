import { BaseTool } from '../tools.js';
import type { ToolResult, ToolRegistry } from '../tools.js';
import type { ChatMessage, LLMProvider } from '../providers.js';
import type { ConsentManager } from '../lib/consent.js';
import type { HookManager } from '../lib/hooks-manager.js';
import { runSubAgent, type SubAgentEvent, type SubAgentOptions } from '../lib/sub-agent.js';

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
  description = 'Spawn isolated sub-agent. kinds: general (full tools), explore (read-only), fork (inherits parent history). Returns sub-agent final output.';
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

    const id = typeof (globalThis as any).crypto?.randomUUID === 'function'
      ? (globalThis as any).crypto.randomUUID()
      : `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const cfg = this.deps.getConfig?.();
    const parentMessages = args.kind === 'fork' ? cfg?.parentMessages : undefined;

    const opts: SubAgentOptions = {
      task:           args.task,
      kind:           args.kind,
      tools:          args.tools,
      model:          args.model,
      parentMessages,
    };

    const onEvent = this.deps.onAgentEvent;

    try {
      const llm = this.deps.getLLM(args.model);
      const output = await runSubAgent(opts, {
        llm,
        registry: this.deps.registry,
        consent:  this.deps.consent,
        hooks:    this.deps.hooks,
        onEvent,
        id,
      });
      return { success: true, output };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      onEvent?.({ id, type: 'error', data: { message } });
      return { success: false, output: '', error: message };
    }
  }
}
