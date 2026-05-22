import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface Skill {
  name:          string;
  description:   string;
  whenToUse?:    string;
  argumentHint?: string;
  allowedTools?: string[];
  prompt:        string;
  source:        'user' | 'project' | 'bundled';
  filePath:      string;
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const sep = '---';
  if (!raw.startsWith(sep)) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: raw };
  const yamlStr = raw.slice(4, end).trim();
  const body    = raw.slice(end + 4).trim();
  try {
    const meta = parseYaml(yamlStr) as Record<string, unknown>;
    return { meta: meta ?? {}, body };
  } catch {
    return { meta: {}, body };
  }
}

export function loadFromDir(dir: string, source: 'user' | 'project'): Skill[] {
  if (!fs.existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      const name = typeof meta.name === 'string' ? meta.name : path.basename(file, '.md');
      if (!body.trim()) continue;
      skills.push({
        name,
        description:  typeof meta.description === 'string'  ? meta.description  : name,
        whenToUse:    typeof meta.whenToUse    === 'string'  ? meta.whenToUse    : undefined,
        argumentHint: typeof meta.argumentHint === 'string'  ? meta.argumentHint : undefined,
        allowedTools: Array.isArray(meta.allowedTools)       ? meta.allowedTools as string[] : undefined,
        prompt: body,
        source,
        filePath,
      });
    } catch { /* skip unreadable files */ }
  }
  return skills;
}

const BUNDLED_SKILLS: Skill[] = [
  {
    name:        'commit',
    description: 'Create a git commit following conventional commits format',
    whenToUse:   'When the user wants to commit staged or unstaged changes',
    argumentHint:'<optional message>',
    prompt: `Create a git commit for the current changes.

Follow conventional commits format: type(scope): description
Types: feat, fix, docs, style, refactor, test, chore

Steps:
1. Run git status to see what changed
2. Run git diff --staged (or git diff if nothing staged) to understand the changes
3. Stage relevant files with git add if needed
4. Write a clear, concise commit message summarizing the change
5. Run git commit -m "..."

If the user provided a message hint, incorporate it. Keep the subject under 72 chars.`,
    source:   'bundled',
    filePath: '(bundled)',
  },
  {
    name:        'review',
    description: 'Review recent code changes for issues and improvements',
    whenToUse:   'When the user wants a code review of current or staged changes',
    prompt: `Review the current code changes.

Steps:
1. Run git diff HEAD (or git diff --staged if commits are staged)
2. Analyze the changes for:
   - Logic errors or bugs
   - Security issues
   - Performance concerns
   - Missing error handling
3. Report findings grouped by severity: Critical / Warning / Suggestion`,
    source:   'bundled',
    filePath: '(bundled)',
  },
];

export function getBundledSkills(): Skill[] {
  return BUNDLED_SKILLS;
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  const home       = process.env.HOME || '';
  const userDir    = path.join(home, '.agentnexus', 'skills');
  const projectDir = path.join(cwd,  '.agentnexus', 'skills');

  const user    = loadFromDir(userDir,    'user');
  const project = loadFromDir(projectDir, 'project');

  const merged = new Map<string, Skill>();
  for (const s of BUNDLED_SKILLS)  merged.set(s.name, s);
  for (const s of user)            merged.set(s.name, s);
  for (const s of project)         merged.set(s.name, s);

  return [...merged.values()];
}
