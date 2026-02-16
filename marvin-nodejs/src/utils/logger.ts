/**
 * Structured logging with retro terminal styling
 */

import { colors } from './colors';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  context?: Record<string, unknown>;
}

class Logger {
  private level: LogLevel = LogLevel.INFO;
  private logs: LogEntry[] = [];
  private maxLogs = 1000;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level;
  }

  private formatEntry(entry: LogEntry): string {
    const time = entry.timestamp.toISOString().split('T')[1].split('.')[0];
    const levelStr = LogLevel[entry.level].padStart(5);
    
    let colorFn: (s: string) => string;
    switch (entry.level) {
      case LogLevel.DEBUG: colorFn = colors.dim; break;
      case LogLevel.INFO: colorFn = colors.cyan; break;
      case LogLevel.WARN: colorFn = colors.amber; break;
      case LogLevel.ERROR: colorFn = colors.red; break;
      default: colorFn = (s) => s;
    }

    return `${colors.dim(`[${time}]`)} ${colorFn(levelStr)} ${entry.message}`;
  }

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    if (this.shouldLog(level)) {
      console.error(this.formatEntry(entry));
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, context);
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }
}

export const logger = new Logger();
