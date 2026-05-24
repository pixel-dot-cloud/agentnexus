import { BaseTool, type ToolResult } from '../tools.js';

export class MessageLeaderTool extends BaseTool {
  name        = 'message_leader';
  description = 'Send a message to the main agent. Use to report progress, intermediate findings, or to request guidance. Non-blocking. Main agent reads queued messages via check_agent.';
  usage       = 'message_leader({"message":"Found 3 TODOs in src/"})';
  schema = {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to deliver to the main agent (max 4000 chars).' },
    },
    required: ['message'],
  };

  constructor(private onMessage: (msg: string) => void) { super(); }

  async execute(args: { message: string }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['message'])) {
      return { success: false, output: '', error: 'Missing required argument: message' };
    }
    const msg = String(args.message).trim().slice(0, 4000);
    if (!msg) return { success: false, output: '', error: 'Empty message' };
    this.onMessage(msg);
    return { success: true, output: 'Message queued.' };
  }
}
