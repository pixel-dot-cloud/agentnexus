import { BaseTool, type ToolResult } from '../tools.js';
import { botPool } from '../lib/bot-pool.js';

export class AssignBotTool extends BaseTool {
  name        = 'assign_bot';
  description = "Bind a pool bot to a subagent. After binding, the subagent's `message_user` calls go through this bot, and incoming user messages to this bot appear in the subagent's user inbox (read with `read_user_messages` from inside the subagent).";
  usage       = 'assign_bot({"agentId":"...","botName":"helper-bot-1"})';
  schema = {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Subagent id returned by agent_spawn.' },
      botName: { type: 'string', description: 'Pool bot name from list_bots.' },
    },
    required: ['agentId', 'botName'],
  };

  async execute(args: { agentId: string; botName: string }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['agentId', 'botName'])) {
      return { success: false, output: '', error: 'Missing required arguments: agentId, botName' };
    }
    const r = botPool.assign(args.botName, args.agentId);
    if (!r.ok) return { success: false, output: '', error: r.error ?? 'assign failed' };
    return { success: true, output: `Bound "${args.botName}" to agent "${args.agentId}".` };
  }
}
