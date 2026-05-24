import { BaseTool, type ToolResult } from '../tools.js';
import type { SubagentSession } from '../lib/subagent-registry.js';

export class ReadUserMessagesTool extends BaseTool {
  name        = 'read_user_messages';
  description = 'Drain new messages from the user that arrived via your bound bot. Pass `since` (the nextSince cursor from the previous call) for idempotent reads. Only available if you are bound to a pool bot via assign_bot. Returns { messages, nextSince }.';
  usage       = 'read_user_messages({"since":0})';
  schema = {
    type: 'object',
    properties: {
      since: { type: 'number', description: 'Inbox cursor index. Default 0 (read all).' },
    },
  };

  constructor(private session: SubagentSession) { super(); }

  async execute(args: { since?: number }): Promise<ToolResult> {
    const inbox = this.session.userInbox ?? [];
    const since = Math.max(0, Math.min(args.since ?? 0, inbox.length));
    const messages = inbox.slice(since);
    return {
      success: true,
      output:  JSON.stringify({ messages, nextSince: inbox.length, boundBot: this.session.boundBotName }),
    };
  }
}
