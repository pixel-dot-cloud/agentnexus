import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { getTheme } from '../../lib/theme.js';

interface HomeScreenProps {
  height:       number;
  modelName:    string;
  providerName: string;
  providerType: string;
  cwd:          string;
  skillCount:   number;
  version:      string;
}

// User-provided NEXUS ASCII art — 44 chars wide.
const LOGO = [
  '███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗',
  '████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝',
  '██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗',
  '██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║',
  '██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║',
  '╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
];

const LOGO_W = Math.max(...LOGO.map(l => l.length));

export function HomeScreen({
  height, modelName, providerName, providerType, cwd, skillCount, version,
}: HomeScreenProps) {
  const { stdout } = useStdout();
  const W     = stdout.columns || 80;
  const theme = getTheme();

  // Logo rows:    │·[innerW chars]·│  → overhead = 4  → innerW = W - 4
  // Two-col rows: │·[lHalf]·│·[rHalf]·│ → overhead = 7  → total cols = W - 7
  const innerW   = W - 4;                          // for logo centering
  const twoColW  = W - 7;                          // for split columns
  const lHalf    = Math.floor(twoColW / 2);
  const rHalf    = twoColW - lHalf;                // absorbs odd-width remainder
  const divider  = '─'.repeat(Math.max(0, lHalf));

  const shortCwd = cwd.replace(process.env.HOME || '', '~');
  const shortCwdTrim = shortCwd.length > lHalf - 4
    ? '…' + shortCwd.slice(-(lHalf - 5))
    : shortCwd;

  const provLabel = `${providerName}${providerType && providerType !== providerName ? ` (${providerType})` : ''}`;

  // Info rows — two-column layout below the logo.
  const leftLines: string[] = [
    '',
    '  ◉ system online',
    `  ◈ ${modelName}`,
    `  ◈ ${provLabel}`,
    `  ◈ ${shortCwdTrim}`,
    '',
    skillCount > 0
      ? `  ◈ ${skillCount} skill${skillCount !== 1 ? 's' : ''} loaded`
      : '  ◈ no skills',
  ];

  const rightLines: string[] = [
    '',
    'Commands',
    '  /model    switch model',
    '  /memory   edit memory',
    '  /soul     set persona',
    '  /plan     plan mode',
    '  /tools    list tools',
    divider,
    'Keyboard',
    '  shift+tab  cycle mode',
    '  ctrl+r     thinking',
    '  ↑↓         history',
  ];

  const titleTag = version ? `agentnexus ${version}` : 'agentnexus';
  const top = '╭─ ' + titleTag + ' ' + '─'.repeat(Math.max(0, W - 5 - titleTag.length)) + '╮';
  const bot = '╰' + '─'.repeat(W - 2) + '╯';

  // Logo rows are full-width (centered); info rows are two-column split.
  const totalLogoRows = LOGO.length + 1; // +1 blank separator
  const infoRows = Math.max(leftLines.length, rightLines.length);
  const totalBody = totalLogoRows + infoRows;
  const bodyRows  = Math.min(totalBody, height - 2);

  // Colour for left info column.
  function lColor(line: string): string {
    if (line.startsWith('  ◉')) return theme.success;
    if (line.startsWith('  ◈')) return theme.textDim;
    return theme.textDim;
  }

  // Colour for right info column.
  function rColor(line: string): string {
    if (line === 'Commands' || line === 'Keyboard') return theme.primary;
    if (line.startsWith('  /'))      return theme.success;
    if (line === divider)            return theme.subtle;
    return theme.textDim;
  }

  const rows: React.ReactElement[] = [];

  for (let i = 0; i < bodyRows; i++) {
    if (i < LOGO.length) {
      // Full-width logo row — center within innerW.
      const pad   = Math.max(0, Math.floor((innerW - LOGO_W) / 2));
      const line  = LOGO[i];
      const rPad  = Math.max(0, innerW - LOGO_W - pad);
      rows.push(
        <Box key={i}>
          <Text color={theme.subtle}>│ </Text>
          <Text>{' '.repeat(pad)}</Text>
          <Text color={theme.primary}>{line}</Text>
          <Text>{' '.repeat(rPad)}</Text>
          <Text color={theme.subtle}> │</Text>
        </Box>,
      );
    } else if (i === LOGO.length) {
      // Blank separator row between logo and info.
      rows.push(
        <Box key={i}>
          <Text color={theme.subtle}>│ </Text>
          <Text>{' '.repeat(innerW)}</Text>
          <Text color={theme.subtle}> │</Text>
        </Box>,
      );
    } else {
      // Two-column info row.
      const ii = i - totalLogoRows;
      const l  = (leftLines[ii]  ?? '').slice(0, lHalf).padEnd(lHalf);
      const r  = (rightLines[ii] ?? '').slice(0, rHalf).padEnd(rHalf);
      rows.push(
        <Box key={i}>
          <Text color={theme.subtle}>│ </Text>
          <Text color={lColor(leftLines[ii] ?? '')}>{l}</Text>
          <Text color={theme.subtle}> │ </Text>
          <Text color={rColor(rightLines[ii] ?? '')}>{r}</Text>
          <Text color={theme.subtle}> │</Text>
        </Box>,
      );
    }
  }

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text color={theme.subtle}>{top}</Text>
      {rows}
      <Text color={theme.subtle}>{bot}</Text>
    </Box>
  );
}
