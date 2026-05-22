import * as readline from 'readline';
import type {
  ChannelAdapter,
  ChannelCallbacks,
  InboundContext,
  OutboundMessage,
} from './types.js';
import type { ConsentDecision, ConsentRequest } from '../lib/consent.js';
import { ChatState, createState } from '../core/run-turn.js';
import { resolveWiring, fallbackWiring } from '../core/wiring.js';
import { shouldEngage } from '../core/engage.js';
import type { ConfigManager } from '../config.js';

const CHANNEL_TYPE = 'cli';
const PLATFORM_ID  = 'local';

interface PendingConsent {
  resolve: (d: ConsentDecision | false) => void;
  timeout: NodeJS.Timeout;
}

export interface CliAdapterHandle extends ChannelAdapter {
  states: Map<string, ChatState>;
}

export function createCliAdapter(config: ConfigManager): CliAdapterHandle {
  const states          = new Map<string, ChatState>();
  let rl:                readline.Interface | null = null;
  let connected           = false;
  let pendingConsent:     PendingConsent | null = null;
  let consentOptions:     { id: string; key: string; label: string; decision: ConsentDecision | false }[] = [];

  function key(platformId: string, threadId: string | null): string {
    return `${platformId}|${threadId ?? ''}`;
  }

  function getOrCreate(platformId: string, threadId: string | null): ChatState {
    const k = key(platformId, threadId);
    let s = states.get(k);
    if (!s) {
      s = createState(config.getDefaultPermissionMode());
      states.set(k, s);
    }
    return s;
  }

  function writeLine(text: string): void {
    if (!text) return;
    process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
  }

  const adapter: CliAdapterHandle = {
    name:            'cli:local',
    channelType:     CHANNEL_TYPE,
    supportsThreads: false,
    states,

    isConnected() { return connected; },

    async setup(cb: ChannelCallbacks): Promise<void> {
      writeLine('AgentNexus CLI — type to chat, Ctrl+D / Ctrl+C to exit.');
      rl = readline.createInterface({
        input:    process.stdin,
        output:   process.stdout,
        terminal: false,
        prompt:   '> ',
      });
      connected = true;

      rl.on('line', async (rawLine) => {
        const line = rawLine.trim();
        if (!line) { rl?.prompt(); return; }

        // Pending consent? Map letter → decision.
        if (pendingConsent) {
          const choice = consentOptions.find(o => o.key === line.toLowerCase());
          if (choice) {
            clearTimeout(pendingConsent.timeout);
            const resolve = pendingConsent.resolve;
            pendingConsent = null;
            consentOptions = [];
            resolve(choice.decision);
            rl?.prompt();
            return;
          }
          writeLine(`Invalid choice. Pick: ${consentOptions.map(o => o.key).join('/')}`);
          rl?.prompt();
          return;
        }

        const wiring = resolveWiring(CHANNEL_TYPE, PLATFORM_ID, null) ?? fallbackWiring(CHANNEL_TYPE, PLATFORM_ID);
        if (!shouldEngage(line, false, false, wiring.engageMode ?? 'pattern', wiring.engagePattern)) {
          rl?.prompt();
          return;
        }

        const ctx: InboundContext = {
          channelType: CHANNEL_TYPE,
          platformId:  PLATFORM_ID,
          threadId:    null,
          userId:      process.env.USER ?? 'local',
          userName:    process.env.USER ?? 'local',
          adapterId:   'local',
        };

        try {
          await cb.onInbound(ctx, {
            id:        `cli-${Date.now()}`,
            text:      line,
            timestamp: new Date().toISOString(),
            isMention: false,
            isGroup:   false,
          });
        } catch (e: any) {
          writeLine(`Error: ${e?.message ?? e}`);
        }
        rl?.prompt();
      });

      rl.on('close', () => {
        connected = false;
        writeLine('CLI closed.');
        process.exit(0);
      });

      rl.prompt();
    },

    async teardown(): Promise<void> {
      if (rl) { try { rl.close(); } catch {} rl = null; }
      connected = false;
    },

    async deliver(_platformId: string, _threadId: string | null, msg: OutboundMessage): Promise<string | undefined> {
      if (msg.text) writeLine(msg.text);
      if (msg.files?.length) {
        for (const f of msg.files) {
          writeLine(`[file: ${f.filename} — ${f.data.length} bytes; saved to ./${f.filename}]`);
          try { (await import('fs')).writeFileSync(f.filename, f.data); } catch {}
        }
      }
      rl?.prompt();
      return undefined;
    },

    async setTyping(): Promise<void> {
      // No-op — terminal doesn't have typing indicator.
    },

    async askConsent(
      _platformId: string,
      _threadId:   string | null,
      req:         ConsentRequest,
      timeoutMs:   number,
    ): Promise<ConsentDecision | false> {
      consentOptions = [
        { id: 'allow-once',    key: 'a', label: 'Allow once',    decision: 'allow-once'    },
        { id: 'always-tool',   key: 't', label: 'Always tool',   decision: 'always-tool'   },
        { id: 'always-binary', key: 'b', label: 'Always binary', decision: 'always-binary' },
        { id: 'deny',          key: 'd', label: 'Deny',          decision: false           },
      ];
      const argStr = JSON.stringify(req.args, null, 2).slice(0, 300);
      writeLine(`\n🔐 Permission: ${req.toolName}\nArgs: ${argStr}`);
      writeLine(consentOptions.map(o => `  ${o.key}) ${o.label}`).join('\n'));

      return new Promise<ConsentDecision | false>((resolve) => {
        const timeout = setTimeout(() => {
          if (pendingConsent) {
            pendingConsent = null;
            consentOptions = [];
            writeLine('⏱️  Consent timed out — denied.');
            rl?.prompt();
            resolve(false);
          }
        }, timeoutMs);
        pendingConsent = { resolve, timeout };
        rl?.setPrompt(`Choose [${consentOptions.map(o => o.key).join('/')}]> `);
        rl?.prompt();
      });
    },

    getOrCreateState(platformId: string, threadId: string | null): ChatState {
      return getOrCreate(platformId, threadId);
    },

    formatOutbound: (text) => {
      const trimmed = (text ?? '').trim();
      return trimmed ? [trimmed] : [];
    },
    formatToolCall:   (name, args) => `⚙️  ${name}: ${JSON.stringify(args).slice(0, 200)}`,
    formatToolResult: (name, output, isError) => {
      const prefix = isError ? '❌' : '✅';
      const max = config.getToolResultTruncChars();
      if (output.length <= max) return `${prefix} ${name}:\n${output}`;
      return `${prefix} ${name}: (${output.length} chars, showing first ${max})\n${output.slice(0, max)}\n... [truncated]`;
    },
  };

  return adapter;
}
