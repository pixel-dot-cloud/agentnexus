import type { ToolResult } from '../tools.js';
import { BaseTool } from '../tools.js';
import type { Skill } from '../lib/skills.js';

export class SkillTool extends BaseTool {
  name        = 'invoke_skill';
  description = 'Invoke a named skill to perform a specialized task. Use when the user asks for something that matches a skill description.';
  usage       = 'invoke_skill({"name":"commit","args":"fix typo"})';
  schema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name to invoke' },
      args: { type: 'string', description: 'Optional arguments or context for the skill' },
    },
    required: ['name'],
  };

  constructor(private getSkills: () => Skill[]) {
    super();
  }

  async execute(input: { name: string; args?: string }): Promise<ToolResult> {
    const skill = this.getSkills().find(s => s.name === input.name);
    if (!skill) {
      const names = this.getSkills().map(s => s.name).join(', ');
      return { success: false, output: '', error: `Skill "${input.name}" not found. Available: ${names}` };
    }
    const prompt = input.args
      ? `${skill.prompt}\n\nAdditional context/args: ${input.args}`
      : skill.prompt;
    return { success: true, output: `SKILL_EXPAND:${prompt}` };
  }
}
