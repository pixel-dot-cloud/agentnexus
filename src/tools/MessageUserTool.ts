import { BaseTool, type ToolResult } from '../tools.js';
import type { TurnContext } from '../core/turn-context.js';
import { dbgErr } from '../lib/debug.js';
import { botPool } from '../lib/bot-pool.js';
import { getAdapterByName } from '../channels/registry.js';
import type { ChannelAdapter } from '../channels/types.js';

const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function deliverWithHeader(
  adapter:    ChannelAdapter,
  platformId: string,
  threadId:   string | null,
  displayName: string,
  body:       string,
): Promise<void> {
  if (adapter.channelType === 'telegram') {
    const header = `<b>${htmlEscape(displayName)}</b>\n`;
    const combined = header + htmlEscape(body);
    if (combined.length <= 4096) {
      await adapter.deliver(platformId, threadId, { text: combined, parseMode: 'HTML' });
      return;
    }
    await adapter.deliver(platformId, threadId, { text: `<b>${htmlEscape(displayName)}</b>`, parseMode: 'HTML' });
    await adapter.deliver(platformId, threadId, { text: body });
    return;
  }
  await adapter.deliver(platformId, threadId, { text: `${displayName}:\n${body}` });
}

export class MessageUserTool extends BaseTool {
  name        = 'message_user';
  description = 'Send a message to the human user. By default this goes to the conversation that spawned you. If your owner has bound a pool bot to you (via assign_bot), the message instead goes to the user via that bot. Use for final results, status updates, or follow-up questions.';
  usage       = 'message_user({"text":"Done. Found 3 TODOs in src/lib."})';
  schema = {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Message text to send to the user (max 4000 chars).' },
    },
    required: ['text'],
  };

  constructor(
    private fallbackCtx: TurnContext,
    private displayName: string,
    private agentId?:    string,
  ) { super(); }

  async execute(args: { text: string }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['text'])) {
      return { success: false, output: '', error: 'Missing required argument: text' };
    }
    const body = String(args.text).trim().slice(0, 4000);
    if (!body) return { success: false, output: '', error: 'Empty message' };

    // Prefer bound pool bot if assigned
    if (this.agentId) {
      const botName = botPool.getBoundBot(this.agentId);
      if (botName) {
        const adapter = getAdapterByName(`telegram:${botName}`);
        const chat    = botPool.getUserChat(botName);
        if (adapter && chat) {
          try {
            await deliverWithHeader(adapter, chat, null, this.displayName, body);
            return { success: true, output: 'Delivered via bound bot.' };
          } catch (err: any) {
            dbgErr('MessageUserTool.boundBot', err);
            // fall through to fallback path
          }
        } else if (adapter && !chat) {
          dbgErr('MessageUserTool.noUserChat', new Error(`Bot ${botName} bound but no user chat yet`));
        }
      }
    }

    // Fallback: original spawn conversation
    try {
      await deliverWithHeader(
        this.fallbackCtx.adapter,
        this.fallbackCtx.platformId,
        this.fallbackCtx.threadId,
        this.displayName,
        body,
      );
      return { success: true, output: 'Delivered.' };
    } catch (err: any) {
      dbgErr('MessageUserTool.deliver', err);
      return { success: false, output: '', error: err?.message ?? String(err) };
    }
  }
}
