/**
 * CLI file manager for agent workspace directories.
 *
 * Workspace = ~/.agentnexus/agents/<name>/work  (the host-side Docker mount)
 *
 * Commands (all routed through runWorkspaceCommand / runImportCommand):
 *   agentnexus import <src> [agent]          copy src into workspace
 *   agentnexus files [agent]                 list workspace root
 *   agentnexus files [agent] ls [path]       list directory
 *   agentnexus files [agent] show <file>     print file contents
 *   agentnexus files [agent] rm <path>       delete file or directory
 *   agentnexus files [agent] mkdir <path>    create directory
 *   agentnexus files [agent] link [dest]     symlink ~/nexus-workspace → workspace
 *   agentnexus files [agent] open            xdg-open workspace in file manager
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { agentDir, DEFAULT_AGENT_NAME, AGENTS_DIR } from '../core/agents.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(['ls', 'show', 'cat', 'rm', 'del', 'mkdir', 'link', 'open', 'tree', 'path']);

function workDir(agentName: string): string {
  return path.join(agentDir(agentName), 'work');
}

function ensureWorkDir(agentName: string): string {
  const dir = workDir(agentName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** List all known agents (dirs under AGENTS_DIR). */
function listAgents(): string[] {
  try {
    return fs.readdirSync(AGENTS_DIR).filter(n => {
      return fs.statSync(path.join(AGENTS_DIR, n)).isDirectory();
    });
  } catch { return []; }
}

/**
 * Split args into [agentName, subcommand, rest].
 * First arg is treated as agent name if it's not a known subcommand AND
 * the agent directory exists. Otherwise defaults to DEFAULT_AGENT_NAME.
 */
function parseArgs(args: string[]): { agentName: string; sub: string; rest: string[] } {
  let agentName = DEFAULT_AGENT_NAME;
  let remaining = args;

  if (args[0] && !SUBCOMMANDS.has(args[0]) && !args[0].startsWith('-')) {
    const candidate = args[0];
    if (fs.existsSync(agentDir(candidate))) {
      agentName = candidate;
      remaining = args.slice(1);
    }
  }

  const sub  = remaining[0] ?? 'ls';
  const rest = remaining.slice(1);
  return { agentName, sub, rest };
}

/** Pretty-print a directory listing. */
function printLs(dir: string, label?: string): void {
  if (label) console.log(`\n${label}`);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e: any) {
    console.error(`Cannot read ${dir}: ${e.message}`);
    return;
  }
  if (!entries.length) { console.log('  (empty)'); return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const suffix = e.isDirectory() ? '/' : e.isSymbolicLink() ? ' -> ' + fs.readlinkSync(path.join(dir, e.name)) : '';
    const size   = !e.isDirectory() && !e.isSymbolicLink()
      ? `  ${humanSize(fs.statSync(path.join(dir, e.name)).size)}`
      : '';
    console.log(`  ${e.isDirectory() ? '📁' : e.isSymbolicLink() ? '🔗' : '📄'} ${e.name}${suffix}${size}`);
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/** Recursively copy src to destDir (like cp -r). */
function cpRecursive(src: string, destDir: string): void {
  const stat  = fs.statSync(src);
  const base  = path.basename(src);
  const dest  = path.join(destDir, base);

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      cpRecursive(path.join(src, child), dest);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

/** Recursively delete. */
function rmRecursive(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

// ── import command ────────────────────────────────────────────────────────────

export function runImportCommand(args: string[]): void {
  const src = args[0];
  if (!src) {
    console.error('Usage: agentnexus import <src-path> [agent-name]');
    process.exit(1);
  }

  const agentName = args[1] && fs.existsSync(agentDir(args[1])) ? args[1] : DEFAULT_AGENT_NAME;
  const dest = ensureWorkDir(agentName);

  if (!fs.existsSync(src)) {
    console.error(`Source not found: ${src}`);
    process.exit(1);
  }

  try {
    cpRecursive(path.resolve(src), dest);
    const base = path.basename(src);
    console.log(`✅ Imported "${base}" → ${dest}/${base}`);
    console.log(`   Agent: ${agentName}`);
  } catch (e: any) {
    console.error(`Import failed: ${e.message}`);
    process.exit(1);
  }
}

// ── files command ─────────────────────────────────────────────────────────────

export function runFilesCommand(args: string[]): void {
  const { agentName, sub, rest } = parseArgs(args);
  const work = workDir(agentName);

  switch (sub) {

    case 'ls':
    case 'tree': {
      const rel  = rest[0] ?? '';
      const dir  = rel ? path.join(work, rel) : work;
      const stat = fs.existsSync(dir) ? fs.statSync(dir) : null;
      if (!stat) {
        // Workspace may not exist yet — show message + all agents
        console.log(`Workspace for agent "${agentName}": ${work}`);
        console.log('  (empty or not created yet)');
        const agents = listAgents();
        if (agents.length > 1) console.log(`\nKnown agents: ${agents.join(', ')}`);
        return;
      }
      if (stat.isFile()) {
        // User passed a file path — show contents instead
        console.log(fs.readFileSync(dir, 'utf-8'));
        return;
      }
      console.log(`Workspace: ${dir}`);
      printLs(dir);
      break;
    }

    case 'show':
    case 'cat': {
      const rel = rest[0];
      if (!rel) { console.error('Usage: files show <file>'); process.exit(1); }
      const file = path.join(work, rel);
      if (!fs.existsSync(file)) { console.error(`Not found: ${file}`); process.exit(1); }
      console.log(fs.readFileSync(file, 'utf-8'));
      break;
    }

    case 'rm':
    case 'del': {
      const rel = rest[0];
      if (!rel) { console.error('Usage: files rm <path>'); process.exit(1); }
      const target = path.join(work, rel);
      // Safety: must be inside workDir
      if (!path.resolve(target).startsWith(path.resolve(work))) {
        console.error('Path escapes workspace — refused.');
        process.exit(1);
      }
      if (!fs.existsSync(target)) { console.error(`Not found: ${target}`); process.exit(1); }
      rmRecursive(target);
      console.log(`🗑  Deleted: ${rel}`);
      break;
    }

    case 'mkdir': {
      const rel = rest[0];
      if (!rel) { console.error('Usage: files mkdir <path>'); process.exit(1); }
      const dir = path.join(work, rel);
      fs.mkdirSync(dir, { recursive: true });
      console.log(`📁 Created: ${dir}`);
      break;
    }

    case 'path': {
      // Just print the workspace path — useful for scripts / Dolphin bookmarks
      console.log(work);
      break;
    }

    case 'link': {
      // Create a symlink from dest (default ~/nexus-workspace) → work dir
      const defaultLink = path.join(process.env.HOME || '', 'nexus-workspace');
      const linkPath    = rest[0] ? path.resolve(rest[0]) : defaultLink;

      ensureWorkDir(agentName);

      if (fs.existsSync(linkPath) || fs.existsSync(linkPath + '/')) {
        const existing = fs.lstatSync(linkPath);
        if (existing.isSymbolicLink()) {
          fs.unlinkSync(linkPath);
          console.log(`Removed old symlink: ${linkPath}`);
        } else {
          console.error(`${linkPath} already exists and is not a symlink. Remove it manually first.`);
          process.exit(1);
        }
      }

      fs.symlinkSync(work, linkPath, 'dir');
      console.log(`🔗 Symlink created:`);
      console.log(`   ${linkPath} → ${work}`);
      console.log(`\nAdd to Dolphin: Places panel → right-click → "Add Entry" → paste the path above.`);
      console.log(`Or drag the folder directly into Dolphin's sidebar.`);
      break;
    }

    case 'open': {
      const dir = ensureWorkDir(agentName);
      console.log(`Opening ${dir} ...`);
      cp.spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
      break;
    }

    default: {
      console.error(`Unknown subcommand: ${sub}`);
      console.log(WORKSPACE_HELP);
      process.exit(1);
    }
  }
}

const WORKSPACE_HELP = `
agentnexus files [agent] <subcommand> [args]

Subcommands:
  ls [path]        List workspace (or a subdirectory)
  show <file>      Print file contents
  rm <path>        Delete file or directory
  mkdir <path>     Create directory
  link [dest]      Symlink ~/nexus-workspace → workspace (for Dolphin)
  open             Open workspace in system file manager (xdg-open)
  path             Print workspace path

Agent defaults to "default" if not specified.
`.trim();

export { WORKSPACE_HELP };
