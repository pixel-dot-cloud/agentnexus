import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export function isGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function createWorktree(cwd: string, branchName: string): string {
  const dir = path.join(cwd, '.agentnexus', 'worktrees', branchName);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', `agentnexus/${branchName}`, dir], { cwd });
  return dir;
}

export function removeWorktree(cwd: string, branchName: string): void {
  const dir = path.join(cwd, '.agentnexus', 'worktrees', branchName);
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd });
  } catch {}
  try {
    execFileSync('git', ['branch', '-D', `agentnexus/${branchName}`], { cwd, stdio: 'ignore' });
  } catch {}
}

export function listWorktrees(cwd: string): string[] {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd })
      .toString()
      .split('\n\n')
      .map(block => block.split('\n')[0]?.replace('worktree ', '') ?? '')
      .filter(Boolean);
  } catch {
    return [];
  }
}
