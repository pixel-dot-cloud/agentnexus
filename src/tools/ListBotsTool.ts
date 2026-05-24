import { BaseTool, type ToolResult } from '../tools.js';
import { botPool } from '../lib/bot-pool.js';

export class ListBotsTool extends BaseTool {
  name        = 'list_bots';
  description = 'List all Telegram bots configured for this daemon: the main bot(s) plus any pool bots that can be assigned to subagents. Pool bots show status: available (free) or bound (currently attached to an agent, with boundTo: agentId).';
  usage       = 'list_bots({})';
  schema      = { type: 'object', properties: {} };

  async execute(): Promise<ToolResult> {
    return { success: true, output: JSON.stringify(botPool.listAll()) };
  }
}
