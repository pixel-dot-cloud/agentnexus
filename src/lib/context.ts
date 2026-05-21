import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getCwd } from './cwd.js';

const CONTEXT_FILENAME = 'AGENTNEXUS.md';
const MEMORY_FILENAME  = 'memory.md';
const SOUL_FILENAME    = 'soul.md';
const GLOBAL_DIR       = path.join(process.env.HOME || '', '.agentnexus');

function readLayered(filename: string, cwd: string): string[] {
  const parts: string[] = [];

  const globalPath = path.join(GLOBAL_DIR, filename);
  if (fs.existsSync(globalPath)) {
    try { parts.push(fs.readFileSync(globalPath, 'utf-8')); } catch {}
  }

  const stop = findStopBoundary(cwd);
  let dir = cwd;
  while (true) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) {
      try { parts.push(fs.readFileSync(p, 'utf-8')); } catch {}
      break;
    }
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return parts;
}

export function loadMemoryFiles(cwd: string = getCwd()): string | null {
  const parts = readLayered(MEMORY_FILENAME, cwd);
  return parts.length ? parts.join('\n\n') : null;
}

export function loadSoulFiles(cwd: string = getCwd()): string | null {
  const parts = readLayered(SOUL_FILENAME, cwd);
  return parts.length ? parts.join('\n\n') : null;
}

export function getMemoryPath(cwd: string = getCwd()): string {
  return path.join(cwd, MEMORY_FILENAME);
}

export function getGlobalMemoryPath(): string {
  return path.join(GLOBAL_DIR, MEMORY_FILENAME);
}

export function getSoulPath(cwd: string = getCwd()): string {
  return path.join(cwd, SOUL_FILENAME);
}

export function getGlobalSoulPath(): string {
  return path.join(GLOBAL_DIR, SOUL_FILENAME);
}

function findStopBoundary(start: string): string {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (top) return top;
  } catch {}
  return process.env.HOME || start;
}

export function loadProjectContext(cwd: string = getCwd()): string | null {
  const stop = findStopBoundary(cwd);
  let dir = cwd;
  while (true) {
    const p = path.join(dir, CONTEXT_FILENAME);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface AtMentionResult {
  clean: string;
  injected: Array<{ ref: string; content: string; lines: number }>;
}

export function resolveAtMentions(input: string, cwd: string = getCwd()): AtMentionResult {
  const AT_RE = /@([\w./\-]+)/g;
  const injected: Array<{ ref: string; content: string; lines: number }> = [];
  const clean = input.replace(AT_RE, (match, ref) => {
    const abs = path.resolve(cwd, ref);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const content = fs.readFileSync(abs, 'utf-8');
        injected.push({ ref, content, lines: content.split('\n').length });
        return ref;
      }
    } catch {}
    return match;
  });
  return { clean, injected };
}

export function buildAtMentionBlock(ref: string, content: string): string {
  const ext = path.extname(ref).slice(1) || 'text';
  return `[File: ${ref}]\n\`\`\`${ext}\n${content}\n\`\`\``;
}

export function generateProjectContext(cwd: string = getCwd()): string {
  const lines: string[] = ['# Project Context\n'];

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      lines.push(`## Package\n- Name: ${pkg.name}\n- Description: ${pkg.description || 'none'}`);
      if (pkg.scripts) {
        const scripts = Object.entries(pkg.scripts).map(([k, v]) => `  - \`${k}\`: ${v}`).join('\n');
        lines.push(`- Scripts:\n${scripts}`);
      }
    } catch {}
  }

  for (const name of ['README.md', 'README.txt', 'README']) {
    const rp = path.join(cwd, name);
    if (fs.existsSync(rp)) {
      const excerpt = fs.readFileSync(rp, 'utf-8').split('\n').slice(0, 50).join('\n');
      lines.push(`\n## README (first 50 lines)\n${excerpt}`);
      break;
    }
  }

  try {
    const tree = execFileSync('find', ['.', '-maxdepth', '2', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'], { cwd }).toString().trim();
    lines.push(`\n## Directory Structure\n\`\`\`\n${tree}\n\`\`\``);
  } catch {}

  try {
    const log = execFileSync('git', ['log', '--oneline', '-10'], { cwd }).toString().trim();
    lines.push(`\n## Recent Commits\n\`\`\`\n${log}\n\`\`\``);
  } catch {}

  return lines.join('\n');
}
