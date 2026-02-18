import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ToolRegistry } from './registry.js';

export function registerPackagesTools(registry: ToolRegistry): void {
  registry.registerTool(
    'install_packages',
    'Install packages using the project package manager (npm, pip, or apt). Auto-detects from project files.',
    z.object({
      packages: z.array(z.string()).describe('Package names to install'),
      manager: z.string().default('auto').describe("Package manager: 'npm', 'pip', 'apt', or 'auto' to detect"),
      dev: z.boolean().default(false).describe('Install as dev dependency (npm --save-dev, pip: ignored)'),
    }),
    async (args, ctx) => {
      const { packages, dev } = args;
      let { manager } = args;
      const cwd = ctx.workingDir ?? process.cwd();

      if (!packages.length) return 'Error: no packages specified.';

      // Auto-detect package manager
      if (manager === 'auto') {
        if (existsSync(`${cwd}/package.json`)) manager = 'npm';
        else if (existsSync(`${cwd}/requirements.txt`) || existsSync(`${cwd}/setup.py`) || existsSync(`${cwd}/pyproject.toml`)) manager = 'pip';
        else manager = 'apt';
      }

      const pkgList = packages.join(' ');
      let cmd: string;
      if (manager === 'npm') {
        cmd = `npm install ${dev ? '--save-dev ' : ''}${pkgList}`;
      } else if (manager === 'pip') {
        cmd = `pip install ${pkgList}`;
      } else if (manager === 'apt') {
        cmd = `sudo apt-get install -y ${pkgList}`;
      } else {
        return `Unknown package manager: ${manager}. Use npm, pip, or apt.`;
      }

      try {
        const output = execSync(cmd, { encoding: 'utf-8', cwd, timeout: 120_000 });
        const lines = output.trim().split('\n');
        const summary = lines.length > 10 ? [...lines.slice(0, 3), '...', ...lines.slice(-5)].join('\n') : output.trim();
        return `Installed ${packages.length} package(s) via ${manager}:\n${summary}`;
      } catch (err: any) {
        return `Error installing packages via ${manager}: ${err.message?.slice(0, 500)}`;
      }
    },
    'coding',
  );
}
