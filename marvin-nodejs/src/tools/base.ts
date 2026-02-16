/**
 * Base Tool Interface
 * All tools must implement this interface
 */

import { z } from 'zod';

// Schema for tool parameters
export type ToolParameters = z.ZodObject<Record<string, z.ZodTypeAny>>;

// Tool definition
export interface Tool<TParams extends ToolParameters = ToolParameters> {
  /** Unique tool name */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** Zod schema for parameter validation */
  parameters: TParams;
  
  /** Whether this tool requires a ticket to be created first (for write operations) */
  requiresTicket?: boolean;
  
  /** Whether this tool is read-only */
  readonly?: boolean;
  
  /** Execute the tool with given parameters */
  execute(args: z.infer<TParams>): Promise<string>;
}

// Tool call result
export interface ToolCall {
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface ToolCallResult {
  success: boolean;
  result: string;
  error?: string;
}

// Helper to create tool definitions
export function defineTool<TParams extends ToolParameters>(config: {
  name: string;
  description: string;
  parameters: TParams;
  requiresTicket?: boolean;
  readonly?: boolean;
  execute: (args: z.infer<TParams>) => Promise<string>;
}): Tool<TParams> {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    requiresTicket: config.requiresTicket ?? false,
    readonly: config.readonly ?? true,
    execute: config.execute,
  };
}

// Tool context passed to tool execution
export interface ToolContext {
  workingDir?: string;
  profile: string;
  nonInteractive: boolean;
  ticketCreated: boolean;
  ticketId?: string;
}

// Tool registry
class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private context: ToolContext = {
    profile: 'main',
    nonInteractive: false,
    ticketCreated: false,
  };

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  registerMultiple(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getAllDefinitions(): Array<{
    name: string;
    description: string;
    parameters: unknown;
  }> {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: this.zodToJsonSchema(tool.parameters),
    }));
  }

  setContext(context: Partial<ToolContext>): void {
    this.context = { ...this.context, ...context };
  }

  getContext(): ToolContext {
    return { ...this.context };
  }

  markTicketCreated(ticketId: string): void {
    this.context.ticketCreated = true;
    this.context.ticketId = ticketId;
  }

  private zodToJsonSchema(schema: z.ZodTypeAny): unknown {
    // Simple conversion - in production, use zod-to-json-schema
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape as Record<string, z.ZodTypeAny>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = this.zodTypeToJsonSchema(value);
        if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }

    return { type: 'object' };
  }

  private zodTypeToJsonSchema(schema: z.ZodTypeAny): unknown {
    if (schema instanceof z.ZodString) return { type: 'string' };
    if (schema instanceof z.ZodNumber) return { type: 'number' };
    if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
    if (schema instanceof z.ZodArray) return { type: 'array', items: this.zodTypeToJsonSchema(schema.element) };
    if (schema instanceof z.ZodOptional) return this.zodTypeToJsonSchema(schema.unwrap());
    if (schema instanceof z.ZodDefault) return this.zodTypeToJsonSchema(schema.removeDefault());
    if (schema instanceof z.ZodNullable) return { ...this.zodTypeToJsonSchema(schema.unwrap()), nullable: true };
    return { type: 'string' };
  }
}

export const toolRegistry = new ToolRegistry();
