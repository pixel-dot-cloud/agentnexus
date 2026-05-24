import { BaseTool, type ToolResult } from '../tools.js';
import { subagentRegistry } from '../lib/subagent-registry.js';

export class AbortAgentTool extends BaseTool {
  name        = 'abort_agent';
  description = 'Cancel a running subagent by id.';
  usage       = 'abort_agent({"agentId":"abc123"})';
  schema = {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Subagent id to abort.' },
    },
    required: ['agentId'],
  };

  async execute(args: { agentId: string }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['agentId'])) {
      return { success: false, output: '', error: 'Missing required argument: agentId' };
    }
    const s = subagentRegistry.get(args.agentId);
    if (!s) return { success: false, output: '', error: `Unknown agentId: ${args.agentId}` };
    if (s.status !== 'running') {
      return { success: false, output: '', error: `Agent not running (status: ${s.status})` };
    }
    s.abort.abort();
    return { success: true, output: 'Aborted.' };
  }
}
