import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { TerminalManager } from '../../lib/terminal.js';

interface TerminalPanelProps {
  manager: TerminalManager;
  height:  number;
  focused: boolean;
}

export function TerminalPanel({ manager, height, focused }: TerminalPanelProps) {
  const { stdout } = useStdout();
  const [, setTick] = useState(0); // re-render trigger

  // Spawn / resize whenever dimensions change
  useEffect(() => {
    let alive = true;
    const cols = stdout.columns || 80;
    const rows = Math.max(4, height - 2); // subtract border rows
    if (alive) {
      if (!manager.isAlive()) manager.spawn(cols, rows);
      else manager.resize(cols, rows);
    }
    return () => { alive = false; };
  }, [manager, height, stdout.columns]);

  // Subscribe to display updates
  useEffect(() => {
    const fn = () => setTick(t => t + 1);
    manager.addListener(fn);
    return () => manager.removeListener(fn);
  }, [manager]);

  const innerHeight = Math.max(1, height - 2); // subtract border rows
  const allLines    = manager.getLines();
  const visible     = allLines.slice(-innerHeight);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      height={height}
    >
      <Text bold color={focused ? 'cyan' : 'gray'}>
        {focused
          ? ' Terminal [focused — Ctrl+T to return to chat]'
          : ' Terminal [Ctrl+T to focus]'}
      </Text>
      <Box flexDirection="column" overflow="hidden" flexGrow={1}>
        {visible.length === 0
          ? <Text dimColor> (empty — type a command)</Text>
          : visible.map((line, i) => <Text key={i}>{line}</Text>)
        }
      </Box>
    </Box>
  );
}
