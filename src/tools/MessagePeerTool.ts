import { BaseTool, type ToolResult } from '../tools.js';
import { subagentRegistry } from '../lib/subagent-registry.js';

export class MessagePeerTool extends BaseTool {
  name        = 'message_peer';
  description = 'Send a message to a sibling subagent (same parent). Non-blocking; target reads via check_agent.';
  usage       = 'message_peer({"agent_id":"abc123","message":"handoff complete"})';
  schema = {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Target sibling agentId.' },
      message:  { type: 'string', description: 'Message to deliver (max 4000 chars).' },
    },
    required: ['agent_id', 'message'],
  };

  constructor(private senderId: string) { super(); }

  async execute(args: { agent_id: string; message: string }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['agent_id', 'message'])) {
      return { success: false, output: '', error: 'Missing required arguments: agent_id, message' };
    }
    const sender = subagentRegistry.get(this.senderId);
    const target = subagentRegistry.get(args.agent_id);
    if (!target) return { success: false, output: '', error: 'peer not found' };
    if (target.parentId !== sender?.parentId) {
      return {
        success: false,
        output:  '',
        error:   'not a sibling — message_peer only works between agents with the same parent',
      };
    }
    const msg = String(args.message).trim().slice(0, 4000);
    target.inbox.push(`[peer ${sender?.name ?? this.senderId}] ${msg}`);
    return { success: true, output: 'delivered' };
  }
}
