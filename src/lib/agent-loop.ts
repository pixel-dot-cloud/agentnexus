import type { LLMProvider, ChatMessage, ToolSpec, ToolResult as ProviderToolResult } from '../providers.js';
import { defaultToolRegistry } from '../tools.js';
import { ConsentManager, type ConsentRequest, type ConsentDecision } from './consent.js';
import { computeDiff, colorDiff } from './diff.js';
import { dbgErr } from './debug.js';
import type { TodoItem } from '../tools/TodoTool.js';

const MAX_TOOL_ITER = 200;
const TOOL_BUDGET: Record<string, number> = { todo_write: 20, todo_read: 10 };

export interface AgentLoopCallbacks {
  onText:           (text: string) => Promise<void>;
  onStream:         (chunk: string) => void;
  onToolCall:       (name: string, args: Record<string, unknown>) => Promise<void>;
  onToolResult:     (name: string, output: string, isError: boolean) => Promise<void>;
  onConsentRequest: (req: ConsentRequest) => Promise<ConsentDecision | false>;
  onTodosUpdate:    (items: TodoItem[]) => Promise<void>;
}

export interface AgentLoopResult {
  history: ChatMessage[];
  usage: {
    inputTokens:          number;
    outputTokens:         number;
    cacheReadTokens:      number;
    cacheCreationTokens:  number;
  };
}

export async function runAgentLoop(
  input: string,
  history: ChatMessage[],
  llm: LLMProvider,
  buildToolSpecs: () => ToolSpec[],
  systemPrompt: string,
  consentManager: ConsentManager,
  callbacks: AgentLoopCallbacks,
  signal?: AbortSignal,
): Promise<AgentLoopResult> {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  let currentHistory: ChatMessage[] = [
    ...history,
    { role: 'user', content: input },
  ];

  const sysMsg: ChatMessage[] = systemPrompt
    ? [{ role: 'system', content: systemPrompt }]
    : [];

  const toolCounts = new Map<string, number>();
  let iter = 0;

  try {
    for (iter = 0; iter < MAX_TOOL_ITER; iter++) {
      if (signal?.aborted) break;

      const tools = buildToolSpecs();
      const result = await llm.chat(
        [...sysMsg, ...currentHistory],
        tools,
        chunk => callbacks.onStream(chunk),
        signal,
      );

      if (result.usage) {
        usage.inputTokens          += result.usage.inputTokens;
        usage.outputTokens         += result.usage.outputTokens;
        usage.cacheReadTokens      += result.usage.cacheReadTokens     ?? 0;
        usage.cacheCreationTokens  += result.usage.cacheCreationTokens ?? 0;
      }

      if (result.aborted) break;

      currentHistory = [
        ...currentHistory,
        {
          role: 'assistant',
          content: result.content,
          toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
        },
      ];

      if (result.content) {
        await callbacks.onText(result.content);
      }

      if (!result.toolCalls.length) break;

      // Per-tool budget guard
      let overBudget: string | null = null;
      for (const tc of result.toolCalls) {
        if (!(tc.name in TOOL_BUDGET)) continue;
        const n = (toolCounts.get(tc.name) ?? 0) + 1;
        toolCounts.set(tc.name, n);
        if (n > TOOL_BUDGET[tc.name]) { overBudget = tc.name; break; }
      }
      if (overBudget) break;

      const toolResults: ProviderToolResult[] = [];

      for (const tc of result.toolCalls) {
        // Skill expansion
        if (tc.name === 'invoke_skill') {
          const r = await defaultToolRegistry.executeTool(tc.name, tc.args);
          if (r.success && r.output.startsWith('SKILL_EXPAND:')) {
            const skillPrompt = r.output.slice('SKILL_EXPAND:'.length);
            toolResults.push({
              id: tc.id, name: tc.name,
              output: `Skill "${tc.args.name}" prompt:\n${skillPrompt}`,
              isError: false,
            });
            continue;
          }
          toolResults.push({ id: tc.id, name: tc.name, output: r.output, isError: !r.success });
          continue;
        }

        // Diff for file_write
        let diff: string | undefined;
        if (tc.name === 'file_write' && tc.args.path && tc.args.content) {
          try {
            diff = colorDiff(computeDiff(tc.args.path as string, tc.args.content as string));
          } catch {}
        }

        // Plan-mode hard-block
        if (consentManager.isBlocked(tc.name)) {
          toolResults.push({ id: tc.id, name: tc.name, output: 'Blocked: plan mode', isError: true });
          continue;
        }

        // Consent
        const req = { toolName: tc.name, args: tc.args, diff };
        if (consentManager.needsConsent(tc.name, tc.args)) {
          const decision = await callbacks.onConsentRequest(req);
          if (decision === false || decision === 'deny') {
            toolResults.push({ id: tc.id, name: tc.name, output: 'denied by user', isError: true });
            continue;
          }
          const allowed = consentManager.applyDecision(req, decision);
          if (!allowed) {
            toolResults.push({ id: tc.id, name: tc.name, output: 'denied by user', isError: true });
            continue;
          }
        }

        await callbacks.onToolCall(tc.name, tc.args);

        try {
          const r      = await defaultToolRegistry.executeTool(tc.name, tc.args);
          const output = r.success ? r.output : `Error: ${r.error}`;
          toolResults.push({ id: tc.id, name: tc.name, output, isError: !r.success });
          await callbacks.onToolResult(tc.name, output, !r.success);
        } catch (e: any) {
          const msg = `Tool error: ${e.message ?? String(e)}`;
          toolResults.push({ id: tc.id, name: tc.name, output: msg, isError: true });
          await callbacks.onToolResult(tc.name, msg, true);
        }
      }

      currentHistory = [...currentHistory, { role: 'tool', content: '', toolResults }];
    }
  } catch (e: any) {
    dbgErr('agentLoop.threw', e);
    throw e;
  }

  return { history: currentHistory, usage };
}
