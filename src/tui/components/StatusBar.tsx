import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { getTheme } from '../../lib/theme.js';
import type { PermissionMode } from '../../lib/permission-modes.js';
import { getModeLabel, getModeColor } from '../../lib/permission-modes.js';

interface StatusBarProps {
  mode:         PermissionMode;
  modelName?:   string;
  costStr:      string;
  tokenStr:     string;
  effortLevel?: string;
}

const SEP = ' │ ';

export function StatusBar({ mode, modelName, costStr, tokenStr, effortLevel }: StatusBarProps) {
  const theme     = getTheme();
  const { stdout } = useStdout();
  const W         = stdout.columns || 80;

  const modeLabel = getModeLabel(mode) || 'DEFAULT';
  const modeColor = getModeColor(mode);

  // ── Left: colored items (always visible) ──────────────────────────────────
  const leftSegs: Array<{ text: string; color: string; bold?: boolean }> = [];
  leftSegs.push({ text: ` ${modeLabel} `, color: modeColor, bold: true });
  if (modelName) leftSegs.push({ text: modelName, color: theme.primary });
  if (effortLevel && effortLevel !== 'normal') {
    leftSegs.push({ text: `effort:${effortLevel}`, color: theme.warning });
  }

  // ── Right: grey items squished together, truncated as terminal shrinks ────
  const hints =
    W < 70  ? '' :
    W < 100 ? 'tab·ctrl+r' :
              'shift+tab: mode · ctrl+r: think';

  const rightParts: string[] = [];
  if (tokenStr) rightParts.push(tokenStr);
  if (costStr)  rightParts.push(costStr);
  if (hints)    rightParts.push(hints);
  const rightStr = rightParts.join(' · ');

  // Measure left width to know how much right can use.
  const leftWidth = leftSegs.reduce((acc, s, i) => acc + s.text.length + (i > 0 ? SEP.length : 0), 0);
  const rightMax  = Math.max(0, W - leftWidth - 1);
  const rightDisplay = rightStr.slice(0, rightMax);

  return (
    <Box>
      {leftSegs.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text color={theme.subtle}>{SEP}</Text>}
          <Text color={seg.color} bold={seg.bold}>{seg.text}</Text>
        </React.Fragment>
      ))}
      <Box flexGrow={1} />
      {rightDisplay ? <Text color={theme.textDim}>{rightDisplay}</Text> : null}
    </Box>
  );
}
