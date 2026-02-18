import type { ToolDef } from '../types.js';

export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDef[] {
    return Array.from(this.tools.values());
  }
}
