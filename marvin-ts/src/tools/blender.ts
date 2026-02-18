import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerBlenderTools(registry: ToolRegistry): void {
  registry.registerTool(
    'blender_get_scene',
    'Get current Blender scene info via MCP',
    z.object({}),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'blender_get_object',
    'Get Blender object details',
    z.object({
      name: z.string().describe('Object name'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'blender_create_object',
    'Create a primitive 3D object in Blender',
    z.object({
      type: z.string().describe('Primitive type (cube, sphere, etc.)'),
      name: z.string().default('').describe('Object name'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'blender_modify_object',
    'Modify object position/scale/rotation',
    z.object({
      name: z.string().describe('Object name'),
      property: z.string().describe('Property to modify'),
      value: z.string().describe('New value'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'blender_delete_object',
    'Delete a Blender object by name',
    z.object({
      name: z.string().describe('Object name to delete'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'blender_set_material',
    'Apply material/color to a Blender object',
    z.object({
      name: z.string().describe('Object name'),
      color: z.string().describe('RGBA color'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'blender_execute_code',
    'Execute Python code in Blender',
    z.object({
      code: z.string().describe('Python code to execute'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'blender_screenshot',
    'Capture viewport screenshot from Blender',
    z.object({}),
    async () => 'Not yet implemented',
    'always',
  );
}
