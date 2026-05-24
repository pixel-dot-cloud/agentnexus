import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getTheme } from '../../lib/theme.js';
import type { TodoItem } from '../../tools/TodoTool.js';

export type ToolStatus = 'running' | 'success' | 'error' | 'denied';

export type LogEntry =
  | { type: 'text';             text: string }
  | { type: 'tool';             full: string; expanded: boolean; status?: ToolStatus }
  | { type: 'compact_boundary' }
  | { type: 'todo';             items: TodoItem[] };

const STATUS_DOT: Record<ToolStatus, string> = {
  running: '\x1b[37m●\x1b[0m',   // white
  success: '\x1b[32m●\x1b[0m',   // green
  error:   '\x1b[31m●\x1b[0m',   // red
  denied:  '\x1b[33m●\x1b[0m',   // yellow
};

interface ChatLogProps {
  entries:      LogEntry[];
  height:       number;
  scrollOffset: number;
}

const STATUS_CHAR: Record<string, string> = {
  completed:   '[x]',
  in_progress: '[~]',
  pending:     '[ ]',
};
const PRIORITY_LABEL: Record<string, string> = {
  high: '!',
  medium: ' ',
  low: '-',
};

export function ChatLog({ entries, height, scrollOffset }: ChatLogProps) {
  const { stdout } = useStdout();
  const width      = stdout.columns || 80;
  const theme      = getTheme();

  const visibleLines = useMemo(() => {
    const lines: Array<{ text: string; color?: string; bold?: boolean }> = [];

    const push = (text: string, color?: string, bold = false) =>
      lines.push({ text, color, bold });

    for (const entry of entries) {

      if (entry.type === 'compact_boundary') {
        const fill  = '─'.repeat(Math.max(0, Math.floor((width - 14) / 2)));
        push(`${fill} compacted ${fill}`, theme.subtle);
        continue;
      }

      if (entry.type === 'todo') {
        push('  tasks:', theme.subtle);
        for (const item of entry.items) {
          const st  = STATUS_CHAR[item.status]  ?? '[ ]';
          const pri = PRIORITY_LABEL[item.priority] ?? ' ';
          const color =
            item.status === 'completed'  ? theme.success :
            item.status === 'in_progress'? theme.primary :
            theme.textDim;
          push(`  ${st} ${pri} ${item.content}`, color);
        }
        continue;
      }

      if (entry.type === 'text') {
        for (const l of entry.text.split('\n')) push(l);
        continue;
      }

      // tool entry
      const entryLines = entry.full.split('\n').filter(Boolean);
      const showAll    = entry.expanded || entryLines.length <= 3;
      const head       = showAll ? entryLines : entryLines.slice(0, 3);
      const dot        = STATUS_DOT[entry.status ?? 'success'];

      head.forEach((l, i) => {
        const prefix = i === 0 ? `${dot}  \x1b[90m` : '   \x1b[90m';
        push(`${prefix}${l}\x1b[0m`);
      });

      if (!showAll) {
        const rem = entryLines.length - 3;
        push(`   \x1b[90m↓ +${rem} more lines  Ctrl+O to toggle\x1b[0m`);
      }
    }

    const total = lines.length;
    const end   = Math.max(0, total - scrollOffset);
    const start = Math.max(0, end - height);
    return lines.slice(start, end);
  }, [entries, height, scrollOffset, width, theme]);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visibleLines.map((line, i) => (
        <Text key={i} color={line.color} bold={line.bold}>{line.text}</Text>
      ))}
    </Box>
  );
}
