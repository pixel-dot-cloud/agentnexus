import stripAnsi from 'strip-ansi';

const TELEGRAM_MAX_LENGTH = 4096;
const TOOL_RESULT_MAX = 1500;

export function formatForTelegram(text: string): string[] {
  // C5: collapse 3+ consecutive newlines to 2
  const clean = stripAnsi(text).trim().replace(/\n{3,}/g, '\n\n');
  if (!clean) return [];

  const chunks: string[] = [];
  let current = '';

  for (const line of clean.split('\n')) {
    const addition = current ? '\n' + line : line;
    if ((current + addition).length > TELEGRAM_MAX_LENGTH) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += addition;
    }
  }
  if (current) chunks.push(current);

  // C1: hard-slice any chunk that still exceeds the limit (e.g. minified single line)
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= TELEGRAM_MAX_LENGTH) {
      result.push(chunk);
    } else {
      let pos = 0;
      while (pos < chunk.length) {
        result.push(chunk.slice(pos, pos + TELEGRAM_MAX_LENGTH));
        pos += TELEGRAM_MAX_LENGTH;
      }
    }
  }

  return result.filter(c => c.trim().length > 0);
}

// C2: plain text only — no backticks or Markdown syntax
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

// C3: show first 1500 chars instead of dropping to a char count
// TODO: for output > 4000 chars, consider sending as a .txt document via bot.api.sendDocument
export function formatToolResult(name: string, output: string, isError: boolean): string {
  const prefix = isError ? '❌' : '✅';
  if (output.length <= TOOL_RESULT_MAX) {
    return `${prefix} ${name}:\n${output}`;
  }
  return `${prefix} ${name}: (${output.length} chars, showing first ${TOOL_RESULT_MAX})\n${output.slice(0, TOOL_RESULT_MAX)}\n... [truncated]`;
}
