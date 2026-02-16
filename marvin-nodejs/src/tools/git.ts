/**
 * Git Operations Tools
 * git_status, git_diff, git_commit, git_log, git_checkout
 */

import { z } from 'zod';
import { defineTool } from './base.js';
import { simpleGit, SimpleGit } from 'simple-git';
import { toolRegistry } from './base.js';
import { logger } from '../utils/logger.js';

function getGit(): SimpleGit | null {
  const workingDir = toolRegistry.getContext().workingDir;
  if (!workingDir) {
    return null;
  }
  return simpleGit(workingDir);
}

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'Show git status of the working directory.',
  parameters: z.object({}),
  readonly: true,
  
  async execute() {
    const git = getGit();
    if (!git) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    try {
      const status = await git.status();
      const lines: string[] = ['Git status:'];
      
      if (status.not_added.length > 0) {
        lines.push('\nUntracked files:');
        for (const f of status.not_added) lines.push(`  ${f}`);
      }
      
      if (status.modified.length > 0) {
        lines.push('\nModified files:');
        for (const f of status.modified) lines.push(`  ${f}`);
      }
      
      if (status.staged.length > 0) {
        lines.push('\nStaged files:');
        for (const f of status.staged) lines.push(`  ${f}`);
      }
      
      if (status.renamed.length > 0) {
        lines.push('\nRenamed files:');
        for (const f of status.renamed) lines.push(`  ${f.from} -> ${f.to}`);
      }
      
      if (lines.length === 1) {
        lines.push('Working directory clean');
      }
      
      lines.push(`\nOn branch: ${status.current || 'unknown'}`);
      
      return lines.join('\n');
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description: 'Show git diff. Use staged=true for staged changes, or path for a specific file.',
  parameters: z.object({
    staged: z.boolean().default(false).describe('Show staged changes only'),
    path: z.string().optional().describe('Specific file to diff'),
  }),
  readonly: true,
  
  async execute({ staged, path }) {
    const git = getGit();
    if (!git) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    try {
      let diff = '';
      if (staged) {
        diff = await git.diff(['--cached', path || '.']);
      } else {
        diff = await git.diff([path || '.']);
      }
      
      return diff || 'No changes.';
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const gitCommitTool = defineTool({
  name: 'git_commit',
  description: 'Stage and commit changes. Acquires directory lock.',
  parameters: z.object({
    message: z.string().describe('Commit message'),
    add_all: z.boolean().default(true).describe('Stage all changes before committing'),
  }),
  requiresTicket: true,
  readonly: false,
  
  async execute({ message, add_all }) {
    const git = getGit();
    if (!git) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    try {
      if (add_all) {
        await git.add('.');
      }
      
      const result = await git.commit(message);
      logger.info(`Git commit: ${message}`);
      
      return `Committed: ${message}\n${result.commit}`;
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const gitLogTool = defineTool({
  name: 'git_log',
  description: 'Show recent git commits.',
  parameters: z.object({
    max_count: z.number().default(10).describe('Number of commits to show'),
    oneline: z.boolean().default(true).describe('One-line format'),
  }),
  readonly: true,
  
  async execute({ max_count, oneline }) {
    const git = getGit();
    if (!git) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    try {
      const log = await git.log({ maxCount: max_count });
      
      if (oneline) {
        return log.all.map(c => `${c.hash.substring(0, 7)} ${c.message}`).join('\n');
      }
      
      return log.all.map(c => 
        `commit ${c.hash}\nAuthor: ${c.author_name} <${c.author_email}>\nDate: ${c.date}\n\n    ${c.message}\n`
      ).join('\n');
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const gitCheckoutTool = defineTool({
  name: 'git_checkout',
  description: 'Checkout a branch, commit, or file. Acquires directory lock for safety.',
  parameters: z.object({
    target: z.string().describe('Branch name, commit hash, or file path to checkout'),
    create_branch: z.boolean().default(false).describe('Create a new branch'),
  }),
  requiresTicket: true,
  readonly: false,
  
  async execute({ target, create_branch }) {
    const git = getGit();
    if (!git) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    try {
      if (create_branch) {
        await git.checkoutLocalBranch(target);
        return `Created and switched to branch: ${target}`;
      } else {
        await git.checkout(target);
        return `Checked out: ${target}`;
      }
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
