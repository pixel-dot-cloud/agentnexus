import React, { useState, useCallback, useRef, useEffect } from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Box, useInput, useStdout, useApp } from 'ink';

import { ConfigManager } from '../config.js';
import {
  ProviderFactory,
  LLMProvider,
  ChatMessage,
  ToolResult as ProviderToolResult,
  ToolSpec,
  AUTO_MODEL,
} from '../providers.js';
import { defaultToolRegistry, ShellExecuteTool, BaseTool } from '../tools.js';
import { SkillTool } from '../tools/SkillTool.js';
import { TodoTool, TodoReadTool, TodoItem } from '../tools/TodoTool.js';
import { ConsentManager, ConsentRequest, ConsentDecision } from './consent.js';
import { computeDiff, colorDiff } from '../lib/diff.js';
import {
  loadProjectContext,
  resolveAtMentions,
  buildAtMentionBlock,
  generateProjectContext,
  loadMemoryFiles,
  loadSoulFiles,
  getMemoryPath,
  getSoulPath,
  getGlobalMemoryPath,
  getGlobalSoulPath,
} from '../lib/context.js';
import { HookManager, loadHooksConfig } from '../lib/hooks-manager.js';
import { McpClient, McpTool, loadMcpConfig } from '../lib/mcp.js';
import {
  newId,
  saveSession,
  listSessions,
  loadSession,
  saveChatMarkdown,
} from '../lib/session.js';
import { isGitRepo, createWorktree, removeWorktree, listWorktrees } from '../lib/worktree.js';
import { TerminalManager } from '../lib/terminal.js';
import { getCwd, setCwd } from '../lib/cwd.js';
import { getTheme, setThemeName, ThemeName } from '../lib/theme.js';
import type { PermissionMode } from '../lib/permission-modes.js';
import { getModeTitle } from '../lib/permission-modes.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { loadSkills, Skill } from '../lib/skills.js';
import { LmStudioApi, LmsModel, matchLmsModel } from '../lib/lmstudio-api.js';
import { dbg, dbgErr } from '../lib/debug.js';
import { loadPrompt } from '../lib/prompts.js';
import { renderMarkdown } from '../lib/markdown-render.js';

import { ChatLog, LogEntry, ToolStatus } from './components/ChatLog.js';
import { StreamBox } from './components/StreamBox.js';
import { Separator } from './components/Separator.js';
import { InputRow } from './components/InputRow.js';
import { StatusBar } from './components/StatusBar.js';
import { ConsentPrompt, consentHeight } from './components/ConsentPrompt.js';
import { TerminalPanel } from './components/TerminalPanel.js';
import { HomeScreen } from './components/HomeScreen.js';
import { CommandPicker, CommandEntry, pickerHeight } from './components/CommandPicker.js';
import { ModelPicker, ModelPickerEntry, modelPickerHeight } from './components/ModelPicker.js';

export type Message = ChatMessage;

function fmtModel(name: string | undefined): string {
  if (!name || name === AUTO_MODEL) return 'auto';
  return name.replace(/^_+|_+$/g, '').replace(/__+/g, '-');
}

const DEFAULT_TOOL_NAMES = new Set([
  'shell_execute', 'file_read', 'file_write', 'directory_list',
]);

const BUILTIN_COMMANDS = [
  '/model', '/models', '/save', '/resume', '/compact', '/init', '/memory', '/soul',
  '/tools', '/clear', '/worktree', '/plan', '/acceptedits', '/skills',
  '/cost', '/effort', '/theme', '/think', '/debug', '/menu', '/exit',
];

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  '/model':       'List or switch the active model',
  '/models':      'Open interactive model selector',
  '/save':        'Save chat to a markdown file',
  '/resume':      'Resume a previous session',
  '/compact':     'Summarize conversation to reduce context size',
  '/init':        'Generate AGENTNEXUS.md project context file',
  '/memory':      'Edit memory.md persistent memory file',
  '/soul':        'Edit soul.md — agent name, writing style, persona',
  '/tools':       'List available tools and their on/off status',
  '/clear':       'Clear conversation and start a fresh session',
  '/worktree':    'Manage git worktrees for isolated work',
  '/plan':        'Toggle plan mode — pauses all tool execution',
  '/acceptedits': 'Toggle accept-edits mode — auto-approve file writes',
  '/skills':      'List loaded skills (bundled + user + project)',
  '/cost':        'Show token usage and USD cost breakdown',
  '/effort':      'Set effort level: low | normal | high',
  '/theme':       'Switch between dark and light colour theme',
  '/think':       'Toggle showing/hiding the thinking box (Ctrl+R)',
  '/debug':       'Show debug log path and tail recent entries',
  '/menu':        'Return to the configuration menu',
  '/exit':        'Exit AgentNexus',
};

const MAX_TOOL_ITER = 200;
const TERM_H        = 15;
const FIXED_ROWS    = 4;

interface AppProps {
  config:   ConfigManager;
  onMenu:   () => void;
  version?: string;
}

function openInEditor(filePath: string): void {
  const editorRaw   = process.env.VISUAL || process.env.EDITOR || 'nano';
  const editorParts = editorRaw.split(' ');
  const editorCmd   = editorParts[0];
  const editorArgs  = [...editorParts.slice(1), filePath];
  spawnSync(editorCmd, editorArgs, { stdio: 'inherit' });
}

export function App({ config, onMenu, version = '' }: AppProps) {
  const { stdout } = useStdout();
  const { exit }   = useApp();

  // ── UI state ───────────────────────────────────────────────────────────────
  const [logEntries,   setLogEntries]   = useState<LogEntry[]>([]);
  const [streaming,    setStreaming]    = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinking,     setThinking]    = useState(false);
  const [termVisible,  setTermVisible] = useState(false);
  const [termFocused,  setTermFocused] = useState(false);
  const [consentReq,   setConsentReq]  = useState<ConsentRequest | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [modelName,    setModelNameState] = useState(
    fmtModel(config.getActiveModel()?.name),
  );
  const [permMode,     setPermMode]    = useState<PermissionMode>('default');
  const [effortLevel,  setEffortLevel] = useState<'low' | 'normal' | 'high'>(
    config.getEffortLevel(),
  );
  const [currentInput, setCurrentInput] = useState('');
  const [skills,       setSkills]      = useState<Skill[]>([]);
  const [prevModeBeforePlan, setPrevModeBeforePlan] = useState<PermissionMode>('default');
  const [showThinking, setShowThinking] = useState(true);
  const [hasUserActivity, setHasUserActivity] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerEntries, setModelPickerEntries] = useState<ModelPickerEntry[]>([]);
  const [modelPickerLoading, setModelPickerLoading] = useState(false);

  // ── Stable refs ────────────────────────────────────────────────────────────
  const messagesRef       = useRef<ChatMessage[]>([]);
  const llmRef            = useRef<LLMProvider | null>(null);
  const llmKeyRef         = useRef('');
  const abortRef          = useRef<AbortController | null>(null);
  const consentResolveRef = useRef<((d: ConsentDecision) => void) | null>(null);
  const termManager       = useRef(new TerminalManager());
  const mcpClients        = useRef<McpClient[]>([]);
  const sessionId         = useRef(newId());
  const worktreeRef       = useRef<{ branch: string; originalCwd: string } | null>(null);
  const hooksRef          = useRef(new HookManager(loadHooksConfig()));
  const projectContext    = useRef(loadProjectContext());
  const costTracker       = useRef(new CostTracker());
  const skillsRef         = useRef<Skill[]>([]);
  const permModeRef       = useRef<PermissionMode>('default');
  const logEntriesRef     = useRef<LogEntry[]>([]);
  const modelNameRef      = useRef(fmtModel(config.getActiveModel()?.name));
  const effortRef         = useRef<'low' | 'normal' | 'high'>(config.getEffortLevel());
  const isProcessingRef   = useRef(false);
  const termVisibleRef    = useRef(false);
  const runAgentTurnRef   = useRef<(input: string, displayText?: string) => Promise<void>>(
    async () => {},
  );

  useEffect(() => { permModeRef.current = permMode; }, [permMode]);
  useEffect(() => { logEntriesRef.current = logEntries; }, [logEntries]);
  useEffect(() => { modelNameRef.current = modelName; }, [modelName]);
  useEffect(() => { effortRef.current = effortLevel; }, [effortLevel]);
  useEffect(() => { skillsRef.current = skills; }, [skills]);
  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { termVisibleRef.current = termVisible; }, [termVisible]);

  const consentRef = useRef(
    (() => {
      const cm = new ConsentManager(
        (req: ConsentRequest) =>
          new Promise<ConsentDecision>(resolve => {
            setConsentReq(req);
            consentResolveRef.current = resolve;
          }),
        () => permModeRef.current,
      );
      cm.register('lmstudio:load_model', 'exec');
      return cm;
    })(),
  );

  // ── Log helpers ────────────────────────────────────────────────────────────
  const maxEntries = config.getScrollback();

  const addLog = useCallback((text: string) => {
    setLogEntries(prev => {
      const next: LogEntry[] = [...prev, { type: 'text', text }];
      const trimmed = next.length > maxEntries ? next.slice(-maxEntries) : next;
      logEntriesRef.current = trimmed;
      return trimmed;
    });
  }, [maxEntries]);

  const addToolLog = useCallback((full: string, status: ToolStatus = 'success') => {
    setLogEntries(prev => {
      const next: LogEntry[] = [...prev, { type: 'tool', full, expanded: false, status }];
      const trimmed = next.length > maxEntries ? next.slice(-maxEntries) : next;
      logEntriesRef.current = trimmed;
      return trimmed;
    });
  }, [maxEntries]);

  const addCompactBoundary = useCallback(() => {
    setLogEntries(prev => {
      const next: LogEntry[] = [...prev, { type: 'compact_boundary' }];
      logEntriesRef.current = next;
      return next;
    });
  }, []);

  const updateTodos = useCallback((items: TodoItem[]) => {
    setLogEntries(prev => {
      const next: LogEntry[] = [...prev, { type: 'todo', items }];
      logEntriesRef.current = next;
      return next;
    });
  }, []);

  const toggleLastTool = useCallback(() => {
    setLogEntries(prev => {
      const idx = [...prev].reverse().findIndex(e => e.type === 'tool');
      if (idx === -1) return prev;
      const realIdx = prev.length - 1 - idx;
      const next    = [...prev];
      const entry   = next[realIdx] as Extract<LogEntry, { type: 'tool' }>;
      next[realIdx] = { ...entry, expanded: !entry.expanded };
      logEntriesRef.current = next;
      return next;
    });
  }, []);

  // ── LLM provider cache ────────────────────────────────────────────────────
  const getLLM = useCallback((): LLMProvider | null => {
    const provider = config.getActiveProvider();
    const model    = config.getActiveModel();
    if (!provider || !model) return null;
    const key = `${provider.name}::${model.id}`;
    if (llmKeyRef.current !== key || !llmRef.current) {
      llmRef.current = ProviderFactory.create(provider.type, {
        endpoint: provider.endpoint,
        model:    model.id,
        apiKey:   provider.apiKey,
      });
      llmKeyRef.current = key;
    }
    return llmRef.current;
  }, [config]);

  // ── System prompt ─────────────────────────────────────────────────────────
  const buildSystemPrompt = useCallback((): string => {
    const parts: string[] = [];

    try { parts.push(loadPrompt('main-agent')); } catch { /* fallback: skip */ }

    const soul = loadSoulFiles(getCwd());
    if (soul) parts.push(`<soul>\n${soul}\n</soul>`);

    const memory = loadMemoryFiles(getCwd());
    if (memory) parts.push(`<memory>\n${memory}\n</memory>`);

    if (projectContext.current) parts.push(projectContext.current);

    const lvl = effortRef.current;
    if (lvl !== 'normal') {
      parts.push(
        lvl === 'high'
          ? 'Effort level: high — be thorough, exhaustive, and double-check your work.'
          : 'Effort level: low — be concise and fast, minimal output.',
      );
    }

    const skills = skillsRef.current;
    if (skills.length) {
      const list = skills.map(s => `  - ${s.name}: ${s.description}`).join('\n');
      parts.push(`Available skills (invoke via invoke_skill tool):\n${list}`);
    }

    return parts.join('\n\n');
  }, []);

  // ── Tool spec list ────────────────────────────────────────────────────────
  const buildToolSpecs = useCallback((): ToolSpec[] => {
    const enabledNames = new Set(config.getEnabledTools().map(e => e.name));
    return defaultToolRegistry.getToolSpecs(
      (t: BaseTool) => enabledNames.has(t.name) || !DEFAULT_TOOL_NAMES.has(t.name),
    );
  }, [config]);

  const argsToCtx = (args: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  };

  // ── LM Studio: ensure selected model is the one actually loaded ───────────
  const ensureLmsLoaded = useCallback(async (): Promise<boolean> => {
    const prov  = config.getActiveProvider();
    const model = config.getActiveModel();
    if (!prov || prov.type !== 'lmstudio' || !model) return true;
    const lms = new LmStudioApi(prov.endpoint, prov.apiKey);
    let all: LmsModel[];
    try { all = await lms.listModels(); }
    catch (e: any) {
      addLog(`\x1b[33mLM Studio unreachable: ${e.message}\x1b[0m`);
      return false;
    }
    const target = all.find(m => matchLmsModel(model.id, m));
    if (!target) {
      addLog(`\x1b[33mModel '${model.id}' not found in LM Studio.\x1b[0m`);
      const available = all.map(m => `${m.id}${m.state === 'loaded' ? ' [loaded]' : ''}`).join('\n  ');
      addLog(`\x1b[2mLM Studio reports ${all.length} model(s):\n  ${available || '(empty list)'}\x1b[0m`);
      return false;
    }
    if (target.state === 'loaded') return true;

    const autoUnload   = config.getAutoUnload();
    const loadedOther  = all.filter(m => m.state === 'loaded' && !matchLmsModel(model.id, m));
    addLog(`\x1b[33m'${model.name}' is not loaded in LM Studio.\x1b[0m`);
    if (autoUnload && loadedOther.length) {
      addLog(`\x1b[2mWill unload: ${loadedOther.map(m => m.id).join(', ')}\x1b[0m`);
    }
    const allow = await consentRef.current.requestConsent({
      toolName: 'lmstudio:load_model',
      args: {
        model:         model.id,
        unload_others: autoUnload ? loadedOther.map(m => m.id).join(', ') || 'none' : 'no',
      },
    });
    if (!allow) {
      addLog(`\x1b[33mAborted — '${model.name}' not loaded.\x1b[0m`);
      return false;
    }
    if (autoUnload) {
      for (const o of loadedOther) {
        addLog(`\x1b[2mUnloading ${o.id}...\x1b[0m`);
        const ur = await lms.unloadModel(o.id);
        if (!ur.ok) addLog(`\x1b[33mUnload warning: ${ur.detail}\x1b[0m`);
      }
    }
    addLog(`\x1b[2mLoading ${target.id}...\x1b[0m`);
    const lr = await lms.loadModel(target.id);
    if (!lr.ok) {
      addLog(`\x1b[31mLoad failed: ${lr.detail}\x1b[0m`);
      return false;
    }
    addLog(`\x1b[32mLoaded ${target.id}.\x1b[0m`);
    llmRef.current = null;
    llmKeyRef.current = '';
    return true;
  }, [config, addLog]);

  // ── Main agent loop ───────────────────────────────────────────────────────
  const runAgentTurn = useCallback(async (rawInput: string, displayText?: string) => {
    if (!rawInput.trim() || isProcessingRef.current) return;
    setHasUserActivity(true);
    isProcessingRef.current = true;
    dbg('runAgentTurn.begin', { len: rawInput.length, hasDisplay: !!displayText });

    const { clean, injected } = resolveAtMentions(rawInput);
    injected.forEach(({ ref, lines }) =>
      addLog(`\x1b[2m@${ref} attached (${lines} lines)\x1b[0m`),
    );

    const userContent = [
      clean,
      ...injected.map(({ ref, content }) => buildAtMentionBlock(ref, content)),
    ].join('\n\n');

    const echo = displayText ?? clean;
    addLog(`\x1b[1;37m❯\x1b[0m \x1b[37m${echo}\x1b[0m`);

    let llm = getLLM();
    if (!llm) {
      addLog(`\x1b[33mNo model configured. Use /model to switch.\x1b[0m`);
      isProcessingRef.current = false;
      return;
    }

    let history: ChatMessage[] = [
      ...messagesRef.current,
      { role: 'user', content: userContent },
    ];
    messagesRef.current = history;

    const ac = new AbortController();
    abortRef.current = ac;

    const earlyFail = () => {
      isProcessingRef.current = false;
      abortRef.current = null;
    };

    if (config.getActiveModel()?.id !== AUTO_MODEL) {
      const ok = await ensureLmsLoaded();
      if (!ok) { earlyFail(); return; }
      llm = getLLM();
      if (!llm) { earlyFail(); return; }
    }

    if (config.getActiveModel()?.id === AUTO_MODEL) {
      try {
        const resolved = await llm.resolveModel(ac.signal);
        const display = `${resolved} [auto]`;
        setModelNameState(display);
        modelNameRef.current = display;
      } catch (e: any) {
        if (e?.name !== 'AbortError') addLog(`\x1b[33mAuto-model: ${e.message}\x1b[0m`);
        earlyFail();
        return;
      }
    }

    if (permModeRef.current === 'plan') {
      addLog(`\x1b[2m[plan mode] Responding without executing tools.\x1b[0m`);
    }

    setIsProcessing(true);

    const sysContent = buildSystemPrompt();
    const sysMsg: ChatMessage[] = sysContent ? [{ role: 'system', content: sysContent }] : [];

    let completed = false;
    let iter = 0;
    const TOOL_BUDGET: Record<string, number> = { todo_write: 20, todo_read: 10 };
    const toolCounts = new Map<string, number>();
    try {
      for (iter = 0; iter < MAX_TOOL_ITER; iter++) {
        if (ac.signal.aborted) break;
        setThinking(true);
        setStreaming('');

        const tools  = buildToolSpecs();
        const result = await llm.chat(
          [...sysMsg, ...history],
          tools,
          chunk => { setStreaming(prev => prev + chunk); },
          ac.signal,
        );

        setThinking(false);
        setStreaming('');

        if (result.usage) {
          const activeId = config.getActiveModel()?.id || '';
          const modelId = activeId === AUTO_MODEL ? llm.getResolvedModel() : activeId;
          costTracker.current.update(result.usage, modelId);
        }

        if (result.aborted) {
          addLog('\x1b[2maborted\x1b[0m');
          break;
        }

        history = [
          ...history,
          {
            role: 'assistant',
            content: result.content,
            toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
          },
        ];
        messagesRef.current = history;

        if (result.content) {
          const rendered = renderMarkdown(result.content);
          addLog('\x1b[36m◆\x1b[0m\n\n' + rendered + '\n');
        }

        if (!result.toolCalls.length) { completed = true; break; }

        let overBudget: string | null = null;
        for (const tc of result.toolCalls) {
          if (!(tc.name in TOOL_BUDGET)) continue;
          const n = (toolCounts.get(tc.name) ?? 0) + 1;
          toolCounts.set(tc.name, n);
          if (n > TOOL_BUDGET[tc.name]) { overBudget = tc.name; break; }
        }
        if (overBudget) {
          addLog(`\x1b[33m[loop guard] ${overBudget} exceeded per-turn budget — ending turn.\x1b[0m`);
          completed = true;
          break;
        }

        const toolResults: ProviderToolResult[] = [];
        for (const tc of result.toolCalls) {
          if (tc.name === 'shell_execute') { termVisibleRef.current = true; setTermVisible(true); }

          if (tc.name === 'invoke_skill') {
            const r = await defaultToolRegistry.executeTool(tc.name, tc.args);
            if (r.success && r.output.startsWith('SKILL_EXPAND:')) {
              const skillPrompt = r.output.slice('SKILL_EXPAND:'.length);
              addLog(`\x1b[2m[skill: ${tc.args.name}]\x1b[0m`);
              toolResults.push({
                id: tc.id, name: tc.name,
                output: `Skill "${tc.args.name}" prompt:\n${skillPrompt}`,
                isError: false,
              });
              continue;
            }
            toolResults.push({ id: tc.id, name: tc.name, output: r.output, isError: !r.success });
            continue;
          }

          let diff: string | undefined;
          if (tc.name === 'file_write' && tc.args.path && tc.args.content) {
            try {
              diff = colorDiff(computeDiff(tc.args.path as string, tc.args.content as string));
            } catch {}
          }

          if (consentRef.current.isBlocked(tc.name)) {
            addLog(`\x1b[33m[plan mode] ${tc.name} blocked — /plan to exit.\x1b[0m`);
            toolResults.push({ id: tc.id, name: tc.name, output: 'Blocked: plan mode', isError: true });
            continue;
          }

          const allowed = await consentRef.current.requestConsent({
            toolName: tc.name,
            args:     tc.args,
            diff,
          });
          if (!allowed) {
            toolResults.push({ id: tc.id, name: tc.name, output: 'denied by user', isError: true });
            addToolLog(`${tc.name} — denied`, 'denied');
            continue;
          }

          hooksRef.current.run(`PreToolUse:${tc.name}`, argsToCtx(tc.args));

          try {
            const r      = await defaultToolRegistry.executeTool(tc.name, tc.args);
            const output = r.success ? r.output : `Error: ${r.error}`;
            addToolLog(`${tc.name}\n${output}`, r.success ? 'success' : 'error');
            toolResults.push({ id: tc.id, name: tc.name, output, isError: !r.success });
            hooksRef.current.run(`PostToolUse:${tc.name}`, { ...argsToCtx(tc.args), output });
          } catch (e: any) {
            const msg = `Tool error: ${e.message ?? String(e)}`;
            addToolLog(`${tc.name}\n${msg}`, 'error');
            toolResults.push({ id: tc.id, name: tc.name, output: msg, isError: true });
          }
        }

        history = [...history, { role: 'tool', content: '', toolResults }];
        messagesRef.current = history;
      }
      if (iter === MAX_TOOL_ITER && !ac.signal.aborted) completed = true;

      setScrollOffset(0);
      if (completed && !ac.signal.aborted) {
        saveSession({
          id:        sessionId.current,
          createdAt: new Date().toISOString(),
          model:     config.getActiveModel()?.name || '',
          provider:  config.getActiveProvider()?.name || '',
          history:   messagesRef.current,
        });
      }
    } catch (e: any) {
      dbgErr('runAgentTurn.threw', e);
      addLog(`\x1b[31merror: ${e.message || String(e)}\x1b[0m\n`);
    } finally {
      setThinking(false);
      setStreaming('');
      isProcessingRef.current = false;
      setIsProcessing(false);
      abortRef.current = null;
      dbg('runAgentTurn.end');
    }
  }, [addLog, addToolLog, getLLM, buildSystemPrompt, buildToolSpecs, config, ensureLmsLoaded]);

  useEffect(() => { runAgentTurnRef.current = runAgentTurn; }, [runAgentTurn]);

  // ── Mode toggles ──────────────────────────────────────────────────────────
  const togglePlanMode = useCallback(() => {
    const cur  = permModeRef.current;
    const next: PermissionMode = cur === 'plan' ? prevModeBeforePlan : 'plan';
    if (next === 'plan' && cur !== 'plan') setPrevModeBeforePlan(cur);
    setPermMode(next);
    permModeRef.current = next;
    if (next === 'plan') {
      const planDir  = path.join(getCwd(), '.agentnexus', 'plans');
      const planFile = path.join(planDir, `${sessionId.current}.md`);
      try {
        fs.mkdirSync(planDir, { recursive: true });
        if (!fs.existsSync(planFile)) {
          fs.writeFileSync(planFile, `# Plan — ${new Date().toISOString().slice(0, 10)}\n\n`);
        }
      } catch {}
    }
  }, [prevModeBeforePlan]);

  const toggleAcceptEdits = useCallback(() => {
    const next: PermissionMode = permModeRef.current === 'acceptEdits' ? 'default' : 'acceptEdits';
    setPermMode(next);
    permModeRef.current = next;
  }, []);

  const cyclePermMode = useCallback(() => {
    const cur = permModeRef.current;
    if (cur === 'default')     return toggleAcceptEdits();
    if (cur === 'acceptEdits') {
      setPermMode('default');
      permModeRef.current = 'default';
      togglePlanMode();
      return;
    }
    if (cur === 'plan') return togglePlanMode();
    setPermMode('default');
    permModeRef.current = 'default';
  }, [toggleAcceptEdits, togglePlanMode]);

  // ── Model picker helpers ──────────────────────────────────────────────────
  const openModelPicker = useCallback(async () => {
    const cfg = config.getConfig();
    const LOCAL_LIVE_TYPES = new Set(['ollama', 'lmstudio']);

    const initial: ModelPickerEntry[] = [];
    for (const prov of cfg.providers) {
      if (!LOCAL_LIVE_TYPES.has(prov.type) && !(prov.type === 'custom' && prov.listModels)) continue;
      const isActive = cfg.activeProvider === prov.name && cfg.activeModel === AUTO_MODEL;
      initial.push({
        kind:         'auto',
        providerName: prov.name,
        label:        `auto — currently loaded (${prov.name})`,
        active:       isActive,
      });
    }
    for (const m of cfg.models) {
      if (m.id === AUTO_MODEL) continue;
      const isActive = cfg.activeModel === m.id && cfg.activeProvider === m.provider;
      initial.push({
        kind:         'model',
        providerName: m.provider,
        modelId:      m.id,
        label:        `${m.name} [${m.provider}]`,
        active:       isActive,
      });
    }

    setModelPickerEntries(initial);
    setModelPickerLoading(true);
    setModelPickerOpen(true);

    const localProviders = cfg.providers.filter(p =>
      LOCAL_LIVE_TYPES.has(p.type) || (p.type === 'custom' && p.listModels),
    );

    await Promise.all(localProviders.map(async prov => {
      const isActive = cfg.activeProvider === prov.name;
      try {
        let liveEntries: ModelPickerEntry[] = [];

        if (prov.type === 'lmstudio') {
          const { LmStudioApi: Lms } = await import('../lib/lmstudio-api.js');
          const api = new Lms(prov.endpoint, prov.apiKey);
          const models = await api.listModels();
          liveEntries = models.map(m => ({
            kind:         'live' as const,
            providerName: prov.name,
            modelId:      m.id,
            label:        m.display_name || m.id,
            active:       isActive && cfg.activeModel === m.id,
            loaded:       m.state === 'loaded',
          }));
        } else {
          const tempProv = ProviderFactory.create(prov.type, {
            endpoint: prov.endpoint,
            model:    '_',
            apiKey:   prov.apiKey,
          });
          const ids = await tempProv.listModels();
          liveEntries = ids.map(id => ({
            kind:         'live' as const,
            providerName: prov.name,
            modelId:      id,
            label:        id,
            active:       isActive && cfg.activeModel === id,
          }));
        }

        setModelPickerEntries(prev => {
          const kept = prev.filter(e => e.kind !== 'live' || e.providerName !== prov.name);
          if (!liveEntries.length) {
            return [...kept, { kind: 'empty' as const, providerName: prov.name, label: `${prov.name}: no downloaded models`, active: false }];
          }
          return [...kept, ...liveEntries];
        });
      } catch {
        setModelPickerEntries(prev => {
          const kept = prev.filter(e => e.kind !== 'live' || e.providerName !== prov.name);
          return [...kept, { kind: 'offline' as const, providerName: prov.name, label: `${prov.name}: offline`, active: false }];
        });
      }
    }));

    setModelPickerLoading(false);
  }, [config]);

  const handleModelSelect = useCallback(async (entry: ModelPickerEntry) => {
    setModelPickerOpen(false);
    const cfg = config.getConfig();

    if (entry.kind === 'auto') {
      const prov = cfg.providers.find(p => p.name === entry.providerName);
      if (!prov) { addLog('\x1b[33mProvider not found\x1b[0m'); return; }
      config.setActiveProvider(prov.name);
      config.setActiveModel(AUTO_MODEL);
      llmRef.current = null; llmKeyRef.current = '';
      setModelNameState(`auto (${prov.name})`);
      addLog(`\x1b[32mSwitched to auto (${prov.name}) — using currently loaded model\x1b[0m`);
      return;
    }

    if (entry.kind === 'live') {
      const prov = cfg.providers.find(p => p.name === entry.providerName);
      if (!prov) { addLog('\x1b[33mProvider not found\x1b[0m'); return; }
      const modelId = entry.modelId!;

      if (prov.type === 'lmstudio' && entry.loaded === false) {
        const lms = new LmStudioApi(prov.endpoint, prov.apiKey);
        let all: LmsModel[];
        try { all = await lms.listModels(); }
        catch (e: any) { addLog(`\x1b[33mLM Studio unreachable: ${e.message}\x1b[0m`); return; }
        const target = all.find(m => matchLmsModel(modelId, m));
        if (!target) { addLog(`\x1b[33mModel '${modelId}' not found in LM Studio.\x1b[0m`); return; }
        const autoUnload  = config.getAutoUnload();
        const loadedOther = all.filter(m => m.state === 'loaded' && !matchLmsModel(modelId, m));
        addLog(`\x1b[33m'${entry.label}' is not loaded in LM Studio.\x1b[0m`);
        if (autoUnload && loadedOther.length) {
          addLog(`\x1b[2mWill unload: ${loadedOther.map(m => m.id).join(', ')}\x1b[0m`);
        }
        const allow = await consentRef.current.requestConsent({
          toolName: 'lmstudio:load_model',
          args: { model: modelId, unload_others: autoUnload ? loadedOther.map(m => m.id).join(', ') || 'none' : 'no' },
        });
        if (!allow) { addLog(`\x1b[33mSwitch cancelled — '${entry.label}' not loaded.\x1b[0m`); return; }
        if (autoUnload) {
          for (const o of loadedOther) {
            addLog(`\x1b[2mUnloading ${o.id}...\x1b[0m`);
            const ur = await lms.unloadModel(o.id);
            if (!ur.ok) addLog(`\x1b[33mUnload warning: ${ur.detail}\x1b[0m`);
          }
        }
        addLog(`\x1b[2mLoading ${target.id}...\x1b[0m`);
        const lr = await lms.loadModel(target.id);
        if (!lr.ok) { addLog(`\x1b[31mLoad failed: ${lr.detail}\x1b[0m`); return; }
        addLog(`\x1b[32mLoaded ${target.id}.\x1b[0m`);
      }

      config.setActiveProvider(prov.name);
      config.setActiveModel(modelId);
      llmRef.current = null; llmKeyRef.current = '';
      setModelNameState(entry.label);
      addLog(`\x1b[32mSwitched to ${entry.label}\x1b[0m`);
      return;
    }

    const sel = cfg.models.find(m => m.id === entry.modelId && m.provider === entry.providerName);
    if (!sel) { addLog('\x1b[33mModel not found in config\x1b[0m'); return; }
    config.setActiveModel(sel.id);
    config.setActiveProvider(sel.provider);
    llmRef.current = null; llmKeyRef.current = '';
    setModelNameState(fmtModel(sel.name));
    addLog(`\x1b[32mSwitched to ${fmtModel(sel.name)}\x1b[0m`);
  }, [config, addLog]);

  // ── Command handler ───────────────────────────────────────────────────────
  const handleCommand = useCallback(async (input: string) => {
    const parts = input.slice(1).split(' ');
    const cmd   = parts[0].toLowerCase();
    const rest  = parts.slice(1).join(' ').trim();

    const matchedSkill = skillsRef.current.find(s => s.name === cmd);
    if (matchedSkill) {
      const prompt = rest
        ? `${matchedSkill.prompt}\n\nAdditional context: ${rest}`
        : matchedSkill.prompt;
      const display = rest
        ? `[skill: ${matchedSkill.name}] ${rest}`
        : `[skill: ${matchedSkill.name}]`;
      await runAgentTurn(prompt, display);
      return;
    }

    switch (cmd) {

      case 'models': {
        void openModelPicker();
        break;
      }

      case 'model': {
        const cfg = config.getConfig();
        if (!rest) {
          if (!cfg.models.length) {
            addLog('\x1b[2mNo cloud models configured. Use /models for the live picker.\x1b[0m');
          } else {
            cfg.models.forEach((m, i) => {
              const active = m.id === cfg.activeModel ? '  <- active' : '';
              addLog(`  ${i + 1}. ${m.name} [${m.provider}]${active}`);
            });
          }
          addLog('\x1b[2mUse /model <number> to switch, or /models for interactive picker\x1b[0m');
          break;
        }
        if (!cfg.models.length) { addLog('\x1b[33mNo cloud models configured\x1b[0m'); break; }
        const idx = parseInt(rest) - 1;
        if (idx < 0 || idx >= cfg.models.length) { addLog('\x1b[33mInvalid model number\x1b[0m'); break; }
        const sel = cfg.models[idx];
        await handleModelSelect({ kind: 'model', providerName: sel.provider, modelId: sel.id, label: sel.name, active: sel.id === cfg.activeModel });
        break;
      }

      case 'plan': {
        if (rest === 'open') {
          const planDir  = path.join(getCwd(), '.agentnexus', 'plans');
          const planFile = path.join(planDir, `${sessionId.current}.md`);
          fs.mkdirSync(planDir, { recursive: true });
          if (!fs.existsSync(planFile)) fs.writeFileSync(planFile, `# Plan\n\n`);
          openInEditor(planFile);
          break;
        }
        if (rest === 'show') {
          const planFile = path.join(getCwd(), '.agentnexus', 'plans', `${sessionId.current}.md`);
          if (fs.existsSync(planFile)) addLog(fs.readFileSync(planFile, 'utf-8'));
          else addLog('\x1b[33mNo plan file yet.\x1b[0m');
          break;
        }
        togglePlanMode();
        break;
      }

      case 'acceptedits': { toggleAcceptEdits(); break; }

      case 'skills': {
        const skills = skillsRef.current;
        if (!skills.length) { addLog('\x1b[33mNo skills loaded.\x1b[0m'); break; }
        skills.forEach(s => {
          const hint = s.argumentHint ? ` ${s.argumentHint}` : '';
          addLog(`  /${s.name}${hint}  \x1b[2m[${s.source}] ${s.description}\x1b[0m`);
        });
        addLog(`\x1b[2m${skills.length} skill(s). Custom: ~/.agentnexus/skills/ or ./.agentnexus/skills/\x1b[0m`);
        break;
      }

      case 'cost': {
        const s = costTracker.current.getStats();
        addLog(`  input:    ${s.inputTokens.toLocaleString()} tokens`);
        addLog(`  output:   ${s.outputTokens.toLocaleString()} tokens`);
        addLog(`  cache:    ${s.cacheReadTokens.toLocaleString()} tokens`);
        addLog(`  calls:    ${s.apiCalls}`);
        addLog(`  cost:     ${s.totalCostUsd > 0 ? '$' + s.totalCostUsd.toFixed(6) : 'n/a (local/free)'}`);
        break;
      }

      case 'memory': {
        const memPath = rest === 'global' ? getGlobalMemoryPath() : getMemoryPath(getCwd());
        fs.mkdirSync(path.dirname(memPath), { recursive: true });
        if (!fs.existsSync(memPath)) {
          fs.writeFileSync(memPath, `# Memory\n\nFacts you've asked me to remember. I'll re-read this at every turn.\n`);
        }
        openInEditor(memPath);
        addLog(`\x1b[32mMemory: ${memPath}\x1b[0m`);
        break;
      }

      case 'soul': {
        const soulPath = rest === 'project' ? getSoulPath(getCwd()) : getGlobalSoulPath();
        fs.mkdirSync(path.dirname(soulPath), { recursive: true });
        if (!fs.existsSync(soulPath)) {
          let skeleton = '';
          try { skeleton = loadPrompt('soul-skeleton'); } catch {
            skeleton = '# Soul\n\n## Name\nNexus\n\n## Writing style\n(describe tone, length, formatting)\n\n## Persona notes\n(anything else about how I should behave)\n';
          }
          fs.writeFileSync(soulPath, skeleton);
        }
        openInEditor(soulPath);
        addLog(`\x1b[32mSoul: ${soulPath}\x1b[0m`);
        break;
      }

      case 'effort': {
        const valid = ['low', 'normal', 'high'];
        if (valid.includes(rest)) {
          const lvl = rest as 'low' | 'normal' | 'high';
          setEffortLevel(lvl);
          effortRef.current = lvl;
          config.setEffortLevel(lvl);
          addLog(`\x1b[32mEffort: ${lvl}\x1b[0m`);
        } else {
          addLog(`  effort: \x1b[1m${effortRef.current}\x1b[0m`);
          addLog('\x1b[2mUse /effort low|normal|high\x1b[0m');
        }
        break;
      }

      case 'theme': {
        const t = rest as ThemeName;
        if (t === 'dark' || t === 'light') {
          setThemeName(t);
          const cfg = config.getConfig();
          (cfg as any).theme = t;
          config.save();
          addLog(`\x1b[32mTheme: ${t}\x1b[0m`);
        } else {
          addLog(`  theme: \x1b[1m${(config.getConfig() as any).theme ?? 'dark'}\x1b[0m`);
          addLog('\x1b[2mUse /theme dark|light\x1b[0m');
        }
        break;
      }

      case 'save': {
        const msgs = messagesRef.current;
        if (!msgs.length) { addLog('\x1b[33mNothing to save.\x1b[0m'); break; }
        const fp = saveChatMarkdown(msgs, rest || undefined);
        addLog(`\x1b[32mSaved to ${fp}\x1b[0m`);
        break;
      }

      case 'resume': {
        const sessions = listSessions();
        if (!sessions.length) { addLog('\x1b[33mNo saved sessions.\x1b[0m'); break; }
        if (rest) {
          const idx = parseInt(rest) - 1;
          if (idx >= 0 && idx < sessions.length) {
            const meta = sessions[idx];
            const full = loadSession(meta.id);
            if (!full) { addLog('\x1b[31mSession unreadable.\x1b[0m'); break; }
            messagesRef.current = full.history;
            sessionId.current   = newId();
            if (meta.model) { const m = fmtModel(meta.model); setModelNameState(m); modelNameRef.current = m; }
            costTracker.current.reset();
            addLog(`\x1b[32mRestored ${meta.createdAt.slice(0, 10)} (${meta.messageCount} messages)\x1b[0m`);
          }
        } else {
          sessions.slice(0, 10).forEach((s, i) => {
            const tag = s.summary ?? s.firstUser ?? '';
            addLog(`  ${i + 1}. ${s.createdAt.slice(0, 10)} ${s.model} — ${tag}`);
          });
          addLog('\x1b[2mUse /resume <number>\x1b[0m');
        }
        break;
      }

      case 'compact': {
        const msgs = messagesRef.current;
        if (msgs.length < 2) { addLog('\x1b[33mNothing to compact.\x1b[0m'); break; }
        const llm = getLLM();
        if (!llm) { addLog('\x1b[33mNo model configured.\x1b[0m'); break; }
        addLog('\x1b[2mCompacting...\x1b[0m');
        setThinking(true);
        isProcessingRef.current = true;
        setIsProcessing(true);
        try {
          const instruction = rest ||
            'Summarize this conversation into a dense technical brief. Preserve key decisions, file paths, code, and outcomes. Output ONLY the summary.';
          const ac = new AbortController();
          abortRef.current = ac;
          let trimmed = [...msgs];
          while (trimmed.length) {
            const last = trimmed[trimmed.length - 1];
            if (last.role === 'tool') { trimmed.pop(); continue; }
            if (last.role === 'assistant' && last.toolCalls?.length) { trimmed.pop(); continue; }
            break;
          }
          if (!trimmed.length) { setThinking(false); addLog('\x1b[33mNothing to compact.\x1b[0m'); break; }
          const result = await llm.chat(
            [...trimmed, { role: 'user', content: instruction }],
            [], () => {}, ac.signal,
          );
          setThinking(false);
          abortRef.current = null;
          if (result.aborted) { addLog('\x1b[2mCompact aborted.\x1b[0m'); break; }
          const oldCount = msgs.length;
          messagesRef.current = [{ role: 'system', content: `Previous session summary:\n${result.content}` }];
          addCompactBoundary();
          addLog(`\x1b[32mCompacted: ${oldCount} messages\x1b[0m`);
        } catch (e: any) {
          setThinking(false);
          addLog(`\x1b[31mCompact failed: ${e.message}\x1b[0m`);
        } finally {
          isProcessingRef.current = false;
          setIsProcessing(false);
        }
        break;
      }

      case 'init': {
        const newCtx = generateProjectContext();
        const target = path.join(getCwd(), 'AGENTNEXUS.md');
        const exists = fs.existsSync(target);
        let diff: string | undefined;
        if (exists) { try { diff = colorDiff(computeDiff(target, newCtx)); } catch {} }
        const allowed = await consentRef.current.requestConsent({
          toolName: 'file_write',
          args:     { path: 'AGENTNEXUS.md', content: newCtx },
          diff,
        });
        if (!allowed) { addLog('\x1b[33m/init cancelled.\x1b[0m'); break; }
        fs.writeFileSync(target, newCtx);
        projectContext.current = newCtx;
        addLog(exists ? '\x1b[32mUpdated AGENTNEXUS.md\x1b[0m' : '\x1b[32mCreated AGENTNEXUS.md\x1b[0m');
        break;
      }

      case 'tools': {
        config.getConfig().tools.forEach(t => {
          const dot = t.enabled ? '\x1b[32m[on]\x1b[0m' : '\x1b[2m[off]\x1b[0m';
          addLog(`  ${dot} ${t.name}  —  ${t.description}`);
        });
        break;
      }

      case 'clear': {
        messagesRef.current = [];
        sessionId.current   = newId();
        setLogEntries([]);
        logEntriesRef.current = [];
        setScrollOffset(0);
        costTracker.current.reset();
        consentRef.current.resetSession();
        setHasUserActivity(false);
        break;
      }

      case 'worktree': {
        if (!isGitRepo(getCwd())) { addLog('\x1b[33mNot a git repo.\x1b[0m'); break; }
        if (rest === 'list') { listWorktrees(getCwd()).forEach(w => addLog(`  \x1b[2m${w}\x1b[0m`)); break; }
        if (rest === 'clean') {
          if (!worktreeRef.current) { addLog('\x1b[33mNo active worktree.\x1b[0m'); break; }
          const { branch, originalCwd } = worktreeRef.current;
          removeWorktree(originalCwd, branch);
          setCwd(originalCwd);
          worktreeRef.current = null;
          addLog(`\x1b[32mWorktree removed. Back in ${originalCwd}\x1b[0m`);
          break;
        }
        const branch      = sessionId.current;
        const originalCwd = getCwd();
        const dir         = createWorktree(originalCwd, branch);
        setCwd(dir);
        worktreeRef.current = { branch, originalCwd };
        addLog(`\x1b[32mWorktree created: ${dir}\x1b[0m`);
        addLog('\x1b[2mUse /worktree clean to remove\x1b[0m');
        break;
      }

      case 'think': {
        setShowThinking(s => {
          const next = !s;
          addLog(`\x1b[2mThinking display ${next ? 'on' : 'off'} (Ctrl+R)\x1b[0m`);
          return next;
        });
        break;
      }

      case 'debug': {
        try {
          const { dbgPath } = await import('../lib/debug.js');
          const p = dbgPath();
          addLog(`\x1b[36mDebug log: ${p}\x1b[0m`);
          const raw   = fs.readFileSync(p, 'utf-8');
          const lines = raw.trim().split('\n');
          addLog(`\x1b[2m--- last ${Math.min(40, lines.length)} of ${lines.length} entries ---\x1b[0m`);
          addLog(lines.slice(-40).join('\n'));
        } catch (e: any) {
          addLog(`\x1b[33mDebug log not readable: ${e.message}\x1b[0m`);
        }
        break;
      }

      case 'menu': {
        try { onMenu(); }
        catch (e) { dbgErr('cmd.menu.onMenu.threw', e); }
        break;
      }

      case 'exit': {
        try { termManager.current.destroy(); } catch {}
        mcpClients.current.forEach(c => { try { c.destroy(); } catch {} });
        if ((process.stdout as any).isTTY) {
          try { process.stdout.write('\x1b[?25h\x1b[?1049l\x1b[0m'); } catch {}
        }
        process.exit(0);
        break;
      }

      default:
        addLog(`\x1b[33mUnknown: /${cmd}. Type /skills or use: ${BUILTIN_COMMANDS.join(' ')}\x1b[0m`);
    }
  }, [config, addLog, addCompactBoundary, getLLM, onMenu, exit, runAgentTurn, handleModelSelect, openModelPicker, togglePlanMode, toggleAcceptEdits]);

  const handleConsentDecide = (d: ConsentDecision) => {
    consentResolveRef.current?.(d);
    setConsentReq(null);
  };

  // ── Keyboard input ────────────────────────────────────────────────────────
  useInput((char, key) => {
    if (consentReq) return;

    if (key.escape && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setThinking(false);
      setStreaming('');
      return;
    }
    if (key.ctrl && char === 'c') {
      if (termFocused) { termManager.current.sendSigInt(); return; }
      try { termManager.current.destroy(); } catch {}
      mcpClients.current.forEach(c => { try { c.destroy(); } catch {} });
      if ((process.stdout as any).isTTY) {
        try { process.stdout.write('\x1b[?25h\x1b[?1049l\x1b[0m'); } catch {}
      }
      process.exit(130);
    }
    if (key.ctrl && char === 't') {
      const nextVisible = !termVisibleRef.current;
      termVisibleRef.current = nextVisible;
      setTermVisible(nextVisible);
      setTermFocused(nextVisible);
      return;
    }
    if (key.ctrl && char === 'o') { toggleLastTool(); return; }
    if (key.ctrl && char === 'r') {
      setShowThinking(s => {
        const next = !s;
        addLog(`\x1b[2mThinking display ${next ? 'on' : 'off'} (Ctrl+R)\x1b[0m`);
        return next;
      });
      return;
    }
    if (key.shift && key.tab)     { cyclePermMode(); return; }
    if (key.pageUp)   { setScrollOffset(o => o + 10); return; }
    if (key.pageDown) { setScrollOffset(o => Math.max(0, o - 10)); return; }
    if (termFocused && termVisible && !consentReq && char) {
      termManager.current.write(char);
    }
  });

  // ── Terminal resize → force re-render ────────────────────────────────────
  const [, _forceResize] = useState(0);
  useEffect(() => {
    const onResize = () => _forceResize(n => n + 1);
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);

  // ── Init on mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    dbg('app.mount.begin');
    const savedTheme = (config.getConfig() as any).theme as ThemeName | undefined;
    if (savedTheme) setThemeName(savedTheme);

    defaultToolRegistry.registerTool(new ShellExecuteTool());
    defaultToolRegistry.registerTool(new SkillTool(() => skillsRef.current));
    defaultToolRegistry.registerTool(new TodoTool(items => updateTodos(items)));
    defaultToolRegistry.registerTool(new TodoReadTool());

    let mounted = true;

    loadSkills(getCwd()).then(loaded => {
      if (mounted) setSkills(loaded);
    }).catch(() => {});

    const mcpConf = loadMcpConfig(getCwd());
    (async () => {
      for (const [name, cfg] of Object.entries(mcpConf)) {
        if (!mounted) break;
        const client = new McpClient(name, cfg.command, cfg.args ?? [], cfg.env);
        try {
          await client.initialize();
          if (!mounted) { client.destroy(); break; }
          const tools = await client.listTools();
          for (const tool of tools) {
            defaultToolRegistry.registerTool(
              new McpTool(tool.name, tool.description, client, tool.inputSchema),
            );
          }
          mcpClients.current.push(client);
          if (mounted) addLog(`\x1b[2mMCP: ${tools.length} tools from "${name}"\x1b[0m`);
        } catch (e: any) {
          if (mounted) addLog(`\x1b[31mMCP "${name}": ${e.message}\x1b[0m`);
        }
      }
    })();

    hooksRef.current.run('SessionStart');

    return () => {
      dbg('app.cleanup.begin');
      mounted = false;
      try { abortRef.current?.abort(); } catch {}
      try { consentResolveRef.current?.('deny'); } catch {}
      consentResolveRef.current = null;
      try { termManager.current.destroy(); } catch {}
      mcpClients.current.forEach(c => { try { c.destroy(); } catch {} });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Layout ────────────────────────────────────────────────────────────────
  const totalRows   = stdout.rows || 24;
  const streamRows  = (streaming && showThinking) ? 8 : 0;
  const termRows    = termVisible ? TERM_H : 0;
  const consentRows = consentReq ? consentHeight(consentReq) : 0;

  const allCmdEntries: CommandEntry[] = [
    ...BUILTIN_COMMANDS.map(name => ({
      name,
      description: BUILTIN_DESCRIPTIONS[name] ?? '',
    })),
    ...skills.map(s => ({
      name:        `/${s.name}`,
      description: s.description,
    })),
  ];
  const allCompletions = allCmdEntries.map(e => e.name);

  const pickerRows      = pickerHeight(currentInput, allCmdEntries, 6, stdout.columns || 80);
  const modelPickerRows = modelPickerOpen ? modelPickerHeight(modelPickerEntries, modelPickerLoading) : 0;
  const logHeight    = Math.max(1,
    totalRows - FIXED_ROWS - streamRows - termRows - consentRows - pickerRows - modelPickerRows,
  );

  const provider = config.getActiveProvider();
  const showHome = !hasUserActivity && !isProcessing;

  return (
    <Box flexDirection="column" height={totalRows}>

      {showHome ? (
        <HomeScreen
          height={logHeight}
          modelName={modelName}
          providerName={provider?.name ?? ''}
          providerType={provider?.type ?? ''}
          cwd={getCwd()}
          skillCount={skills.length}
          version={version}
        />
      ) : (
        <ChatLog
          entries={logEntries}
          height={logHeight}
          scrollOffset={scrollOffset}
        />
      )}

      {streaming && showThinking && <StreamBox content={streaming} height={8} />}

      {termVisible && (
        <TerminalPanel
          manager={termManager.current}
          height={TERM_H}
          focused={termFocused}
        />
      )}

      {consentReq && (
        <ConsentPrompt
          request={consentReq}
          mode={permMode}
          onDecide={handleConsentDecide}
        />
      )}

      {pickerRows > 0 && (
        <CommandPicker
          prefix={currentInput}
          entries={allCmdEntries}
          maxItems={6}
        />
      )}

      {modelPickerOpen && (
        <ModelPicker
          entries={modelPickerEntries}
          loading={modelPickerLoading}
          onSelect={handleModelSelect}
          onCancel={() => setModelPickerOpen(false)}
        />
      )}

      <Separator thinking={thinking} mode={permMode} />

      <InputRow
        disabled={isProcessing || !!consentReq || termFocused || modelPickerOpen}
        termFocused={termFocused}
        onSubmit={runAgentTurn}
        onCommand={handleCommand}
        completions={allCompletions}
        onInputChange={setCurrentInput}
      />

      <Separator />

      <StatusBar
        mode={permMode}
        modelName={modelName}
        costStr={costTracker.current.formatCost()}
        tokenStr={costTracker.current.formatTokens()}
        effortLevel={effortLevel}
      />

    </Box>
  );
}
