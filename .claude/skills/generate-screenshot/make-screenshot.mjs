#!/usr/bin/env node
//
// Regenerate assets/screenshot.png.
//
//   node .claude/skills/generate-screenshot/make-screenshot.mjs [--out PATH]
//                                                              [--svg PATH]
//                                                              [--check]
//
// Renders the demo screen (fixture.mjs) through the real Ink components with
// colour on, parses the ANSI back into styled spans, and emits a hand-built SVG
// "terminal window" — Tokyo Night palette, 9px character cell, 20px line. Chrome
// rasterizes that at 2x. There is no real terminal capture involved, which is
// what keeps the output byte-stable across machines and fonts.
//
// The 9px cell is why src/icons.js insists every glyph is exactly one column: a
// two-column glyph would land at the wrong x here as surely as it would in a
// real terminal.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoFile } from './repo.mjs';

// Chalk decides its colour level when it is first imported, so this has to be
// set before anything pulls in ink. Hence the dynamic imports below.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? '1';

const { render } = await import('ink-testing-library');
const { screen } = await import('./fixture.mjs');

// --- palette (Tokyo Night) --------------------------------------------------

const BG = '#1a1b26';
const TITLEBAR = '#16161e';
const FG = '#c0caf5';
const DIM = '#7f8ab0';
const ANSI = {
  31: '#f7768e', // red
  32: '#9ece6a', // green
  33: '#e0af68', // yellow
  35: '#bb9af7', // magenta
  90: DIM,
  91: '#f7768e',
  92: '#9ece6a',
  93: '#e0af68',
  95: '#bb9af7',
  96: '#7dcfff', // cyanBright
};

// --- geometry ---------------------------------------------------------------

const CELL = 9; // character cell width
const LINE = 20; // line height
const X0 = 22; // left margin
const Y0 = 52; // first baseline
const FONT = 15;
const WIDTH = 935; // 22 + 100 columns * 9 + 13
const SCALE = 2; // retina

// --- ANSI -> spans ----------------------------------------------------------

const BLANK = { fg: null, bold: false, underline: false, inverse: false, dim: false };

function parseLine(line) {
  const spans = [];
  let state = { ...BLANK };
  let col = 0;
  let text = '';

  const flush = () => {
    if (text === '') return;
    spans.push({ text, col, ...state });
    col += [...text].length;
    text = '';
  };

  const sgr = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let match;
  while ((match = sgr.exec(line)) !== null) {
    text += line.slice(last, match.index);
    last = match.index + match[0].length;
    flush();
    state = { ...state };
    for (const raw of match[1].split(';')) {
      const code = Number(raw || '0');
      if (code === 0) state = { ...BLANK };
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 4) state.underline = true;
      else if (code === 7) state.inverse = true;
      else if (code === 22) (state.bold = false), (state.dim = false);
      else if (code === 24) state.underline = false;
      else if (code === 27) state.inverse = false;
      else if (code === 39) state.fg = null;
      else if (ANSI[code]) state.fg = ANSI[code];
    }
  }
  text += line.slice(last);
  flush();
  return spans;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function spanSvg(span, y) {
  const cells = [...span.text].length;
  const width = cells * CELL;
  if (cells === 0) return '';
  // Blank runs only matter when inverted, where they paint a highlight.
  if (span.text.trim() === '' && !span.inverse) return '';

  const x = (X0 + span.col * CELL).toFixed(1);
  const colour = span.fg ?? (span.dim ? DIM : FG);
  const attrs =
    (span.bold ? ' font-weight="700"' : '') +
    (span.underline ? ' text-decoration="underline"' : '');
  const metrics =
    `font-size="${FONT}" textLength="${width.toFixed(1)}" lengthAdjust="spacingAndGlyphs" ` +
    'xml:space="preserve"';

  // An inverted span is a filled cell with the background colour punched out.
  if (span.inverse) {
    return (
      `<rect x="${x}" y="${(y - 15).toFixed(1)}" width="${width.toFixed(1)}" height="${LINE}" fill="${colour}"/>` +
      `<text x="${x}" y="${y}" fill="${BG}"${attrs} ${metrics}>${esc(span.text)}</text>`
    );
  }
  return `<text x="${x}" y="${y}" fill="${colour}"${attrs} ${metrics}>${esc(span.text)}</text>`;
}

function buildSvg() {
  const lines = render(screen).lastFrame().split('\n');
  const height = Y0 + (lines.length - 1) * LINE + 40;
  const body = lines
    .flatMap((line, i) => parseLine(line).map((span) => spanSvg(span, Y0 + i * LINE)))
    .filter(Boolean)
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace">
<rect x="0" y="0" width="${WIDTH}" height="${height}" rx="10" fill="${BG}"/>
<rect x="0" y="0" width="${WIDTH}" height="34" rx="10" fill="${TITLEBAR}"/>
<rect x="0" y="24" width="${WIDTH}" height="10" fill="${TITLEBAR}"/>
<circle cx="20" cy="17" r="6" fill="#f7768e"/><circle cx="40" cy="17" r="6" fill="#e0af68"/><circle cx="60" cy="17" r="6" fill="#9ece6a"/>
<text x="${(WIDTH / 2).toFixed(1)}" y="22" fill="${DIM}" font-size="12.5" text-anchor="middle">npx upgrade-interactive</text>
${body}
</svg>
`;
  return { svg, width: WIDTH, height, lines: lines.length };
}

// --- rasterize --------------------------------------------------------------

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  // An explicit CHROME is an instruction, not a hint: fail on it rather than
  // quietly rasterizing with some other browser the machine happens to have.
  if (process.env.CHROME) {
    if (fs.existsSync(process.env.CHROME)) return process.env.CHROME;
    console.error(`make-screenshot: CHROME is set to ${process.env.CHROME}, which does not exist`);
    process.exit(1);
  }
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (found) return found;
  console.error(
    'make-screenshot: no Chrome/Chromium found. Install one, or point CHROME at it:\n' +
      '  CHROME=/path/to/chrome node .claude/skills/generate-screenshot/make-screenshot.mjs\n' +
      'Tried:\n' +
      CHROME_CANDIDATES.map((p) => `  ${p}`).join('\n')
  );
  process.exit(1);
}

function rasterize({ svg, width, height }, outPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nui-screenshot-'));
  const html = path.join(tmp, 'page.html');
  fs.writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;background:transparent}</style>${svg}`
  );

  // Chrome prints allocator noise to stderr on some builds; a missing output
  // file is the real failure signal.
  execFileSync(
    findChrome(),
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--force-device-scale-factor=${SCALE}`,
      `--window-size=${width},${height}`,
      `--screenshot=${outPath}`,
      `file://${html}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  if (!fs.existsSync(outPath)) {
    console.error(`make-screenshot: Chrome produced no file at ${outPath}`);
    process.exit(1);
  }
}

// --- main -------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const outPath = flag('--out') ?? repoFile('assets/screenshot.png');
const svgPath = flag('--svg');
const checkOnly = argv.includes('--check');

const built = buildSvg();
if (svgPath) fs.writeFileSync(svgPath, built.svg);

if (checkOnly) {
  process.stdout.write(render(screen).lastFrame() + '\n');
  console.error(`\n${built.width}x${built.height} (${built.lines} lines) — not written (--check)`);
  process.exit(0);
}

rasterize(built, outPath);
const bytes = fs.statSync(outPath).size;
const shown = path.relative(process.cwd(), outPath);
console.log(
  `wrote ${shown.startsWith('..') ? outPath : shown} — ` +
    `${built.width * SCALE}x${built.height * SCALE} (${built.lines} lines, ${bytes} bytes)`
);
