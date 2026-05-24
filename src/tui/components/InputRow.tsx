import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { getTheme } from '../../lib/theme.js';

interface InputRowProps {
  disabled:        boolean;
  termFocused?:    boolean;
  onSubmit:        (value: string) => void;
  onCommand:       (cmd: string) => void;
  completions:     string[];
  onInputChange?:  (val: string) => void;
}

export function InputRow({ disabled, termFocused, onSubmit, onCommand, completions, onInputChange }: InputRowProps) {
  const [history,    setHistory]    = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [inputKey,   setInputKey]   = useState(0);
  const [defaultVal, setDefaultVal] = useState('');
  const currentVal                  = useRef('');
  const theme                       = getTheme();

  useInput((_char, key) => {
    if (disabled) return;

    if (key.upArrow && history.length) {
      const idx = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(idx);
      setDefaultVal(history[idx]);
      setInputKey(k => k + 1);
      return;
    }
    if (key.downArrow) {
      const idx = Math.max(historyIdx - 1, -1);
      setHistoryIdx(idx);
      setDefaultVal(idx >= 0 ? history[idx] : '');
      setInputKey(k => k + 1);
      return;
    }
    if (key.tab && currentVal.current.startsWith('/')) {
      const matches = completions.filter(c => c.startsWith(currentVal.current));
      if (matches.length === 1) {
        setDefaultVal(matches[0] + ' ');
        setInputKey(k => k + 1);
      } else if (matches.length > 1) {
        // Advance to longest common prefix
        const prefix = longestCommonPrefix(matches);
        if (prefix.length > currentVal.current.length) {
          setDefaultVal(prefix);
          setInputKey(k => k + 1);
        }
      }
    }
  });

  const handleChange = useCallback((val: string) => {
    currentVal.current = val;
    onInputChange?.(val);
  }, [onInputChange]);

  const handleSubmit = useCallback((val: string) => {
    const trimmed = val.trim();
    if (!trimmed || disabled) return;
    setHistory(prev => [trimmed, ...prev.filter(h => h !== trimmed)].slice(0, 100));
    setHistoryIdx(-1);
    setDefaultVal('');
    setInputKey(k => k + 1);
    currentVal.current = '';
    onInputChange?.('');
    if (trimmed.startsWith('/')) onCommand(trimmed);
    else onSubmit(trimmed);
  }, [disabled, onSubmit, onCommand, onInputChange]);

  return (
    <Box gap={1}>
      <Text bold color="cyan">{'❯'}</Text>
      {termFocused ? (
        <Text color={theme.textDim}>terminal focused — Ctrl+T to return</Text>
      ) : disabled ? (
        <Text color={theme.textDim}>processing...</Text>
      ) : (
        <TextInput
          key={inputKey}
          defaultValue={defaultVal}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder="message or /command..."
        />
      )}
    </Box>
  );
}

function longestCommonPrefix(strs: string[]): string {
  if (!strs.length) return '';
  let prefix = strs[0];
  for (const s of strs.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) return '';
  }
  return prefix;
}
