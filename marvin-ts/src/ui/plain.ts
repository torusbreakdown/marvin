import * as readline from 'node:readline';
import type { UI } from './shared.js';
import type { StatusBarData } from '../types.js';

export interface PlainUIOptions {
  provider: string;
  model: string;
  profile: string;
}

const ROLE_LABELS: Record<string, string> = {
  user: 'You:',
  assistant: '🤖 Marvin:',
  system: '⚙️ System:',
};

export class PlainUI implements UI {
  private rl: readline.Interface | null = null;
  private opts: PlainUIOptions;
  private streaming = false;

  constructor(opts: PlainUIOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
    });
    process.stdout.write(
      `\n🤖 Marvin (${this.opts.model}) — Profile: ${this.opts.profile}\n` +
      `Type your message. Ctrl+D or 'quit' to exit.\n\n`,
    );
  }

  displayMessage(role: string, text: string): void {
    const label = ROLE_LABELS[role] ?? `${role}:`;
    process.stdout.write(`${label} ${text}\n`);
  }

  displaySystem(text: string): void {
    process.stdout.write(`[System] ${text}\n`);
  }

  displayError(text: string): void {
    process.stdout.write(`⚠️ ${text}\n`);
  }

  displayToolCall(toolNames: string[]): void {
    process.stdout.write(`  🔧 ${toolNames.join(', ')}\n`);
  }

  beginStream(): void {
    this.streaming = true;
  }

  streamDelta(text: string): void {
    process.stdout.write(text);
  }

  endStream(): void {
    if (this.streaming) {
      process.stdout.write('\n');
      this.streaming = false;
    }
  }

  promptInput(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.rl) {
        reject(new Error('UI not started'));
        return;
      }
      this.rl.question('You: ', (answer) => {
        const trimmed = answer.trim();
        if (trimmed === 'quit' || trimmed === 'exit') {
          resolve('quit');
          return;
        }
        resolve(trimmed);
      });
      // Handle Ctrl+D (EOF)
      this.rl.once('close', () => resolve('quit'));
    });
  }

  promptConfirm(command: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.rl) {
        reject(new Error('UI not started'));
        return;
      }
      this.rl.question(`Run? $ ${command} [Enter/Ctrl+C] > `, () => {
        resolve(true);
      });
    });
  }

  showStatus(_status: StatusBarData): void {
    // Plain mode doesn't have a status bar; no-op
  }

  destroy(): void {
    this.rl?.close();
    this.rl = null;
  }
}
