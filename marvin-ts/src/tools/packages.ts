import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerPackagesTools(registry: ToolRegistry): void {
  registry.registerTool(
    'install_packages',
    'Install packages into the project virtual environment',
    z.object({
      packages: z.array(z.string()).describe('Package names to install'),
      dev: z.boolean().default(false).describe('Install as dev dependency'),
    }),
    async () => 'Not yet implemented',
    'coding',
  );
}
