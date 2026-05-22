import type { EngageMode } from './agents.js';

/**
 * Decide whether the agent should respond to this inbound message.
 *
 *   pattern         — regex test on text; '.' (sentinel) = always match.
 *   mention         — only when adapter signals isMention.
 *   mention-sticky  — mention OR direct message (non-group). Once mentioned in a
 *                     group, follow-ups still need a mention until session-based
 *                     stickiness lands (T3); for now sticky-in-DM is enough.
 */
export function shouldEngage(
  text:      string,
  isMention: boolean,
  isGroup:   boolean,
  mode:      EngageMode,
  pattern?:  string,
): boolean {
  switch (mode) {
    case 'pattern': {
      const p = (pattern ?? '.').trim();
      if (p === '.' || p === '') return true;
      try { return new RegExp(p).test(text); }
      catch { return true; }
    }
    case 'mention':        return isMention;
    case 'mention-sticky': return isMention || !isGroup;
    default:               return false;
  }
}
