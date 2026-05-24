import type { ToolCall } from '../providers.js';

// DeepSeek native tool-call special tokens (full-width pipe + low-1/8-block separators).
const CALLS_BEGIN = '<｜tool▁calls▁begin｜>';
const CALLS_END   = '<｜tool▁calls▁end｜>';
const CALL_BEGIN  = '<｜tool▁call▁begin｜>';
const CALL_END    = '<｜tool▁call▁end｜>';
const SEP         = '<｜tool▁sep｜>';
const OUTS_BEGIN  = '<｜tool▁outputs▁begin｜>';
const OUTS_END    = '<｜tool▁outputs▁end｜>';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HAS_TOKENS_RE = new RegExp(
  `${escapeRe(CALLS_BEGIN)}|${escapeRe(CALL_BEGIN)}|${escapeRe(OUTS_BEGIN)}`,
);

function parseOneCall(body: string): { name: string; args: any } | null {
  const sepIdx = body.indexOf(SEP);
  if (sepIdx === -1) return null;
  const afterSep = body.slice(sepIdx + SEP.length);
  const nlIdx = afterSep.indexOf('\n');
  const name = (nlIdx === -1 ? afterSep : afterSep.slice(0, nlIdx)).trim();
  if (!name) return null;
  const rest = nlIdx === -1 ? '' : afterSep.slice(nlIdx + 1);

  const fence = rest.match(/```(?:json)?\s*([\s\S]*?)```/);
  let jsonText: string | null = fence ? fence[1].trim() : null;
  if (!jsonText) {
    const start = rest.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < rest.length; i++) {
        const ch = rest[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { jsonText = rest.slice(start, i + 1); break; }
        }
      }
    }
  }
  if (!jsonText) return null;
  try {
    return { name, args: JSON.parse(jsonText) };
  } catch {
    return null;
  }
}

export interface DeepseekParseResult {
  text:      string;
  toolCalls: ToolCall[];
}

/**
 * Extract DeepSeek-format tool calls embedded in raw assistant text. Returns
 * cleaned text (with tool-call / hallucinated-output blocks stripped) and the
 * parsed tool calls. Idempotent if no DeepSeek tokens are present.
 */
export function parseDeepseekToolCalls(rawText: string): DeepseekParseResult {
  if (!rawText || !HAS_TOKENS_RE.test(rawText)) {
    return { text: rawText, toolCalls: [] };
  }

  const calls: ToolCall[] = [];
  const callRe = new RegExp(
    `${escapeRe(CALL_BEGIN)}([\\s\\S]*?)${escapeRe(CALL_END)}`,
    'g',
  );
  let idx = 0;
  for (const match of rawText.matchAll(callRe)) {
    const parsed = parseOneCall(match[1]);
    if (parsed) {
      calls.push({
        id:   `dsc_${Date.now()}_${idx++}`,
        name: parsed.name,
        args: parsed.args,
      });
    }
  }

  let cleaned = rawText;
  cleaned = cleaned.replace(
    new RegExp(`${escapeRe(CALLS_BEGIN)}[\\s\\S]*?${escapeRe(CALLS_END)}`, 'g'),
    '',
  );
  cleaned = cleaned.replace(
    new RegExp(`${escapeRe(CALL_BEGIN)}[\\s\\S]*?${escapeRe(CALL_END)}`, 'g'),
    '',
  );
  cleaned = cleaned.replace(
    new RegExp(`${escapeRe(OUTS_BEGIN)}[\\s\\S]*?${escapeRe(OUTS_END)}`, 'g'),
    '',
  );
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return { text: cleaned, toolCalls: calls };
}
