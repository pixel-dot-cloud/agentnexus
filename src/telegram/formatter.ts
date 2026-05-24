import stripAnsi from 'strip-ansi';

const TARGET_CHUNK = 1500;
const MAX_CHUNK    = 2800;
const HARD_LIMIT   = 4096;

const DEFAULT_TOOL_RESULT_MAX = 1500;

/**
 * Smart splitter. Priority: paragraph → line → sentence → clause → space.
 * Never splits mid-word. Hard-slices any token > HARD_LIMIT.
 * Each returned chunk is <= HARD_LIMIT.
 */
export function formatForTelegram(text: string): string[] {
  // Collapse 3+ consecutive newlines to 2
  const clean = stripAnsi(text).trim().replace(/\n{3,}/g, '\n\n');
  if (!clean) return [];

  const result: string[] = [];
  let remaining = clean;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK) {
      result.push(remaining);
      break;
    }

    // Search window: from TARGET_CHUNK backwards toward 0 for a nice break,
    // and from TARGET_CHUNK forward to MAX_CHUNK for a fallback break.
    const chunk = findSplitPoint(remaining);
    result.push(chunk);
    remaining = remaining.slice(chunk.length).replace(/^\s+/, '');
  }

  // Hard-slice any chunk that still exceeds HARD_LIMIT (shouldn't happen but safety net)
  const safe: string[] = [];
  for (const chunk of result) {
    if (chunk.length <= HARD_LIMIT) {
      safe.push(chunk);
    } else {
      let pos = 0;
      while (pos < chunk.length) {
        safe.push(chunk.slice(pos, pos + HARD_LIMIT));
        pos += HARD_LIMIT;
      }
    }
  }

  return safe.filter(c => c.trim().length > 0);
}

function findSplitPoint(text: string): string {
  // text.length > MAX_CHUNK guaranteed by caller

  // Try paragraph break within TARGET_CHUNK..MAX_CHUNK window
  const idx = findLastOf(text, '\n\n', TARGET_CHUNK, MAX_CHUNK);
  if (idx !== -1) return text.slice(0, idx);

  // Try line break
  const idxLine = findLastOf(text, '\n', TARGET_CHUNK, MAX_CHUNK);
  if (idxLine !== -1) return text.slice(0, idxLine);

  // Try sentence terminators (". ", "! ", "? ")
  for (const sep of ['. ', '! ', '? ']) {
    const i = findLastOf(text, sep, TARGET_CHUNK, MAX_CHUNK);
    if (i !== -1) return text.slice(0, i + 1); // include the punctuation, drop the space
  }

  // Try clause separators (", ", "; ")
  for (const sep of [', ', '; ']) {
    const i = findLastOf(text, sep, TARGET_CHUNK, MAX_CHUNK);
    if (i !== -1) return text.slice(0, i + 1);
  }

  // Try space
  const idxSpace = findLastOf(text, ' ', TARGET_CHUNK, MAX_CHUNK);
  if (idxSpace !== -1) return text.slice(0, idxSpace);

  // No good break found — hard cap at MAX_CHUNK (never splits mid-codepoint for ASCII;
  // for full Unicode safety we'd walk back from codepoint boundary, but Telegram is UTF-16
  // and grammy handles this — best effort here)
  return text.slice(0, MAX_CHUNK);
}

/** Returns last occurrence of `needle` in text[0..end], that is >= start. -1 if not found. */
function findLastOf(text: string, needle: string, start: number, end: number): number {
  const searchIn = text.slice(0, end);
  const idx = searchIn.lastIndexOf(needle);
  return idx >= start ? idx : -1;
}

// Plain text only — no backticks or Markdown syntax
export function formatToolCall(name: string, args: Record<string, unknown>): string {
  if (name === 'shell_execute') {
    const cmd = typeof args.command === 'string' ? args.command : JSON.stringify(args);
    return `⚙️ shell: ${cmd.slice(0, 200)}`;
  }
  if (name === 'file_write') {
    return `📝 Writing: ${args.path}`;
  }
  if (name === 'file_read') {
    return `📖 Reading: ${args.path}`;
  }
  if (name === 'directory_list') {
    return `📂 Listing: ${args.path ?? '.'}`;
  }
  const argsStr = JSON.stringify(args).slice(0, 200);
  return `⚙️ ${name}: ${argsStr}`;
}

/**
 * Returns null on success (suppress spam).
 * Returns an error string on failure.
 */
export function formatToolResult(
  name: string,
  output: string,
  isError: boolean,
  _maxChars: number = DEFAULT_TOOL_RESULT_MAX,
): string | null {
  if (!isError) return null;
  const msg = output.length <= 300 ? output : output.slice(0, 300) + '… [truncated]';
  return `❌ ${name}: ${msg}`;
}
