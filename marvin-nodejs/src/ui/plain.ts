/**
 * Plain Terminal UI (no curses)
 * Readline-based interface for compatibility
 */

import * as readline from 'readline';
import { EventEmitter } from 'events';
import { MARVIN_LOGO_SMALL, formatUserMessage, formatAssistantMessage, Spinner } from './retro.js';
import { colors } from '../utils/colors.js';

export interface PlainUIOptions {
  onInput: (input: string) => Promise<void>;
  onExit: () => void;
}

export class PlainUI extends EventEmitter {
  private rl: readline.Interface;
  private spinner: Spinner;
  private isProcessing = false;

  constructor(private options: PlainUIOptions) {
    super();
    
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: colors.phosphorGreen('marvin> '),
    });
    
    this.spinner = new Spinner();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.rl.on('line', async (input) => {
      if (this.isProcessing) return;
      
      const trimmed = input.trim();
      if (!trimmed) {
        this.rl.prompt();
        return;
      }
      
      // Handle exit commands
      if (['quit', 'exit', 'bye'].includes(trimmed.toLowerCase())) {
        this.options.onExit();
        return;
      }
      
      // Show user input
      console.log(formatUserMessage(trimmed));
      
      this.isProcessing = true;
      this.spinner.start();
      
      try {
        await this.options.onInput(trimmed);
      } catch (error) {
        console.error(colors.red('Error:'), error);
      } finally {
        this.spinner.stop();
        this.isProcessing = false;
        this.rl.prompt();
      }
    });
    
    this.rl.on('close', () => {
      this.options.onExit();
    });
    
    // Handle Ctrl+C
    process.on('SIGINT', () => {
      this.options.onExit();
    });
  }

  start(): void {
    console.log(MARVIN_LOGO_SMALL);
    console.log(colors.dim('Type your message or "quit" to exit.\n'));
    this.rl.prompt();
  }

  displayResponse(text: string): void {
    this.spinner.stop();
    console.log('\n' + formatAssistantMessage(text));
    console.log();
  }

  displayToolCall(tools: string[]): void {
    this.spinner.stop();
    console.log(colors.amber(`  🔧 ${tools.join(', ')}`));
    this.spinner.start();
  }

  displayError(message: string): void {
    this.spinner.stop();
    console.error(colors.red('\n✗ Error:'), message);
  }

  stop(): void {
    this.spinner.stop();
    this.rl.close();
  }
}
