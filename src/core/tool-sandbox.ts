import type { AgentDefinition } from './agents.js';
import type { ContainerHandle } from './container.js';
import type { ToolResult } from '../tools.js';

/**
 * Tool names that execute arbitrary code on the host. When an agent has
 * container.enabled=true (mode=tools-only), these are redirected into the
 * sandbox container; everything else passes through to the host registry
 * unchanged (file_read, directory_list, skills, todos, sub-agents).
 */
export const SANDBOXED_TOOLS = new Set<string>(['shell_execute']);

export type Executor = (name: string, args: any) => Promise<ToolResult>;

function truncate(s: string, max = 8000): string {
  return s.length > max ? s.slice(0, max) + `\n... (truncated, ${s.length - max} more chars)` : s;
}

export function buildSandboxedExecutor(
  _agent: AgentDefinition,
  baseExecute: Executor,
  handle: ContainerHandle,
): Executor {
  return async (name: string, args: any): Promise<ToolResult> => {
    if (!SANDBOXED_TOOLS.has(name)) return baseExecute(name, args);

    if (name === 'shell_execute') {
      const cmd = typeof args?.command === 'string' ? args.command : '';
      if (!cmd) return { success: false, output: '', error: 'Missing required argument: command' };
      const timeoutMs = typeof args?.timeout === 'number' ? args.timeout : 30000;
      try {
        const r = await handle.run(['bash', '-lc', cmd], { timeoutMs });
        if (r.exitCode === 0) {
          const out = r.stdout || r.stderr || '(command executed with no output)';
          return { success: true, output: truncate(out) };
        }
        return {
          success: false,
          output: truncate(r.stdout || ''),
          error: truncate(r.stderr || `exit ${r.exitCode}`),
        };
      } catch (e: any) {
        return { success: false, output: '', error: `Sandbox error: ${e?.message ?? String(e)}` };
      }
    }

    // Unreachable, but keep the type checker happy
    return baseExecute(name, args);
  };
}
