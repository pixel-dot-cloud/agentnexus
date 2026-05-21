import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = new Map<string, string>();

function resolveDir(): string {
  const metaDir = (import.meta as { dirname?: string }).dirname;
  if (metaDir) return metaDir;
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function findPromptFile(name: string): string {
  const here = resolveDir();
  const candidates = [
    join(here, '..', 'prompts', `${name}.md`),
    join(here, '..', '..', 'src', 'prompts', `${name}.md`),
    join(process.cwd(), 'src', 'prompts', `${name}.md`),
    join(process.cwd(), 'prompts', `${name}.md`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Prompt "${name}" not found. Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

function stripLeadingHtmlComment(text: string): string {
  const match = text.match(/^\s*<!--[\s\S]*?-->\s*\n?/);
  return match ? text.slice(match[0].length) : text;
}

function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (full, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : full;
  });
}

export function loadPrompt(name: string, vars?: Record<string, string>): string {
  let raw = cache.get(name);
  if (raw === undefined) {
    const p = findPromptFile(name);
    raw = stripLeadingHtmlComment(readFileSync(p, 'utf8'));
    cache.set(name, raw);
  }
  return vars && Object.keys(vars).length > 0 ? substitute(raw, vars) : raw;
}
