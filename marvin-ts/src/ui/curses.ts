import blessed from 'neo-blessed';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UI } from './shared.js';
import type { StatusBarData } from '../types.js';

export interface CursesUIOptions {
  provider: string;
  model: string;
  profile: string;
}

const COLORS: Record<string, string> = {
  user: 'cyan',
  assistant: 'green',
  system: 'yellow',
  tool: 'magenta',
  error: 'red',
};

export class CursesUI implements UI {
  private screen!: blessed.Widgets.Screen;
  private statusBar!: blessed.Widgets.BoxElement;
  private chatLog!: blessed.Widgets.Log;
  private inputBox!: blessed.Widgets.TextboxElement;
  private opts: CursesUIOptions;

  private inputResolve: ((value: string) => void) | null = null;
  private confirmResolve: ((value: boolean) => void) | null = null;
  private streaming = false;
  private streamBuf = '';
  private history: string[] = [];
  private historyIdx = -1;
  private currentInput = '';
  private userScrolled = false;
  private pendingInput: string | null = null;
  private inputReady = false;
  private liveStatus: StatusBarData;
  private clockInterval: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CursesUIOptions) {
    this.opts = opts;
    this.liveStatus = {
      providerEmoji: '🤖',
      model: opts.model,
      profileName: opts.profile,
      messageCount: 0,
      costUsd: 0,
      totalTokens: 0,
      codingMode: false,
      shellMode: false,
      mode: 'surf',
    };
  }

  async start(): Promise<void> {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Marvin',
      fullUnicode: true,
      mouse: true,
    });

    // ── Status bar (top) ──
    this.statusBar = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: { fg: 'white', bg: 'black', bold: true },
    });
    this.renderStatus();

    // ── Chat log (middle) ──
    this.chatLog = blessed.log({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-4',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: '│', style: { fg: 'cyan' } },
      mouse: true,
      keys: true,
      vi: false,
      style: { fg: 'white', bg: 'default' },
      padding: { left: 1, right: 1 },
    });

    // Track manual scrolling
    this.chatLog.on('scroll', () => {
      const maxScroll = Math.max(0, (this.chatLog as any).getScrollHeight() - (this.chatLog as any).height);
      this.userScrolled = (this.chatLog as any).getScroll() < maxScroll;
    });

    // ── Input area (bottom) ──
    const inputBorder = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
    });

    this.inputBox = blessed.textbox({
      parent: inputBorder,
      top: 0,
      left: 1,
      width: '100%-4',
      height: 1,
      inputOnFocus: false,
      style: { fg: 'white', bg: 'default' },
    });

    // ── Keyboard bindings ──
    this.screen.key(['C-q', 'C-d'], () => {
      if (this.inputResolve) {
        this.inputResolve('quit');
        this.inputResolve = null;
      }
    });

    this.screen.key(['escape'], () => {
      if (this.confirmResolve) {
        this.confirmResolve(false);
        this.confirmResolve = null;
        this.refocusInput();
        return;
      }
      if (this.inputResolve) {
        this.inputResolve('quit');
        this.inputResolve = null;
      }
    });

    // Scrolling
    this.screen.key(['pageup'], () => {
      this.chatLog.scroll(-10);
      this.screen.render();
    });
    this.screen.key(['pagedown'], () => {
      this.chatLog.scroll(10);
      this.screen.render();
    });
    this.screen.key(['S-up'], () => {
      this.chatLog.scroll(-1);
      this.screen.render();
    });
    this.screen.key(['S-down'], () => {
      this.chatLog.scroll(1);
      this.screen.render();
    });

    // Show splash
    this.showSplash();

    // Set up persistent input handling
    this.setupInput();

    // Tick the clock every 30s
    this.clockInterval = setInterval(() => {
      this.renderStatus();
      this.screen.render();
    }, 30_000);

    this.screen.render();
  }

  private setupInput(): void {
    const onKeypress = (_ch: string, key: any) => {
      if (!key) return;

      if (key.name === 'up') {
        if (this.history.length === 0) return;
        if (this.historyIdx === -1) {
          this.currentInput = this.inputBox.getValue();
          this.historyIdx = this.history.length - 1;
        } else if (this.historyIdx > 0) {
          this.historyIdx--;
        }
        this.inputBox.setValue(this.history[this.historyIdx]);
        this.screen.render();
        return;
      }
      if (key.name === 'down') {
        if (this.historyIdx === -1) return;
        if (this.historyIdx < this.history.length - 1) {
          this.historyIdx++;
          this.inputBox.setValue(this.history[this.historyIdx]);
        } else {
          this.historyIdx = -1;
          this.inputBox.setValue(this.currentInput);
        }
        this.screen.render();
        return;
      }
    };

    const onSubmit = (value: string) => {
      const text = value.trim();
      this.inputBox.clearValue();

      // Immediately re-enter input mode so typing never stops
      this.inputBox.readInput();
      this.screen.render();

      if (!text) return;
      this.history.push(text);
      this.historyIdx = -1;
      this.currentInput = '';

      if (this.confirmResolve) {
        const cb = this.confirmResolve;
        this.confirmResolve = null;
        cb(true);
        return;
      }

      if (this.inputResolve) {
        const cb = this.inputResolve;
        this.inputResolve = null;
        cb(text);
      } else {
        // Busy — queue the input for when promptInput is next called
        this.pendingInput = text;
      }
    };

    this.inputBox.on('keypress', onKeypress);
    this.inputBox.on('submit', onSubmit);
    this.inputBox.focus();
    this.inputBox.readInput();
    this.inputReady = true;
  }

  private showSplash(): void {
    const splashPath = join(import.meta.dirname ?? '.', '..', 'assets', 'splash.txt');
    try {
      if (existsSync(splashPath)) {
        const splash = readFileSync(splashPath, 'utf-8');
        for (const line of splash.split('\n')) {
          this.chatLog.log(`{cyan-fg}${blessed.escape(line)}{/cyan-fg}`);
        }
        this.chatLog.log('');
      }
    } catch { /* splash is optional */ }
  }

  // ── Display methods ──

  displayMessage(role: string, text: string): void {
    const color = COLORS[role] || 'white';
    const label = role === 'user' ? '👤 You' : role === 'assistant' ? '🤖 Marvin' : role;
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.chatLog.log(`{grey-fg}${ts}{/grey-fg} {${color}-fg}{bold}${label}:{/bold}{/${color}-fg}`);
    for (const line of text.split('\n')) {
      this.chatLog.log(`  ${blessed.escape(line)}`);
    }
    this.chatLog.log('');
    this.autoScroll();
  }

  displaySystem(text: string): void {
    this.chatLog.log(`{yellow-fg}[System] ${blessed.escape(text)}{/yellow-fg}`);
    this.autoScroll();
  }

  displayError(text: string): void {
    this.chatLog.log(`{red-fg}⚠️ ${blessed.escape(text)}{/red-fg}`);
    this.autoScroll();
  }

  displayToolCall(toolNames: string[]): void {
    this.chatLog.log(`  {magenta-fg}🔧 ${blessed.escape(toolNames.join(', '))}{/magenta-fg}`);
    this.autoScroll();
  }

  // ── Streaming ──

  beginStream(): void {
    this.streaming = true;
    this.streamBuf = '';
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.chatLog.log(`{grey-fg}${ts}{/grey-fg} {green-fg}{bold}🤖 Marvin:{/bold}{/green-fg}`);
  }

  streamDelta(text: string): void {
    this.streamBuf += text;
    // Flush complete lines
    const lines = this.streamBuf.split('\n');
    while (lines.length > 1) {
      const line = lines.shift()!;
      this.chatLog.log(`  ${blessed.escape(line)}`);
    }
    this.streamBuf = lines[0];
    this.autoScroll();
  }

  endStream(): void {
    if (this.streaming) {
      // Flush remaining buffer
      if (this.streamBuf) {
        this.chatLog.log(`  ${blessed.escape(this.streamBuf)}`);
        this.streamBuf = '';
      }
      this.chatLog.log('');
      this.streaming = false;
      this.autoScroll();
    }
  }

  // ── Input ──

  promptInput(): Promise<string> {
    // If user typed while busy, resolve immediately with queued input
    if (this.pendingInput) {
      const text = this.pendingInput;
      this.pendingInput = null;
      return Promise.resolve(text);
    }
    return new Promise((resolve) => {
      this.inputResolve = resolve;
      this.historyIdx = -1;
      this.currentInput = '';
    });
  }

  private refocusInput(): void {
    this.inputBox.clearValue();
    this.inputBox.focus();
    if (!this.inputReady) {
      this.inputBox.readInput();
      this.inputReady = true;
    }
    this.screen.render();
  }

  promptConfirm(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirmResolve = resolve;
      this.chatLog.log(`{yellow-fg}Run? $ ${blessed.escape(command)} [Enter to confirm, Esc to cancel]{/yellow-fg}`);
      this.autoScroll();
    });
  }

  // ── Status bar ──

  showStatus(status: Partial<StatusBarData>): void {
    Object.assign(this.liveStatus, status);
    this.renderStatus();
    this.screen.render();
  }

  private renderStatus(): void {
    const s = this.liveStatus;
    const now = new Date();
    const hour = now.getHours();
    const dayNight = (hour >= 6 && hour < 18) ? '☀️' : '🌙';
    const clock = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const modeEmoji: Record<string, string> = { surf: '🌊', coding: '🔧', lockin: '🔒' };

    const left = `  Marvin │ ${s.profileName} │ ${s.model} $${s.costUsd.toFixed(4)}`;
    const flags: string[] = [];
    if (s.codingMode) flags.push('🔧 CODE');
    if (s.shellMode) flags.push('🐚 SHELL');
    flags.push(`${modeEmoji[s.mode] || '🌊'} ${s.mode.toUpperCase()}`);
    const right = `${flags.join(' ')} │ ${s.messageCount} msgs │ ${dayNight} ${clock}  `;

    const width = (this.statusBar as any).width ?? 80;
    const pad = Math.max(0, width - left.length - right.length);
    this.statusBar.setContent(left + ' '.repeat(pad) + right);
  }

  // ── Helpers ──

  private autoScroll(): void {
    if (!this.userScrolled) {
      this.chatLog.setScrollPerc(100);
    }
    this.renderStatus();
    this.screen.render();
  }

  destroy(): void {
    if (this.clockInterval) clearInterval(this.clockInterval);
    try {
      this.screen?.destroy();
    } catch { /* ignore */ }
  }
}
