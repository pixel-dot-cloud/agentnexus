import { BaseTool, type ToolResult } from '../tools.js';
import { botPool } from '../lib/bot-pool.js';

export class ReleaseBotTool extends BaseTool {
  name        = 'release_bot';
  description = 'Release a pool bot from its currently bound subagent, returning it to the available pool.';
  usage       = 'release_bot({"botName":"helper-bot-1"})';
  schema = {
    type: 'object',
    properties: {
      botName: { type: 'string', description: 'Pool bot name to release.' },
    },
    required: ['botName'],
  };

  async execute(args: { botName: string }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['botName'])) {
      return { success: false, output: '', error: 'Missing required argument: botName' };
    }
    if (!botPool.isPoolBot(args.botName)) {
      return { success: false, output: '', error: `Bot "${args.botName}" is not in the pool` };
    }
    if (!botPool.getBoundAgent(args.botName)) {
      return { success: false, output: '', error: `Bot "${args.botName}" is not currently bound` };
    }
    botPool.release(args.botName);
    return { success: true, output: `Released "${args.botName}".` };
  }
}
