import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { ConsentRequest, ConsentDecision, isDestructive, firstToken } from '../consent.js';
import { getTheme } from '../../lib/theme.js';
import type { PermissionMode } from '../../lib/permission-modes.js';

interface Option {
  label:    string;
  sublabel: string;
  decision: ConsentDecision;
  letter:   string;
  num:      string;
}

const MAX_DIFF_LINES = 15;
const MAX_ARGS_LINES = 6;

// Binaries we never let users blanket-allow at the "any X command" level,
// even when the current invocation looks benign — too easy to weaponize.
const DESTRUCTIVE_BINARY_BLOCKLIST = new Set(['rm', 'sudo', 'doas', 'dd', 'mkfs', 'chmod', 'chown']);

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function extractCommand(req: ConsentRequest): string {
  const c = (req.args as Record<string, unknown>).command ?? (req.args as Record<string, unknown>).cmd;
  return typeof c === 'string' ? c : '';
}

function buildOptions(req: ConsentRequest): Option[] {
  const opts: Option[] = [];
  const push = (o: Omit<Option, 'letter' | 'num'>) => {
    const num = String(opts.length + 1);
    opts.push({ ...o, letter: num, num });
  };

  push({ label: 'Allow once', sublabel: 'this request only', decision: 'allow-once' });

  if (req.toolName === 'shell_execute') {
    const cmd        = extractCommand(req);
    const destructive = isDestructive(cmd);
    if (!destructive) {
      const shown = truncate(cmd.trim(), 40);
      push({
        label:    'Always allow this exact command',
        sublabel: shown ? `"${shown}"` : 'exact command',
        decision: 'always-exact',
      });
      const bin = firstToken(cmd);
      if (bin && !DESTRUCTIVE_BINARY_BLOCKLIST.has(bin)) {
        push({
          label:    `Always allow any \`${bin}\` command`,
          sublabel: 'session',
          decision: 'always-binary',
        });
      }
    }
  } else {
    push({
      label:    'Always allow this tool (session)',
      sublabel: 'rest of session',
      decision: 'always-tool',
    });
  }

  push({ label: 'Deny', sublabel: 'skip this tool call', decision: 'deny' });
  return opts;
}

export function consentHeight(req: ConsentRequest): number {
  const argLines = JSON.stringify(req.args, null, 2).split('\n').length;
  const argsRows = Math.min(MAX_ARGS_LINES, argLines) + (argLines > MAX_ARGS_LINES ? 1 : 0);
  let diffRows = 0;
  if (req.diff) {
    const dLines = req.diff.split('\n').length;
    diffRows = 1 + Math.min(MAX_DIFF_LINES, dLines) + (dLines > MAX_DIFF_LINES ? 1 : 0) + 1;
  }
  const opts = buildOptions(req);
  const destructiveRow =
    req.toolName === 'shell_execute' && isDestructive(extractCommand(req)) ? 1 : 0;
  return 2 + 1 + 1 + opts.length + destructiveRow + 1 + argsRows + diffRows;
}

interface ConsentPromptProps {
  request: ConsentRequest;
  mode?:   PermissionMode;
  onDecide: (d: ConsentDecision) => void;
}

export function ConsentPrompt({ request, mode, onDecide }: ConsentPromptProps) {
  const { stdout } = useStdout();
  const width      = stdout.columns || 80;
  const [sel, setSel] = useState(0);
  useEffect(() => { setSel(0); }, [request]);
  const theme = getTheme();

  const options = useMemo(() => buildOptions(request), [request]);
  const destructive =
    request.toolName === 'shell_execute' && isDestructive(extractCommand(request));

  const borderColor =
    mode === 'bypassPermissions' ? theme.bypass :
    mode === 'plan'              ? theme.planMode :
    theme.primary;

  useInput((char, key) => {
    if (key.upArrow)   { setSel(s => (s - 1 + options.length) % options.length); return; }
    if (key.downArrow) { setSel(s => (s + 1) % options.length); return; }
    if (key.return)    { onDecide(options[sel].decision); return; }
    const byLetter = options.findIndex(o => o.letter === char);
    if (byLetter !== -1) { onDecide(options[byLetter].decision); return; }
    const byNum = options.findIndex(o => o.num === char);
    if (byNum !== -1) { onDecide(options[byNum].decision); return; }
  });

  const sep = '─'.repeat(width);

  const argsLines  = JSON.stringify(request.args, null, 2).split('\n');
  const argsVis    = argsLines.slice(0, MAX_ARGS_LINES);
  const argsExtra  = argsLines.length - MAX_ARGS_LINES;

  return (
    <Box flexDirection="column">
      <Text color={borderColor}>{sep}</Text>

      <Box paddingLeft={1} gap={1}>
        <Text bold color={theme.warning}>Permission Request</Text>
        <Text bold color={theme.primary}>{request.toolName}</Text>
      </Box>

      <Box flexDirection="column" paddingLeft={1}>
        {argsVis.map((line, i) => <Text key={i} color={theme.textDim}>{line}</Text>)}
        {argsExtra > 0 && <Text color={theme.textDim}>  ... +{argsExtra} more</Text>}
      </Box>

      {request.diff && <DiffView diff={request.diff} width={width} theme={theme} />}

      <Text> </Text>

      {destructive && (
        <Box paddingLeft={1}>
          <Text color={theme.error}>⚠ Destructive command detected — "always" not offered</Text>
        </Box>
      )}

      {options.map((opt, i) => {
        const optColor =
          opt.decision === 'allow-once'   ? theme.success :
          opt.decision === 'deny'         ? theme.error :
          theme.primary;
        return (
          <Box key={i} paddingLeft={1} gap={1}>
            <Text color={theme.subtle}>{i === sel ? '>' : ' '}</Text>
            <Text bold color={theme.primary}>[{opt.num}]</Text>
            <Text bold={i === sel} color={i === sel ? optColor : theme.textDim}>
              {opt.label}
            </Text>
            <Text color={theme.subtle}>— {opt.sublabel}</Text>
          </Box>
        );
      })}

      <Box paddingLeft={2}>
        <Text color={theme.subtle}>up/down navigate  Enter confirm  or number</Text>
      </Box>
      <Text color={borderColor}>{sep}</Text>
    </Box>
  );
}

function DiffView({ diff, width, theme }: { diff: string; width: number; theme: ReturnType<typeof getTheme> }) {
  const lines   = diff.split('\n');
  const visible = lines.slice(0, MAX_DIFF_LINES);
  const extra   = lines.length - MAX_DIFF_LINES;

  const fileLine = lines.find(l => l.startsWith('+++'));
  const filename  = fileLine ? fileLine.replace(/^\+\+\+ /, '').replace(/\s.*$/, '') : '';
  const fileBar   = filename
    ? `── ${filename} ${'─'.repeat(Math.max(0, width - filename.length - 4))}`
    : '─'.repeat(width);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.primary}>{fileBar}</Text>
      {visible
        .filter(l => !l.startsWith('---') && !l.startsWith('+++'))
        .map((line, i) => {
          if (line.startsWith('@@')) return <Text key={i} color={theme.subtle}>{line}</Text>;
          if (line.startsWith('+'))  return <Text key={i} color={theme.success}>{line}</Text>;
          if (line.startsWith('-'))  return <Text key={i} color={theme.error}>{line}</Text>;
          return <Text key={i} color={theme.textDim}>{line}</Text>;
        })}
      {extra > 0 && <Text color={theme.textDim}>  ... +{extra} more lines</Text>}
    </Box>
  );
}
