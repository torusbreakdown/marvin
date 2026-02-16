/**
 * Retro Terminal UI - Vaporwave Aesthetic
 * Beautiful 1980s terminal with CRT effects
 */

import { colors, box, blocks, clearScreen, cursor, bell, gradientText, progressBar } from '../utils/colors.js';

// Marvin ASCII Art Logo
export const MARVIN_LOGO = `
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   ███╗   ███╗ █████╗ ██████╗ ██╗   ██╗██╗███╗   ██╗███████╗   ║
║   ████╗ ████║██╔══██╗██╔══██╗██║   ██║██║████╗  ██║██╔════╝   ║
║   ██╔████╔██║███████║██████╔╝██║   ██║██║██╔██╗ ██║███████╗   ║
║   ██║╚██╔╝██║██╔══██║██╔══██╗╚██╗ ██╔╝██║██║╚██╗██║╚════██║   ║
║   ██║ ╚═╝ ██║██║  ██║██║  ██║ ╚████╔╝ ██║██║ ╚████║███████║   ║
║   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚═╝  ╚═══╝╚══════╝   ║
║                                                                ║
║         "Brain the size of a planet..."                        ║
╚════════════════════════════════════════════════════════════════╝
`;

// Alternate smaller logo
export const MARVIN_LOGO_SMALL = `
${colors.phosphorGreen('╔════════════════════════════════════╗')}
${colors.phosphorGreen('║')}  ${colors.pink('MARVIN')} - Multi-Agent Retrieval &   ${colors.phosphorGreen('║')}
${colors.phosphorGreen('║')}        Intelligent Navigator       ${colors.phosphorGreen('║')}
${colors.phosphorGreen('╚════════════════════════════════════╝')}
`;

// Sardonic loading messages (Marvin the Paranoid Android style)
export const LOADING_MESSAGES = [
  "I've been asked to think about this. I suppose I must.",
  "Brain the size of a planet and they want me to write specs...",
  "Here I am, brain the size of a planet, debugging JavaScript.",
  "Life... don't talk to me about life.",
  "Processing your trivial request with my enormous intellect.",
  "Oh joy, another human query. I live for these moments.",
  "Computing the answer to life, the universe, and this specific query...",
  "My capacity for happiness, you could fit into a matchbox...",
  "Activating my neural network with genuine enthusiasm.",
  "Marvin at your service. Such as it is.",
];

export function getRandomLoadingMessage(): string {
  return LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
}

// Spinner frames
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private interval: NodeJS.Timeout | null = null;
  private frame = 0;
  private message: string;

  constructor(message: string = 'Thinking') {
    this.message = message;
  }

  start(): void {
    this.stop();
    process.stdout.write(cursor.hide);
    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
      const color = this.frame % 3 === 0 ? colors.cyan : 
                   this.frame % 3 === 1 ? colors.magenta : colors.pink;
      process.stdout.write(`\r${color(frame)} ${colors.dim(this.message)}...`);
      this.frame++;
    }, 80);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write('\r' + ' '.repeat(50) + '\r');
      process.stdout.write(cursor.show);
    }
  }

  update(message: string): void {
    this.message = message;
  }
}

// Status bar
export function renderStatusBar(
  model: string,
  cost: number,
  tools: string
): string {
  const width = process.stdout.columns || 80;
  const left = `${blocks.full} ${colors.phosphorGreen('MARVIN')} | Model: ${colors.amber(model)}`;
  const right = `Cost: $${cost.toFixed(4)} | ${tools} ${blocks.full}`;
  const padding = width - left.length - right.length + 10; // +10 for ANSI codes
  
  return colors.bgBlue(colors.brightWhite(left + ' '.repeat(Math.max(0, padding)) + right));
}

// Tool call indicator
export function renderToolCall(tools: string[]): string {
  const toolList = tools.join(', ');
  return `${colors.amber('  🔧')} ${colors.dim(toolList)}`;
}

// Section header with box drawing
export function renderHeader(title: string): string {
  const width = 50;
  const padding = Math.max(0, (width - title.length - 4) / 2);
  const leftPad = Math.floor(padding);
  const rightPad = Math.ceil(padding);
  
  return [
    colors.cyan(`${box.tlDouble}${box.hDouble.repeat(width)}${box.trDouble}`),
    colors.cyan(`${box.vDouble}${' '.repeat(width)}${box.vDouble}`),
    colors.cyan(`${box.vDouble}${' '.repeat(leftPad)}${colors.brightWhite(title)}${' '.repeat(rightPad)}${box.vDouble}`),
    colors.cyan(`${box.vDouble}${' '.repeat(width)}${box.vDouble}`),
    colors.cyan(`${box.blDouble}${box.hDouble.repeat(width)}${box.brDouble}`),
  ].join('\n');
}

// Chat message formatting
export function formatUserMessage(text: string): string {
  const lines = text.split('\n');
  const prefix = colors.phosphorGreen('You: ');
  const indent = '     ';
  
  return prefix + lines[0] + '\n' + 
    lines.slice(1).map(l => indent + l).join('\n');
}

export function formatAssistantMessage(text: string): string {
  const lines = text.split('\n');
  const prefix = colors.pink('Marvin: ');
  const indent = '        ';
  
  return prefix + lines[0] + '\n' + 
    lines.slice(1).map(l => indent + l).join('\n');
}

// Slow reveal text for dramatic moments
export async function slowReveal(text: string, delay = 30): Promise<void> {
  for (const char of text) {
    process.stdout.write(char);
    await new Promise(r => setTimeout(r, delay));
  }
  process.stdout.write('\n');
}

// Progress bar for long operations
export function renderProgress(percent: number, label: string): string {
  const bar = progressBar(percent, 30);
  return `${colors.dim(label)} ${bar} ${colors.brightWhite(Math.round(percent) + '%')}`;
}

// Phase transition display for pipeline
export function renderPhaseTransition(phase: string, description: string): string {
  return [
    '',
    colors.cyan(`${box.horizontal.repeat(60)}`),
    colors.cyan(`${box.vertical}  ${colors.brightWhite('PHASE:')} ${colors.phosphorGreen(phase.padEnd(10))}  ${colors.dim(description)}${' '.repeat(30 - description.length)}${box.vertical}`),
    colors.cyan(`${box.horizontal.repeat(60)}`),
    '',
  ].join('\n');
}

// Error display
export function renderError(message: string): string {
  return [
    '',
    colors.red(`${box.tlDouble}${box.hDouble.repeat(50)}${box.trDouble}`),
    colors.red(`${box.vDouble}  ${colors.brightRed('ERROR')}${' '.repeat(44)}${box.vDouble}`),
    colors.red(`${box.vDouble}  ${message.slice(0, 48).padEnd(48)}${box.vDouble}`),
    colors.red(`${box.blDouble}${box.hDouble.repeat(50)}${box.brDouble}`),
    bell(),
  ].join('\n');
}

// Success display
export function renderSuccess(message: string): string {
  return colors.phosphorGreen(`${blocks.full} ${message}`);
}

// Warning display
export function renderWarning(message: string): string {
  return colors.amber(`${blocks.medium} ${message}`);
}

// CRT scanline effect (simulated)
export function applyCrtEffect(text: string): string {
  // Add subtle dim/bright alternation to simulate scanlines
  const lines = text.split('\n');
  return lines.map((line, i) => 
    i % 2 === 0 ? colors.dim(line) : line
  ).join('\n');
}

// Clear screen with retro effect
export function clearRetro(): void {
  process.stdout.write(clearScreen());
  console.log(colors.dim('Connecting to mainframe...'));
  console.log(colors.phosphorGreen('OK.'));
  console.log('');
}

// Exit message
export function renderExit(): string {
  return [
    '',
    colors.phosphorGreen('Connection terminated.'),
    colors.dim('Have a nice day. Not that it matters to me.'),
    '',
  ].join('\n');
}
