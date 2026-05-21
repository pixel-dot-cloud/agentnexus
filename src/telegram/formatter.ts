import stripAnsi from 'strip-ansi';

const TELEGRAM_MAX_LENGTH = 4096;

export function formatForTelegram(text: string): string[] {
  const clean = stripAnsi(text).trim();
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

  return chunks.filter(c => c.trim().length > 0);
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
  if (name === 'shell_execute') {
    const cmd = typeof args.command === 'string' ? args.command : JSON.stringify(args);
    return `⚙️ \`${cmd.slice(0, 120)}\``;
  }
  if (name === 'file_write') {
    return `📝 Writing: \`${args.path}\``;
  }
  if (name === 'file_read') {
    return `📖 Reading: \`${args.path}\``;
  }
  if (name === 'directory_list') {
    return `📂 Listing: \`${args.path ?? '.'}\``;
  }
  const argsStr = JSON.stringify(args).slice(0, 80);
  return `⚙️ ${name}: ${argsStr}`;
}

export function formatToolResult(name: string, output: string, isError: boolean): string {
  const prefix = isError ? '❌' : '✅';
  if (output.length > 800) {
    return `${prefix} ${name}: (${output.length} chars)`;
  }
  return `${prefix} ${name}: ${output.slice(0, 800)}`;
}
