import type { ToolResult } from '../tools.js';
import { BaseTool } from '../tools.js';

export type TodoStatus   = 'pending' | 'in_progress' | 'completed';
export type TodoPriority = 'high' | 'medium' | 'low';

export interface TodoItem {
  id:       string;
  content:  string;
  status:   TodoStatus;
  priority: TodoPriority;
}

let _todos: TodoItem[] = [];

function formatTodos(items: TodoItem[]): string {
  if (!items.length) return '(no todos)';
  return items.map((t, i) => {
    const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
    const pri  = t.priority === 'high' ? '!' : t.priority === 'low' ? '·' : ' ';
    return `${i + 1}. ${mark} ${pri} ${t.content}  (id: ${t.id})`;
  }).join('\n');
}

export class TodoTool extends BaseTool {
  name        = 'todo_write';
  description = 'Write or replace the multi-step task list. Acknowledged silently — does NOT return the list back. Use todo_read to view it.';
  usage       = 'todo_write({"todos":[{"id":"1","content":"task","status":"pending","priority":"high"}]})';
  schema = {
    type: 'object',
    properties: {
      todos: {
        type:  'array',
        items: {
          type: 'object',
          properties: {
            id:       { type: 'string' },
            content:  { type: 'string' },
            status:   { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['id', 'content', 'status', 'priority'],
        },
      },
    },
    required: ['todos'],
  };

  constructor(private onUpdate: (todos: TodoItem[]) => void) {
    super();
  }

  async execute(args: { todos: TodoItem[] }): Promise<ToolResult> {
    if (!Array.isArray(args.todos)) {
      return { success: false, output: '', error: 'todos must be an array' };
    }
    _todos = args.todos;
    this.onUpdate(args.todos);
    return { success: true, output: 'ok' };
  }
}

export class TodoReadTool extends BaseTool {
  name        = 'todo_read';
  description = 'Return the current multi-step task list. Use when you need to see remaining work after todo_write.';
  usage       = 'todo_read({})';
  schema = {
    type: 'object',
    properties: {},
  };

  async execute(): Promise<ToolResult> {
    return { success: true, output: formatTodos(_todos) };
  }
}
