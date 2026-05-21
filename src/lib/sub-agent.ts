import type { ChatMessage, LLMProvider, ToolSpec } from '../providers.js';
import type { ToolRegistry } from '../tools.js';
import type { ConsentManager } from './consent.js';
import type { HookManager } from './hooks-manager.js';
import { loadPrompt } from './prompts.js';

export interface SubAgentOptions {
  task:            string;
  kind:            'general' | 'explore' | 'fork';
  tools?:          string[];
  model?:          string;
  parentMessages?: ChatMessage[];
}

export interface SubAgentEvent {
  id:    string;
  type:  'start' | 'chunk' | 'tool_call' | 'tool_result' | 'end' | 'error';
  data?: any;
}

export interface SubAgentDeps {
  llm:       LLMProvider;
  registry:  ToolRegistry;
  consent:   ConsentManager;
  hooks:     HookManager;
  signal?:   AbortSignal;
  onEvent?:  (ev: SubAgentEvent) => void;
  id?:       string;
}

export const MAX_SUB_ITER = 10;

const EXPLORE_ALLOWLIST = new Set<string>(['file_read', 'directory_list']);

function isExploreAllowed(name: string): boolean {
  return EXPLORE_ALLOWLIST.has(name);
}

export function subAgentSystemPrompt(kind: SubAgentOptions['kind'], task: string): string {
  try {
    if (kind === 'explore') return loadPrompt('explore', { task });
    if (kind === 'fork')    return loadPrompt('fork',    { task });
  } catch {
    // Fall through to inline default if prompt file is missing.
  }
  return `You are a sub-agent. Complete the directive autonomously. Use tools. Report results concisely at end.\n\nDirective:\n${task}`;
}

export async function runSubAgent(
  opts: SubAgentOptions,
  deps: SubAgentDeps,
): Promise<string> {
  const id = deps.id ?? (typeof (globalThis as any).crypto?.randomUUID === 'function'
    ? (globalThis as any).crypto.randomUUID()
    : `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  const emit = (ev: Omit<SubAgentEvent, 'id'>) => {
    try { deps.onEvent?.({ id, ...ev }); } catch { /* ignore */ }
  };

  emit({ type: 'start', data: { task: opts.task, kind: opts.kind, model: opts.model } });

  const history: ChatMessage[] = [];
  if (opts.kind === 'fork') {
    if (opts.parentMessages?.length) history.push(...opts.parentMessages);
    history.push({ role: 'user', content: opts.task });
  } else {
    history.push({ role: 'system', content: subAgentSystemPrompt(opts.kind, opts.task) });
    history.push({ role: 'user', content: opts.task });
  }

  const toolWhitelist = opts.tools !== undefined ? new Set(opts.tools) : null;

  const filterSpecs = (): ToolSpec[] => {
    return deps.registry.getToolSpecs(t => {
      if (t.name === 'agent_spawn') return false;
      if (opts.kind === 'explore' && !isExploreAllowed(t.name)) return false;
      if (toolWhitelist && !toolWhitelist.has(t.name)) return false;
      return true;
    });
  };

  let finalText = '';

  try {
    for (let iter = 0; iter < MAX_SUB_ITER; iter++) {
      if (deps.signal?.aborted) {
        emit({ type: 'error', data: { message: 'aborted' } });
        break;
      }

      const specs = filterSpecs();
      const result = await deps.llm.chat(
        history,
        specs,
        (text: string) => emit({ type: 'chunk', data: text }),
        deps.signal,
      );

      finalText = result.content || finalText;

      if (result.aborted) {
        emit({ type: 'error', data: { message: 'aborted' } });
        break;
      }

      const toolCalls = result.toolCalls ?? [];
      history.push({
        role: 'assistant',
        content: result.content,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      });

      if (!toolCalls.length) break;

      const toolResults: { id: string; name: string; output: string; isError?: boolean }[] = [];

      for (const tc of toolCalls) {
        if (opts.kind === 'explore' && !isExploreAllowed(tc.name)) {
          const msg = `Tool '${tc.name}' not allowed in explore (read-only) mode.`;
          emit({ type: 'tool_result', data: { name: tc.name, error: msg } });
          toolResults.push({ id: tc.id, name: tc.name, output: msg, isError: true });
          continue;
        }
        if (toolWhitelist && !toolWhitelist.has(tc.name)) {
          const msg = `Tool '${tc.name}' not in sub-agent whitelist.`;
          emit({ type: 'tool_result', data: { name: tc.name, error: msg } });
          toolResults.push({ id: tc.id, name: tc.name, output: msg, isError: true });
          continue;
        }

        emit({ type: 'tool_call', data: { name: tc.name, args: tc.args } });

        const tool = deps.registry.getTool(tc.name);
        if (!tool) {
          const msg = `Tool not found: ${tc.name}`;
          emit({ type: 'tool_result', data: { name: tc.name, error: msg } });
          toolResults.push({ id: tc.id, name: tc.name, output: msg, isError: true });
          continue;
        }

        const ok = await deps.consent.requestConsent({ toolName: tc.name, args: tc.args });
        if (!ok) {
          const msg = `User denied consent for tool: ${tc.name}`;
          emit({ type: 'tool_result', data: { name: tc.name, error: msg } });
          toolResults.push({ id: tc.id, name: tc.name, output: msg, isError: true });
          continue;
        }

        try {
          deps.hooks.run(`PreToolUse:${tc.name}` as const, {
            tool: tc.name,
            args: JSON.stringify(tc.args ?? {}),
          });
        } catch { /* ignore */ }

        let toolOut = '';
        let isError = false;
        try {
          const res = await tool.execute(tc.args);
          toolOut = res.success
            ? (res.output || '(no output)')
            : (res.error || res.output || 'tool failed');
          isError = !res.success;
        } catch (err: any) {
          toolOut = err?.message ?? String(err);
          isError = true;
        }

        try {
          deps.hooks.run(`PostToolUse:${tc.name}` as const, {
            tool:   tc.name,
            args:   JSON.stringify(tc.args ?? {}),
            output: toolOut.slice(0, 2000),
          });
        } catch { /* ignore */ }

        emit({ type: 'tool_result', data: { name: tc.name, output: toolOut, isError } });
        toolResults.push({ id: tc.id, name: tc.name, output: toolOut, isError });
      }

      history.push({ role: 'tool', content: '', toolResults });
    }

    emit({ type: 'end', data: { output: finalText } });
    return finalText;
  } catch (err: any) {
    emit({ type: 'error', data: { message: err?.message ?? String(err) } });
    throw err;
  }
}
