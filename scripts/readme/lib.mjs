// Shared pieces for the README asset generators (hero, quickstart, tui).
//
// Everything here exists so the SVGs are self-contained: GitHub serves README
// images through its camo proxy inside an <img>, which loads no external
// fonts, no scripts and no stylesheets. The brand face (Space Mono, OFL) is
// therefore embedded as base64 — the Latin subset only, ~16 KB per weight.
//
// Zero dependencies, on purpose: this is the same posture as the package.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(HERE, '..', '..', '.github', 'readme');

const b64 = (file) => readFileSync(join(HERE, 'fonts', file)).toString('base64');

/** @font-face rules for the embedded Space Mono subset. */
export function fontFaces({ bold = true } = {}) {
  const face = (weight, file) =>
    `@font-face{font-family:'Space Mono';font-style:normal;font-weight:${weight};` +
    `src:url(data:font/woff2;base64,${b64(file)}) format('woff2')}`;
  return face(400, 'SpaceMono-400-latin.woff2') + (bold ? face(700, 'SpaceMono-700-latin.woff2') : '');
}

export const FONT = "'Space Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Space Mono's advance width is 612/1000 em. Used to lay out monospace text
// deterministically; the terminal/TUI renderers additionally pin each line
// with textLength so box art stays aligned in any fallback font.
export const CHAR_W = 0.612;

/** Palette per theme. Dark tracks the askalf brand; light tracks GitHub's own surface colours. */
export const THEMES = {
  dark: {
    name: 'dark',
    bg: '#0a0a0f', panel: '#12111a', panel2: '#17161f', border: '#2a2740',
    text: '#e8e6f5', dim: '#8a85a8', muted: '#5a5670',
    accent: '#8b5cf6', bright: '#c084fc', magenta: '#c026d3',
    green: '#34d399', amber: '#fbbf24', red: '#f87171', cyan: '#22d3ee',
    path: '#332f4d', glowA: 'rgba(124,58,237,0.20)', glowB: 'rgba(192,38,211,0.14)',
    termBg: '#0d0c14', termChrome: '#1a1826', track: '#26243a',
  },
  light: {
    name: 'light',
    bg: '#ffffff', panel: '#f6f8fa', panel2: '#ffffff', border: '#d0d7de',
    text: '#1f2328', dim: '#59636e', muted: '#8b949e',
    accent: '#6d28d9', bright: '#7c3aed', magenta: '#a21caf',
    green: '#1a7f37', amber: '#9a6700', red: '#cf222e', cyan: '#0e7490',
    path: '#d0d7de', glowA: 'rgba(124,58,237,0.10)', glowB: 'rgba(192,38,211,0.07)',
    termBg: '#0d0c14', termChrome: '#1a1826', track: '#e6e0f5',
  },
};

export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Wrap a document: viewBox, embedded font, a11y title/desc, reduced-motion opt-out for CSS animations. */
export function svgDoc({ w, h, title, desc, body, style = '', bold = true }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<defs><style>${fontFaces({ bold })}
text{font-family:${FONT};}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
${style}</style></defs>
${body}
</svg>
`;
}

/** Write both theme variants with one body function. */
export function writeThemed(write, base, render) {
  for (const theme of Object.values(THEMES)) {
    write(join(OUT_DIR, `${base}-${theme.name}.svg`), render(theme));
  }
}
