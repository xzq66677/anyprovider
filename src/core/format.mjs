/**
 * Console formatting. Colours are opt-out (NO_COLOR, non-TTY, --no-color),
 * and every table is plain ASCII so it survives any Windows code page.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text));

export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const cyan = wrap('36');
export const dim = wrap('2');
export const bold = wrap('1');

export const say = (line = '') => process.stdout.write(`${line}\n`);
export const note = (line) => process.stdout.write(`${dim(line)}\n`);
export const warn = (line) => process.stderr.write(`${yellow(line)}\n`);
export const fail = (line) => process.stderr.write(`${red(line)}\n`);

export function step(index, title) {
  say('');
  say(`${cyan(String(index).padStart(2))} ${bold(title)}`);
}

export function banner(title, subtitle) {
  const width = 54;
  say('');
  say(blue('='.repeat(width)));
  say(`  ${bold(title)}`);
  if (subtitle) say(`  ${dim(subtitle)}`);
  say(blue('='.repeat(width)));
}

export function bullet(text, indent = 3) {
  say(`${' '.repeat(indent)}· ${text}`);
}

/** Right-pad accounting for wide CJK glyphs. */
export function pad(text, width) {
  const str = String(text ?? '');
  let visible = 0;
  for (const ch of str) visible += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, width - visible));
}

export function table(headers, rows, { indent = 3 } = {}) {
  const widths = headers.map((h, i) => Math.max(measure(h), ...rows.map((r) => measure(r[i]))));
  const line = (cells) => `${' '.repeat(indent)}${cells
    .map((c, i) => (i === cells.length - 1 ? String(c) : pad(c, widths[i])))
    .join('  ')}`;
  say(dim(line(headers)));
  for (const row of rows) say(line(row));
}

function measure(text) {
  let n = 0;
  for (const ch of String(text ?? '')) {
    n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return n;
}

export function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function mask(key) {
  if (!key) return '(none)';
  if (key.length <= 8) return `${key.slice(0, 2)}****`;
  return `${key.slice(0, 4)}****${key.slice(-4)} (${key.length} chars)`;
}
