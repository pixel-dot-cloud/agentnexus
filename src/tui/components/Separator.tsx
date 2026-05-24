import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getTheme } from '../../lib/theme.js';
import type { PermissionMode } from '../../lib/permission-modes.js';

interface SeparatorProps {
  thinking?: boolean;
  mode?:     PermissionMode;
}

const FRAMES = ['·', '✱', '✻', '✱', '·'];
const STATIC_FRAME_INDEX = 2; // ✻

export function Separator({ thinking, mode }: SeparatorProps) {
  const { stdout } = useStdout();
  const width      = Math.max(1, stdout.columns || 80);
  const theme      = getTheme();

  const [frame,   setFrame]   = useState<number>(STATIC_FRAME_INDEX);
  const [elapsed, setElapsed] = useState<number>(0);

  useEffect(() => {
    if (!thinking) {
      setFrame(STATIC_FRAME_INDEX);
      return;
    }
    const spin = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length);
    }, 200);
    return () => clearInterval(spin);
  }, [thinking]);

  useEffect(() => {
    if (!thinking) { setElapsed(0); return; }
    const start = Date.now();
    setElapsed(0);
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 250);
    return () => clearInterval(tick);
  }, [thinking]);

  if (thinking) {
    const glyph    = FRAMES[frame];
    const verb     = elapsed > 0 ? 'Brewing' : 'Brewing';
    const timeStr  = elapsed > 0 ? ` for ${elapsed}s` : '';
    const msg = ` \x1b[38;5;105m${glyph}\x1b[0m ${verb}${timeStr} `;
    const visibleLen = ` ${glyph} ${verb}${timeStr} `.length;

    if (width <= visibleLen) {
      return <Box><Text color={theme.subtle}>{msg}</Text></Box>;
    }
    const left  = Math.max(0, Math.floor((width - visibleLen) / 2));
    const right = Math.max(0, width - left - visibleLen);
    return (
      <Box>
        <Text color={theme.subtle}>
          {'─'.repeat(left)}{msg}{'─'.repeat(right)}
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color={theme.subtle}>{'─'.repeat(width)}</Text>
    </Box>
  );
}
