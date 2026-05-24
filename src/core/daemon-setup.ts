import type { ConfigManager } from '../config.js';
import { defaultToolRegistry, ShellExecuteTool } from '../tools.js';
import { SkillTool } from '../tools/SkillTool.js';
import { TodoTool, TodoReadTool } from '../tools/TodoTool.js';
import { AgentSpawnTool } from '../tools/AgentSpawnTool.js';
import { CheckAgentTool } from '../tools/CheckAgentTool.js';
import { ListAgentsTool } from '../tools/ListAgentsTool.js';
import { AbortAgentTool } from '../tools/AbortAgentTool.js';
import { ListBotsTool } from '../tools/ListBotsTool.js';
import { AssignBotTool } from '../tools/AssignBotTool.js';
import { ReleaseBotTool } from '../tools/ReleaseBotTool.js';
import { ConsentManager } from '../lib/consent.js';
import { HookManager, loadHooksConfig } from '../lib/hooks-manager.js';
import { McpClient, McpTool, loadMcpConfig } from '../lib/mcp.js';
import { loadSkills, type Skill } from '../lib/skills.js';
import { ProviderFactory } from '../providers.js';
import { getCwd } from '../lib/cwd.js';
import { setActiveSkills, getActiveSkills } from './skill-context.js';

export interface DaemonContext {
  hooks:   HookManager;
  consent: ConsentManager;
  /** Mutable holder for the current bundled+user+project skill list. */
  skills:  { current: Skill[] };
}

export interface DaemonOptions {
  onAgentEvent?: (ev: import('./daemon-setup.js').AgentEventCallback) => void;
}

// Re-export so callers don't need to import sub-agent.ts.
export type AgentEventCallback = import('../lib/sub-agent.js').SubAgentEvent;

/**
 * Daemon-scoped wiring shared by every channel adapter.
 * Registers tools (Shell/Skill/Todo/AgentSpawn), loads skills, boots MCP
 * clients, fires the `SessionStart` hook.
 */
export async function setupDaemon(config: ConfigManager, opts: { onAgentEvent?: (ev: AgentEventCallback) => void } = {}): Promise<DaemonContext> {
  const hooks   = new HookManager(loadHooksConfig());
  const consent = new ConsentManager(() => 'default');

  defaultToolRegistry.registerTool(new ShellExecuteTool());

  const skills: { current: Skill[] } = { current: [] };
  defaultToolRegistry.registerTool(new SkillTool(() => getActiveSkills()));
  defaultToolRegistry.registerTool(new TodoTool(() => {}));
  defaultToolRegistry.registerTool(new TodoReadTool());

  defaultToolRegistry.registerTool(new AgentSpawnTool({
    getLLM: (modelOverride?: string) => {
      const provider = config.getActiveProvider();
      const model    = config.getActiveModel();
      if (!provider || !model) throw new Error('No model configured for sub-agent');
      return ProviderFactory.create(provider.type, {
        endpoint: provider.endpoint,
        model:    modelOverride ?? model.id,
        apiKey:   provider.apiKey,
      });
    },
    consent,
    hooks,
    registry:     defaultToolRegistry,
    onAgentEvent: opts.onAgentEvent,
  }));

  defaultToolRegistry.registerTool(new CheckAgentTool());
  defaultToolRegistry.registerTool(new ListAgentsTool());
  defaultToolRegistry.registerTool(new AbortAgentTool());
  defaultToolRegistry.registerTool(new ListBotsTool());
  defaultToolRegistry.registerTool(new AssignBotTool());
  defaultToolRegistry.registerTool(new ReleaseBotTool());

  skills.current = await loadSkills(getCwd()).catch(() => []);
  setActiveSkills(skills.current);

  const mcpConf = loadMcpConfig(getCwd());
  for (const [name, cfg] of Object.entries(mcpConf)) {
    const client = new McpClient(name, cfg.command, cfg.args ?? [], cfg.env);
    try {
      await client.initialize();
      const tools = await client.listTools();
      for (const tool of tools) {
        defaultToolRegistry.registerTool(
          new McpTool(tool.name, tool.description, client, tool.inputSchema),
        );
      }
      console.log(`MCP: ${tools.length} tools from "${name}"`);
    } catch (e: any) {
      console.error(`MCP "${name}": ${e.message}`);
    }
  }

  hooks.run('SessionStart');

  return { hooks, consent, skills };
}
