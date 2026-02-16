/**
 * Retro terminal colors - vaporwave aesthetic
 * Color palette: Deep blacks, phosphor green, amber, cyan, magenta/pink
 */

// ANSI color codes
const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  strikethrough: '\x1b[9m',
  
  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // Bright foreground
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  
  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

// Vaporwave/Retro color palette
export const vaporwave = {
  // Deep blacks
  bgDark: '\x1b[48;5;232m',      // Very dark gray
  bgDarker: '\x1b[48;5;16m',     // Almost black
  
  // Phosphor green (classic terminal)
  phosphorGreen: '\x1b[38;5;82m',
  phosphorGreenDim: '\x1b[38;5;28m',
  
  // Amber (classic amber terminal)
  amber: '\x1b[38;5;214m',
  amberDim: '\x1b[38;5;172m',
  
  // Cyan (electric blue)
  cyan: '\x1b[38;5;51m',
  cyanDim: '\x1b[38;5;44m',
  
  // Magenta/Pink (vaporwave)
  magenta: '\x1b[38;5;201m',
  magentaDim: '\x1b[38;5;164m',
  pink: '\x1b[38;5;213m',
  hotPink: '\x1b[38;5;205m',
  
  // Gradients
  gradientStart: '\x1b[38;5;201m',  // Magenta
  gradientMid: '\x1b[38;5;207m',    // Pink
  gradientEnd: '\x1b[38;5;51m',     // Cyan
};

// Color functions
function wrap(code: string) {
  return (text: string): string => `${code}${text}${codes.reset}`;
}

export const colors = {
  // Standard colors
  reset: (s: string) => `${s}${codes.reset}`,
  bold: wrap(codes.bold),
  dim: wrap(codes.dim),
  italic: wrap(codes.italic),
  underline: wrap(codes.underline),
  strikethrough: wrap(codes.strikethrough),
  
  // Foreground
  black: wrap(codes.black),
  red: wrap(codes.red),
  green: wrap(codes.green),
  yellow: wrap(codes.yellow),
  blue: wrap(codes.blue),
  magenta: wrap(codes.magenta),
  cyan: wrap(codes.cyan),
  white: wrap(codes.white),
  
  // Bright
  brightRed: wrap(codes.brightRed),
  brightGreen: wrap(codes.brightGreen),
  brightYellow: wrap(codes.brightYellow),
  brightBlue: wrap(codes.brightBlue),
  brightMagenta: wrap(codes.brightMagenta),
  brightCyan: wrap(codes.brightCyan),
  brightWhite: wrap(codes.brightWhite),
  gray: wrap(codes.brightBlack),
  
  // Vaporwave palette
  phosphorGreen: wrap(vaporwave.phosphorGreen),
  phosphorGreenDim: wrap(vaporwave.phosphorGreenDim),
  amber: wrap(vaporwave.amber),
  amberDim: wrap(vaporwave.amberDim),
  pink: wrap(vaporwave.pink),
  hotPink: wrap(vaporwave.hotPink),
  
  // Background helpers
  bgGreen: wrap(codes.bgGreen),
  bgYellow: wrap(codes.bgYellow),
  bgRed: wrap(codes.bgRed),
  bgBlue: wrap(codes.bgBlue),
  bgMagenta: wrap(codes.bgMagenta),
  bgCyan: wrap(codes.bgCyan),
  
  // ANSI codes for manual use
  codes,
  vaporwave,
};

// Block characters for progress bars and UI
export const blocks = {
  full: '█',
  sevenEighths: '▉',
  threeQuarters: '▊',
  fiveEighths: '▋',
  half: '▌',
  threeEighths: '▍',
  quarter: '▎',
  eighth: '▏',
  light: '░',
  medium: '▒',
  dark: '▓',
};

// Box drawing characters
export const box = {
  horizontal: '─',
  vertical: '│',
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  leftT: '├',
  rightT: '┤',
  topT: '┬',
  bottomT: '┴',
  cross: '┼',
  
  // Double line
  hDouble: '═',
  vDouble: '║',
  tlDouble: '╔',
  trDouble: '╗',
  blDouble: '╚',
  brDouble: '╝',
};

// Spinner frames
export const spinners = {
  braille: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  classic: ['|', '/', '-', '\\'],
  dots: ['⠋', '⠙', '⠚', '⠞', '⠖', '⠦', '⠴', '⠲', '⠳', '⠓'],
  pulse: ['◐', '◓', '◑', '◒'],
};

// Generate a gradient text (magenta -> pink -> cyan)
export function gradientText(text: string): string {
  const colors = [vaporwave.magenta, vaporwave.pink, vaporwave.cyan];
  const chars = text.split('');
  const result: string[] = [];
  
  for (let i = 0; i < chars.length; i++) {
    const colorIndex = Math.floor((i / chars.length) * (colors.length - 1));
    result.push(`${colors[colorIndex]}${chars[i]}\x1b[0m`);
  }
  
  return result.join('');
}

// Progress bar
export function progressBar(percent: number, width = 30): string {
  const filled = Math.floor((percent / 100) * width);
  const empty = width - filled;
  return colors.phosphorGreen(blocks.full.repeat(filled)) + 
         colors.dim(blocks.light.repeat(empty));
}

// Terminal bell
export function bell(): string {
  return '\x07';
}

// Clear screen
export function clearScreen(): string {
  return '\x1b[2J\x1b[H';
}

// Hide/show cursor
export const cursor = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
};

// Move cursor
export function moveUp(lines: number): string {
  return `\x1b[${lines}A`;
}

export function moveDown(lines: number): string {
  return `\x1b[${lines}B`;
}
