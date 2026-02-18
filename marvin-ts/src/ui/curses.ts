import type { UI } from './shared.js';
import type { StatusBarData } from '../types.js';

export class CursesUI implements UI {
  async start(): Promise<void> {
    throw new Error('CursesUI is not yet implemented. Use --plain instead.');
  }
  displayMessage(_role: string, _text: string): void {}
  displaySystem(_text: string): void {}
  displayError(_text: string): void {}
  displayToolCall(_toolNames: string[]): void {}
  beginStream(): void {}
  streamDelta(_text: string): void {}
  endStream(): void {}
  promptInput(): Promise<string> {
    throw new Error('CursesUI is not yet implemented.');
  }
  promptConfirm(_command: string): Promise<boolean> {
    throw new Error('CursesUI is not yet implemented.');
  }
  showStatus(_status: StatusBarData): void {}
  destroy(): void {}
}
