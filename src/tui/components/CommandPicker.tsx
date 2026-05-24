import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { getTheme } from '../../lib/theme.js';

export interface CommandEntry {
  name:        string;
  description: string;
}

interface CommandPickerProps {
  prefix:   string;   // what the user has typed so far, e.g. "/c"
  entries:  CommandEntry[];
  maxItems: number;   // max rows to show
}

const NAME_COL = 30;

export function CommandPicker({ prefix, entries, maxItems }: CommandPickerProps) {
  const { stdout } = useStdout();
  const W     = stdout.columns || 80;
  const theme = getTheme();

  if (!prefix.startsWith('/') || prefix.length < 2) return null;

  const matches = entries.filter(e => e.name.startsWith(prefix));
  if (!matches.length) return null;

  const visible  = matches.slice(0, maxItems);
  const descW    = Math.max(10, W - NAME_COL - 2);
  const sep      = '─'.repeat(W);

  return (
    <Box flexDirection="column">
      <Text color={theme.subtle}>{sep}</Text>

      <Box>
        <Text bold color="cyan">❯ </Text>
        <Text color={theme.primary}>{prefix}</Text>
        <Text color={theme.textDim}> </Text>
      </Box>

      <Text color={theme.subtle}>{sep}</Text>

      {visible.map((cmd, i) => {
        const name = cmd.name.padEnd(NAME_COL).slice(0, NAME_COL);
        // wrap description across two lines if needed
        const descFull = cmd.description;
        const line1    = descFull.slice(0, descW - 1);
        const line2    = descFull.length > descW - 1
          ? descFull.slice(descW - 1, (descW - 1) * 2 - 1) + (descFull.length > (descW - 1) * 2 ? '…' : '')
          : null;
        return (
          <React.Fragment key={i}>
            <Box>
              <Text color={theme.primary}>{name}</Text>
              <Text color={theme.textDim}>{line1}</Text>
            </Box>
            {line2 && (
              <Box>
                <Text>{' '.repeat(NAME_COL)}</Text>
                <Text color={theme.textDim}>{line2}</Text>
              </Box>
            )}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

export function pickerHeight(
  prefix: string,
  entries: CommandEntry[],
  maxItems: number,
  columns: number = process.stdout.columns || 80,
): number {
  if (!prefix.startsWith('/') || prefix.length < 2) return 0;
  const matches = entries.filter(e => e.name.startsWith(prefix));
  if (!matches.length) return 0;
  const visible = matches.slice(0, maxItems);
  // 3 chrome rows (sep + prompt + sep) + rows per entry (up to 2 per cmd)
  let rows = 3;
  const descW = Math.max(10, columns - NAME_COL - 2);
  for (const cmd of visible) {
    rows += cmd.description.length > descW - 1 ? 2 : 1;
  }
  return rows;
}
