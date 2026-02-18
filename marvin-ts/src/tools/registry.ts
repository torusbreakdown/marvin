import { ZodObject, ZodType, ZodOptional, ZodDefault, ZodEnum, ZodString, ZodNumber, ZodBoolean, ZodArray, type ZodRawShape } from 'zod';
import type { ToolDef, ToolContext, OpenAIFunctionDef } from '../types.js';

export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  registerTool<T extends ZodRawShape>(
    name: string,
    description: string,
    schema: ZodObject<T>,
    handler: (args: any, ctx: ToolContext) => Promise<string>,
    category: ToolDef['category'],
  ): void {
    this.tools.set(name, { name, description, schema, handler, category });
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  getTools(category?: ToolDef['category']): ToolDef[] {
    const all = Array.from(this.tools.values());
    if (!category) return all;
    return all.filter(t => t.category === category);
  }

  getToolsMulti(filter: { categories?: ToolDef['category'][]; names?: Set<string> }): ToolDef[] {
    const all = Array.from(this.tools.values());
    return all.filter(t => {
      if (filter.categories && filter.categories.includes(t.category)) return true;
      if (filter.names && filter.names.has(t.name)) return true;
      return false;
    });
  }

  getAll(): ToolDef[] {
    return this.getTools();
  }

  getOpenAISchemas(category?: ToolDef['category']): OpenAIFunctionDef[] {
    return this.getTools(category).map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.schema),
      },
    }));
  }

  getOpenAISchemasMulti(filter: { categories?: ToolDef['category'][]; names?: Set<string> }): OpenAIFunctionDef[] {
    return this.getToolsMulti(filter).map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.schema),
      },
    }));
  }

  getOpenAISchemasExclude(exclude: Set<string>): OpenAIFunctionDef[] {
    return this.getTools('always')
      .filter(t => !exclude.has(t.name))
      .map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: zodToJsonSchema(tool.schema),
        },
      }));
  }

  async executeTool(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Unknown tool: ${name}. Available tools: ${[...this.tools.keys()].join(', ')}`;
    }

    // Tool gating: coding-only tools require codingMode
    if (tool.category === 'coding' && !ctx.codingMode) {
      return `Error: '${name}' is only available in coding mode. Enable coding mode first.`;
    }

    let args: unknown = rawArgs;

    // SHARP_EDGES §1: If args is a string, try JSON.parse
    if (typeof args === 'string') {
      const strArgs = args as string;

      // Check for Codex patch format
      if (strArgs.includes('*** Begin Patch') && name === 'apply_patch') {
        // Pass raw patch to handler as special __raw_patch field
        try {
          return await tool.handler({ __raw_patch: strArgs }, ctx);
        } catch (err: any) {
          return `Error executing ${name}: ${err.message}`;
        }
      }

      try {
        args = JSON.parse(strArgs);
      } catch {
        // Non-JSON string — return helpful error with expected schema
        const schema = zodToJsonSchema(tool.schema);
        const fields = Object.entries(schema.properties)
          .map(([k, v]: [string, any]) => `  ${k}: ${v.type || 'unknown'}${schema.required.includes(k) ? ' (required)' : ' (optional)'}`)
          .join('\n');
        return `Error: Invalid JSON arguments for '${name}'. Expected a JSON object with:\n${fields}\n\nExample: ${JSON.stringify(exampleFromSchema(schema))}`;
      }
    }

    // Validate with Zod schema
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map(iss => `  - ${iss.path.join('.')}: ${iss.message} (expected ${iss.code === 'invalid_type' ? (iss as any).expected : 'valid value'})`)
        .join('\n');
      return `Error: Invalid arguments for '${name}':\n${issues}`;
    }

    // Execute handler
    try {
      return await tool.handler(parsed.data, ctx);
    } catch (err: any) {
      return `Error executing ${name}: ${err.message}`;
    }
  }
}

function zodTypeToJsonSchema(zodType: ZodType): Record<string, unknown> {
  // Unwrap optional
  if (zodType instanceof ZodOptional) {
    return zodTypeToJsonSchema((zodType as any)._def.innerType);
  }
  // Unwrap default
  if (zodType instanceof ZodDefault) {
    return zodTypeToJsonSchema((zodType as any)._def.innerType);
  }
  if (zodType instanceof ZodString) {
    const result: Record<string, unknown> = { type: 'string' };
    if (zodType.description) result.description = zodType.description;
    return result;
  }
  if (zodType instanceof ZodNumber) {
    const result: Record<string, unknown> = { type: 'number' };
    if (zodType.description) result.description = zodType.description;
    return result;
  }
  if (zodType instanceof ZodBoolean) {
    const result: Record<string, unknown> = { type: 'boolean' };
    if (zodType.description) result.description = zodType.description;
    return result;
  }
  if (zodType instanceof ZodEnum) {
    const result: Record<string, unknown> = {
      type: 'string',
      enum: (zodType as any)._def.values,
    };
    if (zodType.description) result.description = zodType.description;
    return result;
  }
  if (zodType instanceof ZodArray) {
    const result: Record<string, unknown> = {
      type: 'array',
      items: zodTypeToJsonSchema((zodType as any)._def.type),
    };
    if (zodType.description) result.description = zodType.description;
    return result;
  }
  if (zodType instanceof ZodObject) {
    return zodToJsonSchema(zodType);
  }
  // Fallback
  return { type: 'string' };
}

function zodToJsonSchema(schema: ZodObject<any>): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    // SECURITY: Strip __test_ prefixed fields from schemas sent to LLM.
    // These are internal test hooks that should never be exposed to the model.
    if (key.startsWith('__')) continue;

    const zodField = value as ZodType;
    const prop = zodTypeToJsonSchema(zodField);

    // Add description from the top-level field (may be on the wrapper)
    if (zodField.description && !prop.description) {
      prop.description = zodField.description;
    }

    properties[key] = prop;

    // A field is required if it's not optional and not defaulted
    if (!(zodField instanceof ZodOptional) && !(zodField instanceof ZodDefault)) {
      required.push(key);
    }
  }

  return { type: 'object', properties, required };
}

function exampleFromSchema(schema: { properties: Record<string, any>; required: string[] }): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.type === 'string') example[key] = `<${key}>`;
    else if (prop.type === 'number') example[key] = 0;
    else if (prop.type === 'boolean') example[key] = false;
    else example[key] = `<${key}>`;
  }
  return example;
}
