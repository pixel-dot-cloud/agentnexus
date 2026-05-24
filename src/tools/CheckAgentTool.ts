import { BaseTool, type ToolResult } from '../tools.js';
import { subagentRegistry } from '../lib/subagent-registry.js';
import type { ChatMessage } from '../providers.js';

function serializeHistory(history: ChatMessage[], maxEntries = 8): unknown[] {
  return history.slice(-maxEntries).map(m => {
    const content = typeof m.content === 'string' && m.content.length > 500
      ? m.content.slice(0, 500) + '…'
      : m.content;
    const out: any = { role: m.role, content };
    if (m.toolCalls?.length) out.toolCalls = m.toolCalls.map(tc => ({ name: tc.name }));
    if (m.toolResults?.length) {
      out.toolResults = m.toolResults.map(tr => ({
        name: tr.name,
        output: `[tool:${tr.name} output:${(tr.output ?? '').length} bytes]`,
        isError: tr.isError,
      }));
    }
    return out;
  });
}

export class CheckAgentTool extends BaseTool {
  name        = 'check_agent';
  description = "Inspect a spawned subagent's status, inbox, and recent history. Pass `since` cursor (nextSince from previous call) for idempotent reads.";
  usage       = 'check_agent({"agentId":"abc123","since":0})';
  schema = {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Subagent id returned by agent_spawn.' },
      since:   { type: 'number', description: 'Inbox index cursor; default 0 (read entire inbox).' },
    },
    required: ['agentId'],
  };

  async execute(args: { agentId: string; since?: number }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['agentId'])) {
      return { success: false, output: '', error: 'Missing required argument: agentId' };
    }
    const s = subagentRegistry.get(args.agentId);
    if (!s) return { success: false, output: '', error: `Unknown agentId: ${args.agentId}` };
    const since = Math.max(0, Math.min(args.since ?? 0, s.inbox.length));
    const inbox = s.inbox.slice(since);
    s.lastReadAt = Date.now();
    const payload = {
      id:            s.id,
      name:          s.name,
      status:        s.status,
      inbox,
      nextSince:     s.inbox.length,
      result:        s.result,
      error:         s.error,
      recentHistory: serializeHistory(s.history),
      startedAt:     s.startedAt,
      endedAt:       s.endedAt,
    };
    return { success: true, output: JSON.stringify(payload) };
  }
}
