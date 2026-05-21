import * as readline from 'readline';
import type { ConfigManager } from '../config.js';
import { buildRoot, type MenuCtx, type MenuNode, type MenuResult, type ListNode } from './menu-tree.js';

const ESC = '\x1b';
const STDIN_RAW_SUPPORTED = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';

function clearScreen(): void {
  process.stdout.write(`${ESC}[2J${ESC}[H`);
}

function render(title: string, items: string[], selected: number, hint: string): void {
  clearScreen();
  process.stdout.write(`${title}\n\n`);
  items.forEach((label, i) => {
    const marker = i === selected ? `${ESC}[36m>${ESC}[0m` : ' ';
    const text   = i === selected ? `${ESC}[1m${label}${ESC}[0m` : label;
    process.stdout.write(`  ${marker} ${text}\n`);
  });
  process.stdout.write(`\n${ESC}[2m${hint}${ESC}[0m\n`);
}

async function selectFromList(title: string, items: string[]): Promise<number | null> {
  if (!STDIN_RAW_SUPPORTED) return selectFromListFallback(title, items);
  return new Promise<number | null>((resolve) => {
    let selected = 0;
    const hint = 'UP/DOWN navigate | ENTER select | ESC back | CTRL+C exit';
    render(title, items, selected, hint);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (key: string) => {
      // Arrow up: \x1b[A   down: \x1b[B
      if (key === '\x1b[A') { selected = (selected - 1 + items.length) % items.length; render(title, items, selected, hint); return; }
      if (key === '\x1b[B') { selected = (selected + 1) % items.length;                   render(title, items, selected, hint); return; }
      if (key === '\r' || key === '\n')   { cleanup(); resolve(selected); return; }
      if (key === '\x1b' || key === 'q')  { cleanup(); resolve(null);     return; }
      if (key === '\x03')                  { cleanup(); process.exit(130); }
      // Numeric quick-select
      if (/^[1-9]$/.test(key)) {
        const n = parseInt(key, 10) - 1;
        if (n < items.length) { cleanup(); resolve(n); return; }
      }
    };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}

async function selectFromListFallback(title: string, items: string[]): Promise<number | null> {
  // Non-TTY: numbered prompt
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${title}`);
    items.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
    const ans = await new Promise<string>((r) => rl.question('Select [number, empty for back]: ', r));
    const v = ans.trim();
    if (!v) return null;
    const n = parseInt(v, 10) - 1;
    if (isNaN(n) || n < 0 || n >= items.length) return null;
    return n;
  } finally {
    rl.close();
  }
}

async function askText(prompt: string, initial?: string, hidden = false): Promise<string | null> {
  // hidden masking is a soft hint; readline doesn't suppress input. Warn and proceed.
  if (hidden) {
    process.stdout.write(`${ESC}[33mNote: input will be visible; treat as sensitive.${ESC}[0m\n`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const p = initial ? `${prompt} [${initial}]: ` : `${prompt} `;
    const ans = await new Promise<string>((r) => rl.question(p, r));
    if (ans === '' && initial !== undefined) return initial;
    return ans;
  } finally {
    rl.close();
  }
}

async function askYesNo(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await new Promise<string>((r) => rl.question(`${prompt} [y/N]: `, r));
    return ans.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}

function nodePreviewLabel(node: MenuNode): string {
  return node.label;
}

async function runNode(node: MenuNode, ctx: MenuCtx): Promise<MenuResult> {
  switch (node.kind) {
    case 'list': {
      while (true) {
        const children = node.children(ctx);
        const labels   = [...children.map(nodePreviewLabel), '<- Back'];
        const sel      = await selectFromList(node.label, labels);
        if (sel === null || sel === children.length) return { kind: 'back' };
        const result = await runNode(children[sel], ctx);
        if (result.kind === 'message') {
          process.stdout.write(`\n${ESC}[32m${result.text}${ESC}[0m\n`);
          await pause();
        }
        // 'back' / 'stay' / 'reopen' all resume this list loop
      }
    }
    case 'action': {
      return node.run(ctx);
    }
    case 'input': {
      const initial = node.initial ? node.initial(ctx) : undefined;
      const raw     = await askText(node.prompt, initial, node.sensitive);
      if (raw === null) return { kind: 'back' };
      const parsed  = node.parse(raw);
      if (parsed instanceof Error) {
        return { kind: 'message', text: `Error: ${parsed.message}` };
      }
      return node.apply(ctx, parsed);
    }
    case 'choice': {
      const labels = node.options.map((o) => o.label);
      const sel = await selectFromList(`${node.label}\n${ESC}[2m(current: ${node.current(ctx)})${ESC}[0m`, labels);
      if (sel === null) return { kind: 'back' };
      return node.apply(ctx, node.options[sel].value);
    }
    case 'toggle': {
      const next = !node.current(ctx);
      return node.apply(ctx, next);
    }
    case 'confirm': {
      const ok = await askYesNo(node.prompt);
      if (!ok) return { kind: 'back' };
      return node.run(ctx);
    }
  }
}

async function pause(): Promise<void> {
  if (!STDIN_RAW_SUPPORTED) return;
  process.stdout.write(`${ESC}[2mPress any key to continue...${ESC}[0m`);
  await new Promise<void>((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });
  process.stdout.write('\n');
}

export async function runConfigMenu(config: ConfigManager): Promise<void> {
  const root: ListNode = buildRoot(config);
  const ctx: MenuCtx = { config };
  // Root list loop with Exit option
  while (true) {
    const children = root.children(ctx);
    const labels   = [...children.map(nodePreviewLabel), 'Exit'];
    const sel      = await selectFromList(root.label, labels);
    if (sel === null || sel === children.length) {
      clearScreen();
      process.stdout.write('Bye.\n');
      return;
    }
    const result = await runNode(children[sel], ctx);
    if (result.kind === 'message') {
      process.stdout.write(`\n${ESC}[32m${result.text}${ESC}[0m\n`);
      await pause();
    }
  }
}
