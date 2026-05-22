import type { ConsentDecision, ConsentRequest } from '../lib/consent.js';
import type { ChatState } from '../core/run-turn.js';

export interface InboundMessage {
  id:         string;
  text:       string;
  timestamp:  string;
  isMention?: boolean;
  isGroup?:   boolean;
}

export interface OutboundFile {
  filename: string;
  data:     Buffer;
}

export interface OutboundMessage {
  text?:  string;
  files?: OutboundFile[];
}

export interface InboundContext {
  channelType: string;
  platformId:  string;
  threadId:    string | null;
  userId?:     string;
  userName?:   string;
  /** Adapter-specific identifier (e.g. bot name in multi-bot daemon). */
  adapterId?:  string;
}

export interface ChannelCallbacks {
  onInbound(ctx: InboundContext, message: InboundMessage): void | Promise<void>;
}

export interface ChannelAdapter {
  /** Human-readable name (e.g. "telegram:default"). */
  name:            string;
  /** Channel family ("telegram", "discord", "cli", "whatsapp", ...). */
  channelType:     string;
  /** True if the platform uses threads as conversation unit. */
  supportsThreads: boolean;

  setup(cb: ChannelCallbacks): Promise<void>;
  teardown():                  Promise<void>;
  isConnected():               boolean;

  deliver(
    platformId: string,
    threadId:   string | null,
    msg:        OutboundMessage,
  ): Promise<string | undefined>;

  setTyping?(platformId: string, threadId: string | null): Promise<void>;

  /** Channel-specific consent UI. Resolves to chosen ConsentDecision or false (deny). */
  askConsent?(
    platformId: string,
    threadId:   string | null,
    req:        ConsentRequest,
    timeoutMs:  number,
  ): Promise<ConsentDecision | false>;

  /** Per-conversation state lookup (creates on first call). Required so the
   *  shared runTurn driver can fetch state without knowing adapter internals. */
  getOrCreateState(platformId: string, threadId: string | null): ChatState;

  /** Channel-specific outbound chunking. Default = single-string passthrough. */
  formatOutbound?(text: string): string[];
  /** Tool-call announcement formatter. Return null to suppress. */
  formatToolCall?(name: string, args: Record<string, unknown>): string | null;
  /** Tool-result announcement formatter. Return null to suppress. */
  formatToolResult?(name: string, output: string, isError: boolean): string | null;
}

export type ChannelAdapterFactory = () => ChannelAdapter | Promise<ChannelAdapter> | null;
