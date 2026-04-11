import { visibleWidth } from '@mariozechner/pi-tui';

export { visibleWidth };

export const GOLD_FG = '\x1b[38;2;203;166;247m'; // catppuccin mauve
export const GREEN_FG = '\x1b[38;2;166;227;161m'; // catppuccin green
export const GREEN_DARK_FG = '\x1b[38;2;137;180;250m'; // catppuccin blue
export const RESET_FG = '\x1b[39m';

export function tint(text: string, color: string): string {
  return `${color}${text}${RESET_FG}`;
}

export function gold(text: string): string {
  return tint(text, GOLD_FG);
}

export function padVisible(text: string, width: number): string {
  const deficit = width - visibleWidth(text);
  if (deficit <= 0) return text;
  return `${text}${' '.repeat(deficit)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function formatCompactTokens(tokens: number | null | undefined): string {
  if (tokens == null || Number.isNaN(tokens)) return '?';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return `${tokens}`;
}

export function usageColor(percent: number | null): string {
  if (percent == null) return '\x1b[38;2;166;173;200m'; // catppuccin muted
  if (percent < 40) return '\x1b[38;2;166;227;161m'; // green
  if (percent < 60) return '\x1b[38;2;249;226;175m'; // yellow
  if (percent < 80) return '\x1b[38;2;250;179;135m'; // peach
  return '\x1b[38;2;243;139;168m'; // red
}

export function maxVisibleWidth(lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}
