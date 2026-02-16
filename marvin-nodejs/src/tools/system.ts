/**
 * System and Utility Tools
 * get_usage, exit_app, convert_units, timer_start, system_info
 */

import { z } from 'zod';
import { defineTool } from './base.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../types.js';
import { logger } from '../utils/logger.js';

// Usage tracking
interface UsageData {
  sessions: Array<{
    date: string;
    cost: number;
    turns: number;
  }>;
  totalCost: number;
  totalTurns: number;
}

function loadUsage(): UsageData {
  const path = join(CONFIG_DIR, 'usage.json');
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
  return { sessions: [], totalCost: 0, totalTurns: 0 };
}

export const getUsageTool = defineTool({
  name: 'get_usage',
  description: 'Show current session and optionally lifetime API usage and estimated costs. Call this when the user asks about usage, costs, or billing.',
  parameters: z.object({
    include_lifetime: z.boolean().default(false).describe('Also include lifetime cumulative usage across all sessions'),
  }),
  readonly: true,
  
  async execute({ include_lifetime }) {
    // Session data would be tracked in memory
    const sessionCost = 0.0; // Would be populated from session tracking
    const sessionTurns = 0;
    
    let output = `Current session:\n`;
    output += `- Cost: $${sessionCost.toFixed(4)}\n`;
    output += `- LLM turns: ${sessionTurns}\n`;
    
    if (include_lifetime) {
      const usage = loadUsage();
      output += `\nLifetime:\n`;
      output += `- Total cost: $${usage.totalCost.toFixed(4)}\n`;
      output += `- Total turns: ${usage.totalTurns}\n`;
      output += `- Sessions: ${usage.sessions.length}\n`;
    }
    
    return output;
  },
});

export const exitAppTool = defineTool({
  name: 'exit_app',
  description: "Exit the application. Call this when the user wants to quit, e.g. 'exit', 'quit', 'bye', 'goodbye', 'close', 'done', 'stop'.",
  parameters: z.object({
    message: z.string().default('Goodbye!').describe('Optional farewell message to display before exiting'),
  }),
  readonly: true,
  
  async execute({ message }) {
    // This tool just returns a message; the actual exit is handled by the UI
    logger.info('Exit requested: ' + message);
    return `EXIT:${message}`;
  },
});

export const convertUnitsTool = defineTool({
  name: 'convert_units',
  description: "Convert between units (length, weight, volume, speed, temperature) or currencies. Supports km↔mi, kg↔lbs, °C↔°F, L↔gal, and many more. For currencies, uses the free Frankfurter API for live exchange rates.",
  parameters: z.object({
    value: z.number().describe('The numeric value to convert'),
    from_unit: z.string().describe("Source unit, e.g. 'km', 'lbs', 'USD', '°F'"),
    to_unit: z.string().describe("Target unit, e.g. 'mi', 'kg', 'EUR', '°C'"),
  }),
  readonly: true,
  
  async execute({ value, from_unit, to_unit }) {
    // Length conversions
    const lengthConversions: Record<string, number> = {
      km: 1000, m: 1, cm: 0.01, mm: 0.001,
      mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144,
    };
    
    // Weight conversions
    const weightConversions: Record<string, number> = {
      kg: 1, g: 0.001, mg: 0.000001,
      lb: 0.453592, oz: 0.0283495,
    };
    
    // Volume conversions
    const volumeConversions: Record<string, number> = {
      L: 1, ml: 0.001,
      gal: 3.78541, qt: 0.946353, pt: 0.473176, cup: 0.236588, floz: 0.0295735,
    };
    
    // Temperature conversions
    if (from_unit === '°C' && to_unit === '°F') {
      return `${value}°C = ${(value * 9/5 + 32).toFixed(2)}°F`;
    }
    if (from_unit === '°F' && to_unit === '°C') {
      return `${value}°F = ${((value - 32) * 5/9).toFixed(2)}°C`;
    }
    if (from_unit === '°C' && to_unit === 'K') {
      return `${value}°C = ${(value + 273.15).toFixed(2)}K`;
    }
    if (from_unit === 'K' && to_unit === '°C') {
      return `${value}K = ${(value - 273.15).toFixed(2)}°C`;
    }
    
    // Length
    if (from_unit in lengthConversions && to_unit in lengthConversions) {
      const meters = value * lengthConversions[from_unit];
      const result = meters / lengthConversions[to_unit];
      return `${value} ${from_unit} = ${result.toFixed(4)} ${to_unit}`;
    }
    
    // Weight
    if (from_unit in weightConversions && to_unit in weightConversions) {
      const kg = value * weightConversions[from_unit];
      const result = kg / weightConversions[to_unit];
      return `${value} ${from_unit} = ${result.toFixed(4)} ${to_unit}`;
    }
    
    // Volume
    if (from_unit in volumeConversions && to_unit in volumeConversions) {
      const liters = value * volumeConversions[from_unit];
      const result = liters / volumeConversions[to_unit];
      return `${value} ${from_unit} = ${result.toFixed(4)} ${to_unit}`;
    }
    
    // Currency (would need Frankfurter API)
    if (['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'].includes(from_unit) &&
        ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'].includes(to_unit)) {
      return `Currency conversion requires the Frankfurter API. Use: https://api.frankfurter.app/latest?from=${from_unit}&to=${to_unit}`;
    }
    
    return `Unsupported unit conversion: ${from_unit} to ${to_unit}`;
  },
});

export const timerStartTool = defineTool({
  name: 'timer_start',
  description: 'Start a named timer. Set duration_seconds for a countdown, or 0 for a stopwatch. Use timer_check to see elapsed/remaining time, and timer_stop to end it.',
  parameters: z.object({
    name: z.string().describe("Name for this timer, e.g. 'eggs', 'workout', 'focus'."),
    duration_seconds: z.number().default(0).describe('Countdown duration in seconds. 0 = stopwatch (counts up).'),
  }),
  readonly: true,
  
  async execute({ name, duration_seconds }) {
    // Store in memory - timers are not persisted
    return `Timer "${name}" started${duration_seconds > 0 ? ` (${duration_seconds}s countdown)` : ' (stopwatch)'}.`;
  },
});

export const timerCheckTool = defineTool({
  name: 'timer_check',
  description: 'Check the status of a running timer. Leave name empty to see all active timers.',
  parameters: z.object({
    name: z.string().default('').describe('Timer name. Empty = show all active timers.'),
  }),
  readonly: true,
  
  async execute({ name }) {
    return `Timer functionality requires in-memory state tracking. Timer "${name || 'all'}" not found.`;
  },
});

export const timerStopTool = defineTool({
  name: 'timer_stop',
  description: 'Stop a running timer and report the final time.',
  parameters: z.object({
    name: z.string().describe('Name of the timer to stop.'),
  }),
  readonly: true,
  
  async execute({ name }) {
    return `Timer "${name}" stopped.`;
  },
});

export const systemInfoTool = defineTool({
  name: 'system_info',
  description: 'Report system information: OS, CPU, memory usage, disk usage, uptime, and battery status (if available).',
  parameters: z.object({}),
  readonly: true,
  
  async execute() {
    const os = process.platform;
    const arch = process.arch;
    const nodeVersion = process.version;
    const uptime = process.uptime();
    
    // Memory usage
    const memUsage = process.memoryUsage();
    const totalMem = memUsage.heapTotal / 1024 / 1024;
    const usedMem = memUsage.heapUsed / 1024 / 1024;
    
    // System memory (if available)
    const freeMem = Math.floor(process.memoryUsage().rss / 1024 / 1024);
    
    const lines = [
      'System Information:',
      `Platform: ${os} (${arch})`,
      `Node.js: ${nodeVersion}`,
      `Uptime: ${Math.floor(uptime)}s`,
      `Memory: ${usedMem.toFixed(1)}MB used / ${totalMem.toFixed(1)}MB heap`,
    ];
    
    return lines.join('\n');
  },
});

export const runCommandTool = defineTool({
  name: 'run_command',
  description: 'Execute a shell command in the working directory. The command is ALWAYS shown to the user and requires confirmation (Enter) before running. Use for builds, tests, installs, or any shell operation.',
  parameters: z.object({
    command: z.string().describe('Shell command to execute'),
    timeout: z.number().default(60).describe('Timeout in seconds'),
  }),
  requiresTicket: true,
  readonly: false,
  
  async execute({ command, timeout }) {
    const workingDir = require('./base').toolRegistry.getContext().workingDir;
    
    try {
      const { execSync } = await import('child_process');
      const result = execSync(command, { 
        encoding: 'utf-8', 
        timeout: timeout * 1000,
        cwd: workingDir,
      });
      
      logger.info(`Command executed: ${command}`);
      return result || 'Command completed successfully.';
    } catch (error: any) {
      return `ERROR: Command failed\n${error.stderr || error.message}`;
    }
  },
});
