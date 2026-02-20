import blessed from 'neo-blessed';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UI } from './shared.js';
import type { StatusBarData } from '../types.js';
import { startRecording, stopRecording, isRecording } from '../voice/voice.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CursesUIOptions {
  provider: string;
  model: string;
  profile: string;
  inputHistory?: string[];
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
  private inputBox!: blessed.Widgets.TextareaElement;
  private inputBorder!: blessed.Widgets.BoxElement;
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
  private liveStatus: StatusBarData;
  private clockInterval: ReturnType<typeof setInterval> | null = null;
  private origStderrWrite: typeof process.stderr.write | null = null;
  private cursorPos = 0;
  private reverseSearchMode = false;
  private reverseSearchQuery = '';
  private reverseSearchIdx = -1;
  public onUndo: (() => void) | null = null;
  public onAbort: (() => void) | null = null;
  /** Called when voice recording finishes — receives WAV path, should transcribe + submit */
  public onVoiceInput: ((wavPath: string) => void) | null = null;
  private voiceEnabled = false;
  private voiceRecording = false;

  constructor(opts: CursesUIOptions) {
    this.opts = opts;
    if (opts.inputHistory?.length) {
      this.history = [...opts.inputHistory];
    }
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
    // Redirect stderr so warnings/errors don't corrupt the TUI
    this.origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any, ...args: any[]) => {
      // Swallow stderr in curses mode — could optionally log to chatLog
      return true;
    };

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Marvin',
      fullUnicode: true,
      mouse: false,
    });

    // Ensure terminal is reset on any exit path
    const resetTerminal = () => {
      try {
        // Disable ALL mouse tracking modes (1000=vt200, 1002=cell, 1003=all, 1005=utf8, 1006=sgr, 1015=urxvt)
        process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l');
        process.stdout.write('\x1b[?25h');  // show cursor
        process.stdout.write('\x1b[?1049l'); // normal screen buffer
      } catch { /* ignore */ }
    };
    process.on('exit', resetTerminal);
    process.on('SIGINT', () => { resetTerminal(); process.exit(0); });
    process.on('SIGTERM', () => { resetTerminal(); process.exit(0); });

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
      mouse: false,
      keys: true,
      vi: false,
      style: { fg: 'white', bg: 'default' },
      padding: { left: 1, right: 1 },
    });

    // Track manual scrolling, then return focus to input
    this.chatLog.on('scroll', () => {
      const maxScroll = Math.max(0, (this.chatLog as any).getScrollHeight() - (this.chatLog as any).height);
      this.userScrolled = (this.chatLog as any).getScroll() < maxScroll;
      this.ensureInputFocus();
    });

    // ── Input area (bottom) ──
    this.inputBorder = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
    });

    this.inputBox = blessed.textarea({
      parent: this.inputBorder,
      top: 0,
      left: 1,
      width: '100%-4',
      height: 1,
      inputOnFocus: false,
      style: { fg: 'white', bg: 'default' },
    });
    // readInput() adds internal listeners on each call; raise the cap
    (this.inputBox as any).setMaxListeners(100);

    // ── Direct input handling — bypass readInput() entirely ──
    const self = this;
    this.screen.program.on('keypress', (ch: string, key: any) => {
      if (!key) return;
      // Only handle keys when inputBox is focused
      if (self.screen.focused !== self.inputBox) return;

      // Enter: submit
      if (key.name === 'return' || key.name === 'enter') {
        if (self.reverseSearchMode) {
          self.exitReverseSearch(true);
          return;
        }
        process.nextTick(() => self.handleSubmit());
        return;
      }

      // Escape: handled by screen.key('escape') — skip here to avoid double-fire
      if (key.name === 'escape') {
        return;
      }

      // Ctrl+R: reverse search
      if (key.ctrl && key.name === 'r') {
        self.enterReverseSearch();
        return;
      }

      // Ctrl+Z: undo last chat message
      if (key.ctrl && key.name === 'z') {
        if (self.onUndo) self.onUndo();
        return;
      }

      // Ctrl+V: toggle voice recording (push-to-talk)
      if (key.ctrl && key.name === 'v') {
        self.toggleVoiceRecording();
        return;
      }

      // In reverse search mode
      if (self.reverseSearchMode) {
        if (key.name === 'backspace') {
          if (self.reverseSearchQuery.length > 0) {
            self.reverseSearchQuery = self.reverseSearchQuery.slice(0, -1);
            self.updateReverseSearch();
          }
          return;
        }
        if (ch && !/^[\x00-\x1f\x7f]$/.test(ch)) {
          self.reverseSearchQuery += ch;
          self.updateReverseSearch();
          return;
        }
        return;
      }

      const val = self.inputBox.value || '';

      // Arrow keys: cursor movement
      if (key.name === 'left') {
        if (self.cursorPos > 0) self.cursorPos--;
        self.renderInputCursor();
        return;
      }
      if (key.name === 'right') {
        if (self.cursorPos < val.length) self.cursorPos++;
        self.renderInputCursor();
        return;
      }
      if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
        self.cursorPos = 0;
        self.renderInputCursor();
        return;
      }
      if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
        self.cursorPos = val.length;
        self.renderInputCursor();
        return;
      }

      // Up/down: history navigation
      if (key.name === 'up') {
        if (self.history.length === 0) return;
        if (self.historyIdx === -1) {
          self.currentInput = self.inputBox.getValue();
          self.historyIdx = self.history.length - 1;
        } else if (self.historyIdx > 0) {
          self.historyIdx--;
        }
        self.inputBox.setValue(self.history[self.historyIdx]);
        self.cursorPos = self.inputBox.value.length;
        self.screen.render();
        return;
      }
      if (key.name === 'down') {
        if (self.historyIdx === -1) return;
        if (self.historyIdx < self.history.length - 1) {
          self.historyIdx++;
          self.inputBox.setValue(self.history[self.historyIdx]);
        } else {
          self.historyIdx = -1;
          self.inputBox.setValue(self.currentInput);
        }
        self.cursorPos = self.inputBox.value.length;
        self.screen.render();
        return;
      }

      // Backspace / delete
      if (key.name === 'backspace') {
        if (self.cursorPos > 0) {
          self.inputBox.setValue(val.slice(0, self.cursorPos - 1) + val.slice(self.cursorPos));
          self.cursorPos--;
          self.screen.render();
        }
        return;
      }
      if (key.name === 'delete') {
        if (self.cursorPos < val.length) {
          self.inputBox.setValue(val.slice(0, self.cursorPos) + val.slice(self.cursorPos + 1));
          self.screen.render();
        }
        return;
      }

      // Normal character input
      if (ch && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(ch)) {
        self.inputBox.setValue(val.slice(0, self.cursorPos) + ch + val.slice(self.cursorPos));
        self.cursorPos++;
        self.screen.render();
      }
    });

    // ── Keyboard bindings ──
    this.screen.key(['C-q', 'C-d'], () => {
      if (this.inputResolve) {
        this.inputResolve('quit');
        this.inputResolve = null;
        return;
      }
      this.destroy();
      process.exit(0);
    });

    this.screen.key(['escape'], () => {
      if (this.reverseSearchMode) {
        this.exitReverseSearch(false);
        return;
      }
      if (this.confirmResolve) {
        const cb = this.confirmResolve;
        this.confirmResolve = null;
        cb(false);
        return;
      }
      if (this.inputResolve) {
        const cb = this.inputResolve;
        this.inputResolve = null;
        cb('quit');
        return;
      }
      // During streaming/busy — abort the current request
      if (this.onAbort) this.onAbort();
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

    // Tick the clock every second
    this.clockInterval = setInterval(() => {
      this.renderStatus();
      this.screen.render();
    }, 1_000);

    this.screen.render();
  }

  private setupInput(): void {
    this.inputBox.focus();
    // No readInput() needed — all input handled via program-level keypress handler
  }

  private handleSubmit(): void {
    const text = this.inputBox.getValue().trim();
    this.inputBox.clearValue();
    this.cursorPos = 0;
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
      this.pendingInput = text;
    }
  }

  private showSplash(): void {
    // __dirname = dist/ui/ at runtime, assets/ is at project root
    const splashPath = join(__dirname, '..', '..', 'assets', 'splash.txt');
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

  displayHistory(entries: Array<{ role: string; text: string; time: string }>): void {
    if (entries.length === 0) return;
    this.chatLog.log('{grey-fg}── Recent history ──{/grey-fg}');
    for (const entry of entries) {
      const role = entry.role === 'you' ? 'user' : entry.role;
      const color = COLORS[role] || 'grey';
      const label = role === 'user' ? '👤 You' : role === 'assistant' ? '🤖 Marvin' : role;
      const ts = entry.time ? new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      this.chatLog.log(`{grey-fg}${ts}{/grey-fg} {${color}-fg}${label}:{/${color}-fg} ${blessed.escape(entry.text)}`);
    }
    this.chatLog.log('{grey-fg}── End of history ──{/grey-fg}');
    this.chatLog.log('');
    this.autoScroll();
  }

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
      this.ensureInputFocus();
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
    const hh = String(hour).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const clock = `${hh}:${mm}:${ss}`;
    const dayNight = (hour >= 6 && hour < 18) ? '*' : 'o';
    const modeLabel: Record<string, string> = { surf: 'SURF', coding: 'CODE', lockin: 'LOCKIN' };

    const left = `  Marvin | ${s.profileName} | ${s.model} $${s.costUsd.toFixed(4)}`;
    const flags: string[] = [];
    if (s.codingMode) flags.push('CODE');
    if (s.shellMode) flags.push('SHELL');
    flags.push(modeLabel[s.mode] || 'SURF');
    const right = `${flags.join(' ')} | ${s.messageCount} msgs | ${dayNight} ${clock}  `;

    const width = (this.statusBar as any).width ?? 80;
    const pad = Math.max(0, width - left.length - right.length);
    this.statusBar.setContent(left + ' '.repeat(pad) + right);
  }

  // ── Helpers ──

  private renderInputCursor(): void {
    // Move blessed's cursor to our tracked position
    const box = this.inputBox as any;
    if (box.screen && box.lpos) {
      const y = box.lpos.yi + box.itop;
      const x = box.lpos.xi + box.ileft + this.cursorPos;
      this.screen.program.cup(y, x);
    }
    this.screen.render();
  }

  private ensureInputFocus(): void {
    if (this.screen.focused !== this.inputBox) {
      this.inputBox.focus();
    }
  }

  private autoScroll(): void {
    if (!this.userScrolled) {
      this.chatLog.setScrollPerc(100);
    }
    this.renderStatus();
    this.ensureInputFocus();
    this.screen.render();
  }

  /** Remove the last displayed message block (user or assistant) from the chat log widget. */
  removeLastMessage(): void {
    const content = this.chatLog.getContent();
    const lines = content.split('\n');
    // Find the last line that starts a message block (contains 👤 or 🤖 header)
    let lastHeaderIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/👤 You:|🤖 Marvin:/.test(lines[i])) {
        lastHeaderIdx = i;
        break;
      }
    }
    if (lastHeaderIdx < 0) return;
    // Remove from the header line to the end, then trim trailing blank lines
    let truncated = lines.slice(0, lastHeaderIdx).join('\n').replace(/\n+$/, '');
    if (truncated) truncated += '\n';
    this.chatLog.setContent(truncated);
    this.autoScroll();
  }

  private enterReverseSearch(): void {
    this.reverseSearchMode = true;
    this.reverseSearchQuery = '';
    this.reverseSearchIdx = this.history.length;
    this.inputBorder.setLabel({ text: '{cyan-fg}(reverse-i-search):{/cyan-fg}', side: 'left' });
    this.inputBox.clearValue();
    this.cursorPos = 0;
    this.screen.render();
  }

  private updateReverseSearch(): void {
    const q = this.reverseSearchQuery.toLowerCase();
    this.inputBorder.setLabel({ text: `{cyan-fg}(reverse-i-search)\`${this.reverseSearchQuery}\`:{/cyan-fg}`, side: 'left' });
    // Search backwards from reverseSearchIdx
    for (let i = this.reverseSearchIdx - 1; i >= 0; i--) {
      if (this.history[i].toLowerCase().includes(q)) {
        this.reverseSearchIdx = i;
        this.inputBox.setValue(this.history[i]);
        this.cursorPos = this.history[i].length;
        this.screen.render();
        return;
      }
    }
    // No match found
    this.screen.render();
  }

  private exitReverseSearch(accept: boolean): void {
    this.reverseSearchMode = false;
    this.inputBorder.setLabel('');
    if (!accept) {
      this.inputBox.clearValue();
      this.cursorPos = 0;
    } else {
      this.cursorPos = this.inputBox.value.length;
    }
    this.screen.render();
  }

  destroy(): void {
    if (this.clockInterval) clearInterval(this.clockInterval);
    if (this.origStderrWrite) process.stderr.write = this.origStderrWrite;
    // Stop any active recording
    if (isRecording()) stopRecording();
    // Write mouse-disable BEFORE screen.destroy() — destroy can re-enable
    try {
      process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l');
      process.stdout.write('\x1b[?25h');
    } catch { /* ignore */ }
    try {
      if (this.screen?.program) {
        this.screen.program.disableMouse();
        this.screen.program.showCursor();
        this.screen.program.normalBuffer();
      }
      this.screen?.destroy();
    } catch { /* ignore */ }
    // Belt-and-suspenders: write again AFTER destroy
    try {
      process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l');
      process.stdout.write('\x1b[?25h');
      process.stdout.write('\x1b[?1049l');
    } catch { /* ignore */ }
  }

  // ── Voice ──

  setVoiceEnabled(on: boolean): void {
    this.voiceEnabled = on;
  }

  private toggleVoiceRecording(): void {
    if (!this.voiceEnabled) {
      this.displaySystem('Voice not enabled. Use !voice to enable.');
      return;
    }

    if (this.voiceRecording) {
      // Stop recording → transcribe
      this.voiceRecording = false;
      const wavPath = stopRecording();
      this.updateInputBorder();
      this.displaySystem('🎙️ Recording stopped — transcribing…');
      if (wavPath && this.onVoiceInput) {
        this.onVoiceInput(wavPath);
      }
    } else {
      // Start recording
      this.voiceRecording = true;
      startRecording();
      this.updateInputBorder();
      this.displaySystem('🎙️ Recording… press Ctrl+V again to stop');
    }
  }

  private updateInputBorder(): void {
    const label = this.voiceRecording ? ' 🎙️ RECORDING (Ctrl+V to stop) ' : '';
    this.inputBorder.setLabel(label);
    if (this.voiceRecording) {
      this.inputBorder.style.border = { fg: 'red' };
    } else {
      this.inputBorder.style.border = { fg: 'default' };
    }
    this.screen.render();
  }
}
