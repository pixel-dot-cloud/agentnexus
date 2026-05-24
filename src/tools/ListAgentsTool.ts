import { BaseTool, type ToolResult } from '../tools.js';
import { subagentRegistry } from '../lib/subagent-registry.js';

export class ListAgentsTool extends BaseTool {
  name        = 'list_agents';
  description = 'List all spawned subagents (running and recent) with status and unread message counts.';
  usage       = 'list_agents({})';
  schema = { type: 'object', properties: {} };

  async execute(): Promise<ToolResult> {
    const rows = subagentRegistry.list().map(s => ({
      id:        s.id,
      name:      s.name,
      kind:      s.kind,
      status:    s.status,
      unread:    s.inbox.length,
      startedAt: s.startedAt,
      endedAt:   s.endedAt,
    }));
    return { success: true, output: JSON.stringify(rows) };
  }
}
