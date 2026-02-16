/**
 * File Operations Tools
 * create_file, read_file, apply_patch, append_file, code_grep, tree
 */

import { z } from 'zod';
import { defineTool } from './base.js';
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, readdirSync, mkdirSync } from 'fs';
import { join, resolve, isAbsolute, dirname, relative } from 'path';
import { globSync } from 'glob';
import { toolRegistry } from './base.js';
import { colors } from '../utils/colors.js';
import { logger } from '../utils/logger';

// ============================================================================
// Path Security Helpers
// ============================================================================

function isPathSafe(filePath: string, workingDir: string): { safe: boolean; reason?: string } {
  // Reject absolute paths
  if (isAbsolute(filePath)) {
    return { safe: false, reason: 'Absolute paths are not allowed. Use relative paths from the working directory.' };
  }

  // Reject path traversal
  if (filePath.includes('..')) {
    return { safe: false, reason: 'Path traversal (..) is not allowed.' };
  }

  // Reject .tickets/ directory
  if (filePath.startsWith('.tickets/') || filePath.includes('/.tickets/')) {
    return { safe: false, reason: 'The .tickets/ directory is protected. Use the tk tool instead.' };
  }

  // Ensure resolved path is within working directory
  const resolved = resolve(workingDir, filePath);
  const relativeToWork = relative(workingDir, resolved);
  if (relativeToWork.startsWith('..') || isAbsolute(relativeToWork)) {
    return { safe: false, reason: 'Path escapes working directory.' };
  }

  return { safe: true };
}

function getTreeView(dirPath: string, maxDepth = 3, currentDepth = 0): string {
  if (currentDepth > maxDepth) return '';

  const items = readdirSync(dirPath, { withFileTypes: true });
  const lines: string[] = [];

  for (const item of items) {
    const indent = '  '.repeat(currentDepth);
    if (item.isDirectory()) {
      lines.push(`${indent}${item.name}/`);
      if (currentDepth < maxDepth) {
        try {
          const subTree = getTreeView(join(dirPath, item.name), maxDepth, currentDepth + 1);
          if (subTree) lines.push(subTree);
        } catch {
          // Permission denied, skip
        }
      }
    } else {
      lines.push(`${indent}${item.name}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Tools
// ============================================================================

export const createFileTool = defineTool({
  name: 'create_file',
  description: 'Create a new file with the given content. Fails if the file already exists (use apply_patch to edit). Parameters: path (RELATIVE to working dir, e.g. \'src/app.ts\' — NO absolute paths), content (the full file text — REQUIRED, must not be empty). For large files (>3000 words), write the first section with create_file, then use append_file for remaining sections.',
  parameters: z.object({
    path: z.string().describe('File path relative to working directory (no absolute paths)'),
    content: z.string().describe('File content to write. REQUIRED — include the full file content.'),
  }),
  requiresTicket: true,
  readonly: false,
  
  async execute({ path, content }) {
    const workingDir = toolRegistry.getContext().workingDir;
    if (!workingDir) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    const safety = isPathSafe(path, workingDir);
    if (!safety.safe) {
      return `ERROR: ${safety.reason}\n\nWorking directory: ${workingDir}\n\nDirectory structure:\n${getTreeView(workingDir, 2)}`;
    }

    const fullPath = join(workingDir, path);

    if (existsSync(fullPath)) {
      return `ERROR: File already exists: ${path}\n\nUse apply_patch to edit existing files, or delete the file first.`;
    }

    try {
      // Ensure parent directory exists
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      logger.info(`Created file: ${path} (${content.length} bytes)`);
      return `Created ${path} (${content.length} bytes)`;
    } catch (error) {
      return `ERROR creating file: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const readFileTool = defineTool({
  name: 'read_file',
  description: "Read a file's contents with line numbers. Parameters: path (RELATIVE to working dir, e.g. 'src/app.ts' or '.marvin/upstream/README.md' — NO absolute paths), start_line (optional, 1-based), end_line (optional, 1-based inclusive). Use start_line/end_line to read specific sections of large files. Tip: read the exact lines you need before calling apply_patch, so you can copy the precise old_str.",
  parameters: z.object({
    path: z.string().describe("Relative path to file (e.g. 'src/app.ts', '.marvin/upstream/README.md'). NO absolute paths."),
    start_line: z.number().optional().describe('Start line (1-based)'),
    end_line: z.number().optional().describe('End line (1-based, inclusive). 0 or omitted = read to end of file.'),
  }),
  readonly: true,
  
  async execute({ path, start_line, end_line }) {
    const workingDir = toolRegistry.getContext().workingDir;
    if (!workingDir) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    const safety = isPathSafe(path, workingDir);
    if (!safety.safe) {
      return `ERROR: ${safety.reason}\n\nWorking directory: ${workingDir}`;
    }

    const fullPath = join(workingDir, path);

    if (!existsSync(fullPath)) {
      return `ERROR: File not found: ${path}`;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      
      // Check file size guard (>10KB requires line ranges)
      const size = statSync(fullPath).size;
      if (size > 10 * 1024 && (start_line === undefined || end_line === undefined)) {
        return `File is too large to read in full (${lines.length} lines, ${Math.round(size / 1024)}KB). Use start_line and end_line to read a section at a time.\nExample: read_file(path='${path}', start_line=1, end_line=100)`;
      }

      const start = (start_line ?? 1) - 1;
      const end = end_line ? end_line : lines.length;
      const selectedLines = lines.slice(start, end);

      // Format with line numbers
      const lineNumWidth = String(end).length;
      const numberedLines = selectedLines.map((line, idx) => {
        const lineNum = start + idx + 1;
        return `${String(lineNum).padStart(lineNumWidth)} | ${line}`;
      });

      return numberedLines.join('\n');
    } catch (error) {
      return `ERROR reading file: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description: "Edit a file by replacing an exact string match with new content. Requires 3 parameters: path (RELATIVE to working dir — NO absolute paths), old_str (exact text to find — copy/paste from the file, whitespace-sensitive), new_str (replacement text). old_str must match exactly ONE location. Use read_file first to get the exact text.",
  parameters: z.object({
    path: z.string().describe('File path relative to working directory (no absolute paths)'),
    old_str: z.string().describe('Exact string to find in the file (must match exactly). REQUIRED.'),
    new_str: z.string().describe('Replacement string. REQUIRED (use empty string to delete).'),
  }),
  requiresTicket: true,
  readonly: false,
  
  async execute({ path, old_str, new_str }) {
    const workingDir = toolRegistry.getContext().workingDir;
    if (!workingDir) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    const safety = isPathSafe(path, workingDir);
    if (!safety.safe) {
      return `ERROR: ${safety.reason}\n\nWorking directory: ${workingDir}`;
    }

    const fullPath = join(workingDir, path);

    if (!existsSync(fullPath)) {
      return `ERROR: File not found: ${path}`;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      
      // Count matches
      const matches = content.split(old_str).length - 1;
      if (matches === 0) {
        return `ERROR: Could not find the text to replace in ${path}. The old_str must match exactly (whitespace-sensitive).`;
      }
      if (matches > 1) {
        return `ERROR: Found ${matches} matches for the text in ${path}. old_str must match exactly ONE location. Try including more context.`;
      }

      const newContent = content.replace(old_str, new_str);
      writeFileSync(fullPath, newContent, 'utf-8');
      
      logger.info(`Patched file: ${path}`);
      return `Applied patch to ${path}`;
    } catch (error) {
      return `ERROR applying patch: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const appendFileTool = defineTool({
  name: 'append_file',
  description: 'Append content to an existing file (file must already exist — use create_file first). Parameters: path (relative to working dir), content (text to append — REQUIRED, must not be empty). Use this after create_file for large files (>3000 words).',
  parameters: z.object({
    path: z.string().describe('File path relative to working directory (no absolute paths)'),
    content: z.string().describe('Content to append to the file. REQUIRED.'),
  }),
  requiresTicket: true,
  readonly: false,
  
  async execute({ path, content }) {
    const workingDir = toolRegistry.getContext().workingDir;
    if (!workingDir) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    const safety = isPathSafe(path, workingDir);
    if (!safety.safe) {
      return `ERROR: ${safety.reason}\n\nWorking directory: ${workingDir}`;
    }

    const fullPath = join(workingDir, path);

    if (!existsSync(fullPath)) {
      return `ERROR: File does not exist: ${path}\n\nUse create_file first, then append_file.`;
    }

    try {
      appendFileSync(fullPath, content, 'utf-8');
      logger.info(`Appended to file: ${path} (${content.length} bytes)`);
      return `Appended to ${path} (${content.length} bytes)`;
    } catch (error) {
      return `ERROR appending to file: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const codeGrepTool = defineTool({
  name: 'code_grep',
  description: "Search for a regex pattern in files within the working directory. Returns matching lines with file paths, line numbers, and context.",
  parameters: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    glob_filter: z.string().optional().describe("Glob pattern to filter files (e.g. '*.py', '*.ts')"),
    context_lines: z.number().default(2).describe('Lines of context before and after match'),
    max_results: z.number().default(20).describe('Maximum matches to return'),
  }),
  readonly: true,
  
  async execute({ pattern, glob_filter, context_lines, max_results }) {
    const workingDir = toolRegistry.getContext().workingDir;
    if (!workingDir) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    try {
      const globPattern = glob_filter || '**/*';
      const files = globSync(globPattern, { 
        cwd: workingDir, 
        nodir: true,
        ignore: ['node_modules/**', '.git/**', 'dist/**'],
      });

      const regex = new RegExp(pattern, 'g');
      const results: string[] = [];
      let matchCount = 0;

      for (const file of files.slice(0, 100)) { // Limit files scanned
        if (matchCount >= max_results) break;

        const fullPath = join(workingDir, file);
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              if (matchCount >= max_results) break;
              
              matchCount++;
              const lineNum = i + 1;
              const startContext = Math.max(0, i - context_lines);
              const endContext = Math.min(lines.length, i + context_lines + 1);
              
              results.push(`${file}:${lineNum}`);
              for (let j = startContext; j < endContext; j++) {
                const prefix = j === i ? '>' : ' ';
                results.push(`${prefix} ${j + 1}: ${lines[j]}`);
              }
              results.push('');
            }
            // Reset regex lastIndex for next line
            regex.lastIndex = 0;
          }
        } catch {
          // Skip files that can't be read
        }
      }

      if (results.length === 0) {
        return `No matches found for pattern: ${pattern}`;
      }

      return results.join('\n');
    } catch (error) {
      return `ERROR searching files: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const treeTool = defineTool({
  name: 'tree',
  description: 'List directory tree structure. Respects .gitignore by default.',
  parameters: z.object({
    path: z.string().default('.').describe('Directory to list (relative to working dir)'),
    max_depth: z.number().default(3).describe('Maximum depth to traverse'),
    respect_gitignore: z.boolean().default(true).describe('Skip .gitignore\'d files'),
  }),
  readonly: true,
  
  async execute({ path, max_depth, respect_gitignore }) {
    const workingDir = toolRegistry.getContext().workingDir;
    if (!workingDir) {
      return 'ERROR: No working directory set. Call set_working_dir first.';
    }

    const safety = isPathSafe(path, workingDir);
    if (!safety.safe) {
      return `ERROR: ${safety.reason}`;
    }

    const fullPath = join(workingDir, path);

    if (!existsSync(fullPath)) {
      return `ERROR: Directory not found: ${path}`;
    }

    try {
      const tree = getTreeView(fullPath, max_depth);
      return tree || '(empty directory)';
    } catch (error) {
      return `ERROR listing directory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const setWorkingDirTool = defineTool({
  name: 'set_working_dir',
  description: 'Set the working directory for coding operations. All file paths will be relative to this.',
  parameters: z.object({
    path: z.string().describe('Absolute path to the working directory for coding operations'),
  }),
  readonly: true,
  
  async execute({ path }) {
    if (!isAbsolute(path)) {
      return 'ERROR: Path must be absolute. Provide a full path like /home/user/myproject';
    }

    if (!existsSync(path)) {
      return `ERROR: Directory does not exist: ${path}`;
    }

    toolRegistry.setContext({ workingDir: path });
    logger.info(`Working directory set to: ${path}`);
    return `Working directory set to: ${path}`;
  },
});

export const getWorkingDirTool = defineTool({
  name: 'get_working_dir',
  description: 'Get the current working directory for coding operations.',
  parameters: z.object({}),
  readonly: true,
  
  async execute() {
    const workingDir = toolRegistry.getContext().workingDir;
    if (!workingDir) {
      return 'No working directory set.';
    }
    return workingDir;
  },
});
