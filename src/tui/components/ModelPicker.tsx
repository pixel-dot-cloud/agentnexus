import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { getTheme } from '../../lib/theme.js';

export interface ModelPickerEntry {
  kind:         'auto' | 'model' | 'live' | 'header' | 'offline' | 'empty';
  providerName: string;
  modelId?:     string;
  label:        string;
  active:       boolean;
  loaded?:      boolean;
}

interface ModelPickerProps {
  entries:   ModelPickerEntry[];
  loading:   boolean;
  onSelect:  (e: ModelPickerEntry) => void;
  onCancel:  () => void;
}

function isSelectable(e: ModelPickerEntry): boolean {
  return e.kind === 'auto' || e.kind === 'model' || e.kind === 'live';
}

export function ModelPicker({ entries, loading, onSelect, onCancel }: ModelPickerProps) {
  const { stdout } = useStdout();
  const W     = stdout.columns || 80;
  const theme = getTheme();

  const selectableIndices = entries.reduce<number[]>((acc, e, i) => {
    if (isSelectable(e)) acc.push(i);
    return acc;
  }, []);

  const [selIdx, setSelIdx] = useState(0); // index into selectableIndices

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) {
      if (selectableIndices.length) onSelect(entries[selectableIndices[selIdx]]);
      return;
    }
    if (key.upArrow)   setSelIdx(i => (i > 0 ? i - 1 : selectableIndices.length - 1));
    if (key.downArrow) setSelIdx(i => (i < selectableIndices.length - 1 ? i + 1 : 0));
  });

  const sep = '─'.repeat(W);
  const activeEntryIdx = selIdx < selectableIndices.length ? selectableIndices[selIdx] : -1;

  const isEmpty = !loading && entries.every(e => !isSelectable(e));

  return (
    <Box flexDirection="column">
      <Text color={theme.subtle}>{sep}</Text>
      <Box>
        <Text bold color="cyan">❯ </Text>
        <Text color={theme.primary}>Switch model</Text>
        <Text color={theme.textDim}>  (↑↓ select · Enter switch · Esc cancel)</Text>
        {loading && <Text color={theme.textDim}>  fetching…</Text>}
      </Box>
      <Text color={theme.subtle}>{sep}</Text>

      {isEmpty && (
        <Text color={theme.textDim}>No models available. Esc to cancel.</Text>
      )}

      {entries.map((e, i) => {
        if (e.kind === 'header') {
          return (
            <Text key={`h-${i}`} color={theme.subtle}>  {e.label}</Text>
          );
        }
        if (e.kind === 'offline') {
          return (
            <Text key={`off-${i}`} color={theme.textDim}>    {e.label}</Text>
          );
        }
        if (e.kind === 'empty') {
          return (
            <Text key={`em-${i}`} color={theme.textDim}>    {e.label}</Text>
          );
        }

        const selected = i === activeEntryIdx;
        const marker   = e.active ? ' ← active' : '';
        const dim      = e.kind === 'auto';

        let badge = '';
        if (e.loaded === true)  badge = ' \x1b[32m[loaded]\x1b[0m';
        if (e.loaded === false) badge = ' \x1b[2m[not loaded]\x1b[0m';

        return (
          <Box key={`${e.kind}-${e.providerName}-${e.modelId ?? ''}-${i}`}>
            <Text color={selected ? 'cyan' : theme.textDim}>{selected ? '❯ ' : '  '}</Text>
            <Text color={selected ? theme.primary : (dim ? theme.textDim : theme.text ?? theme.primary)}>
              {e.label}
            </Text>
            {badge ? <Text>{badge}</Text> : null}
            {marker ? <Text color={theme.subtle}>{marker}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

export function modelPickerHeight(entries: ModelPickerEntry[], loading: boolean): number {
  const base = 3; // separator + header + separator
  if (!loading && entries.every(e => !isSelectable(e))) return base + 1;
  return base + Math.max(1, entries.length);
}
