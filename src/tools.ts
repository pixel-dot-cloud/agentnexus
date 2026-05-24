import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { ToolSpec } from './providers.js';
import { getCwd } from './lib/cwd.js';

const execAsync = promisify(exec);

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;
  abstract usage: string;
  abstract schema: Record<string, unknown>;
  readonly requiresConsent: boolean = false;
  abstract execute(args: any): Promise<ToolResult>;

  protected validateArgs(args: any, required: string[]): boolean {
    return required.every(key => args[key] !== undefined);
  }
}

export class ShellExecuteTool extends BaseTool {
  name = 'shell_execute';
  description = 'Execute shell commands and capture output';
  usage = 'shell_execute({"command":"ls -la"})';
  schema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run' },
      timeout: { type: 'number', description: 'Optional timeout in ms' },
    },
    required: ['command'],
  };
  readonly requiresConsent = true;

  async execute(args: { command: string; timeout?: number }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['command'])) {
      return { success: false, output: '', error: 'Missing required argument: command' };
    }
    try {
      const { stdout, stderr } = await execAsync(args.command, {
        timeout: args.timeout || 30000,
        maxBuffer: 1024 * 1024,
        cwd: getCwd(),
      });
      return {
        success: true,
        output: stdout || stderr || '(command executed with no output)',
      };
    } catch (error: any) {
      return {
        success: false,
        output: error.stdout || '',
        error: error.message || 'Command execution failed',
      };
    }
  }
}

export class FileReadTool extends BaseTool {
  name = 'file_read';
  description = 'Read file contents';
  usage = 'file_read({"path":"src/index.ts","maxLines":100})';
  schema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      maxLines: { type: 'number', description: 'Optional max lines' },
    },
    required: ['path'],
  };

  async execute(args: { path: string; maxLines?: number }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['path'])) {
      return { success: false, output: '', error: 'Missing required argument: path' };
    }
    try {
      const filePath = path.resolve(getCwd(), args.path);
      if (!fs.existsSync(filePath)) {
        return { success: false, output: '', error: `File not found: ${args.path}` };
      }
      let content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      if (args.maxLines && lines.length > args.maxLines) {
        content =
          lines.slice(0, args.maxLines).join('\n') +
          `\n... (truncated, ${lines.length - args.maxLines} more lines)`;
      }
      return { success: true, output: content };
    } catch (error: any) {
      return { success: false, output: '', error: error.message };
    }
  }
}

export class FileWriteTool extends BaseTool {
  name = 'file_write';
  description = 'Write content to a file';
  usage = 'file_write({"path":"out.txt","content":"hello","append":false})';
  schema = {
    type: 'object',
    properties: {
      path:    { type: 'string' },
      content: { type: 'string' },
      append:  { type: 'boolean' },
    },
    required: ['path', 'content'],
  };
  readonly requiresConsent = true;

  async execute(args: { path: string; content: string; append?: boolean }): Promise<ToolResult> {
    if (!this.validateArgs(args, ['path', 'content'])) {
      return { success: false, output: '', error: 'Missing required arguments: path, content' };
    }
    try {
      const filePath = path.resolve(getCwd(), args.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (args.append) fs.appendFileSync(filePath, args.content);
      else fs.writeFileSync(filePath, args.content);
      return {
        success: true,
        output: `File ${args.append ? 'appended to' : 'written to'}: ${args.path}`,
      };
    } catch (error: any) {
      return { success: false, output: '', error: error.message };
    }
  }
}

export class DirectoryListTool extends BaseTool {
  name = 'directory_list';
  description = 'List directory contents';
  usage = 'directory_list({"path":"."})';
  schema = {
    type: 'object',
    properties: {
      path:      { type: 'string' },
      recursive: { type: 'boolean' },
    },
  };

  async execute(args: { path?: string; recursive?: boolean }): Promise<ToolResult> {
    try {
      const dirPath = path.resolve(getCwd(), args.path || '.');
      if (!fs.existsSync(dirPath)) {
        return { success: false, output: '', error: `Directory not found: ${args.path ?? '.'}` };
      }
      const files = fs.readdirSync(dirPath);
      let output = `Contents of ${dirPath}:\n`;
      files.forEach(file => {
        try {
          const filePath = path.join(dirPath, file);
          const stat = fs.statSync(filePath);
          const type = stat.isDirectory() ? 'd' : 'f';
          const size = stat.isDirectory() ? '' : `  ${stat.size}b`;
          output += `  ${type}  ${file}${size}\n`;
        } catch {
          output += `  ?  ${file}\n`;
        }
      });
      return { success: true, output };
    } catch (error: any) {
      return { success: false, output: '', error: error.message };
    }
  }
}

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();

  registerTool(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): BaseTool[] {
    return Array.from(this.tools.values());
  }

  getToolSpecs(filter?: (t: BaseTool) => boolean): ToolSpec[] {
    return this.getAllTools()
      .filter(t => !filter || filter(t))
      .map(t => ({ name: t.name, description: t.description, schema: t.schema }));
  }

  clone(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const [, tool] of this.tools) copy.registerTool(tool);
    return copy;
  }

  async executeTool(name: string, args: any): Promise<ToolResult> {
    const tool = this.getTool(name);
    if (!tool) {
      return { success: false, output: '', error: `Tool not found: ${name}` };
    }
    return tool.execute(args);
  }
}

export const defaultToolRegistry = new ToolRegistry();
defaultToolRegistry.registerTool(new ShellExecuteTool());
defaultToolRegistry.registerTool(new FileReadTool());
defaultToolRegistry.registerTool(new FileWriteTool());
defaultToolRegistry.registerTool(new DirectoryListTool());
