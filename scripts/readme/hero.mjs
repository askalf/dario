#!/usr/bin/env node
// README hero: the seam between every tool you own and the subscriptions you
// already pay for. Animated (SMIL motion + CSS pulses), theme-specific, and
// self-contained — see lib.mjs for why. Regenerate with:
//
//   node scripts/readme/hero.mjs
//
// The animation is a loop of ~14 s: requests flow left → dario → a plan; every
// cycle one Claude-bound request meets a 429 and is re-served by the ChatGPT
// plan with `x-dario-pool-fallback` on the response, which is what
// --pool-fallback does. Everything drawn here corresponds to a shipped
// feature; nothing is aspirational.

import { mkdirSync, writeFileSync } from 'node:fs';
import { OUT_DIR, THEMES, esc, svgDoc } from './lib.mjs';

const W = 1180, H = 420;

// ── layout ──────────────────────────────────────────────────────────
const clients = [
  { label: 'Claude Code', shape: 'anthropic', to: 'claude' },
  { label: 'Cursor', shape: 'openai', to: 'claude' },
  { label: 'Cline · Roo · Kilo', shape: 'anthropic', to: 'claude' },
  { label: 'Aider', shape: 'anthropic', to: 'claude' },
  { label: 'Continue', shape: 'anthropic', to: 'keys' },
  { label: 'Zed', shape: 'anthropic', to: 'claude' },
  { label: 'Codex CLI', shape: 'openai', to: 'chatgpt' },
  { label: 'Agent SDK · curl', shape: 'anthropic', to: 'claude' },
];
const CHIP = { x: 36, w: 196, h: 30, y0: 42, pitch: 45 };
const NODE = { x: 462, y: 112, w: 256, h: 192 };
const CARD_X = 880, CARD_W = 272;
const cards = {
  claude: { y: 30, h: 128, title: 'Claude plan', sub: 'Pro · Max 5x · Max 20x' },
  chatgpt: { y: 178, h: 84, title: 'ChatGPT plan', sub: 'Plus · Pro  (Codex engine)' },
  keys: { y: 298, h: 90, title: 'API keys', sub: 'OpenAI · Groq · OpenRouter · Ollama' },
};

const chipCy = (i) => CHIP.y0 + i * CHIP.pitch + CHIP.h / 2;
const nodeInY = (i) => NODE.y + 28 + i * ((NODE.h - 56) / (clients.length - 1));
const cardCy = (k) => cards[k].y + cards[k].h / 2;

// One path per client: chip → node left edge → node right edge → its plan.
function routePath(i, to) {
  const x0 = CHIP.x + CHIP.w, y0 = chipCy(i);
  const x1 = NODE.x, y1 = nodeInY(i);
  const x2 = NODE.x + NODE.w, y2 = nodeInY(i);
  const x3 = CARD_X, y3 = cardCy(to);
  const c = (xa, ya, xb, yb) => `C ${xa + (xb - xa) * 0.5} ${ya} ${xa + (xb - xa) * 0.5} ${yb} ${xb} ${yb}`;
  return `M ${x0} ${y0} ${c(x0, y0, x1, y1)} L ${x2} ${y2} ${c(x2, y2, x3, y3)}`;
}

function render(t) {
  const shapeColor = (s) => (s === 'anthropic' ? t.bright : t.cyan);
  const chipEls = clients.map((c, i) => {
    const y = CHIP.y0 + i * CHIP.pitch;
    return `<g>
  <rect x="${CHIP.x}" y="${y}" width="${CHIP.w}" height="${CHIP.h}" rx="8" fill="${t.panel}" stroke="${t.border}"/>
  <circle cx="${CHIP.x + 16}" cy="${y + CHIP.h / 2}" r="3.5" fill="${shapeColor(c.shape)}"/>
  <text x="${CHIP.x + 30}" y="${y + CHIP.h / 2 + 5}" font-size="14" fill="${t.text}">${esc(c.label)}</text>
</g>`;
  }).join('\n');

  const routeEls = clients.map((c, i) =>
    `<path id="r${i}" d="${routePath(i, c.to)}" fill="none" stroke="${t.path}" stroke-width="1.25"/>`).join('\n');
  // Alternate route for the failover vignette: the first client, re-served by the ChatGPT plan.
  const altRoute = `<path id="rf" d="${routePath(0, 'chatgpt')}" fill="none" stroke="${t.magenta}" stroke-width="1.25" stroke-dasharray="4 5" opacity="0">
  <animate attributeName="opacity" values="0;0;0.9;0.9;0;0" keyTimes="0;0.5;0.53;0.78;0.82;1" dur="14s" repeatCount="indefinite"/>
</path>`;

  // Request packets: continuous traffic, staggered.
  // A circle with an animateMotion sits at (0,0) until its begin time, so each
  // packet stays invisible until it starts moving.
  const packets = clients.map((c, i) => `<circle r="3.6" fill="${shapeColor(c.shape)}" opacity="0">
  <set attributeName="opacity" to="1" begin="${(i * 0.41).toFixed(2)}s"/>
  <animateMotion dur="3.2s" begin="${(i * 0.41).toFixed(2)}s" repeatCount="indefinite"><mpath href="#r${i}"/></animateMotion>
</circle>`).join('\n');
  // Responses travelling back on a few routes (lighter, reversed).
  const responses = [0, 2, 5, 7].map((i, k) => `<circle r="2.6" fill="${t.dim}" opacity="0">
  <set attributeName="opacity" to="0.85" begin="${(1.6 + k * 0.7).toFixed(2)}s"/>
  <animateMotion dur="3.2s" begin="${(1.6 + k * 0.7).toFixed(2)}s" keyPoints="1;0" keyTimes="0;1" calcMode="linear" repeatCount="indefinite"><mpath href="#r${i}"/></animateMotion>
</circle>`).join('\n');
  // Failover packet: parked invisibly, then travels chip → dario → ChatGPT during the 429 window.
  const failoverPacket = `<circle r="4" fill="${t.magenta}" opacity="0">
  <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.53;0.535;0.68;0.69;1" dur="14s" repeatCount="indefinite"/>
  <animateMotion dur="14s" keyPoints="0;0;1;1" keyTimes="0;0.53;0.69;1" calcMode="linear" repeatCount="indefinite"><mpath href="#rf"/></animateMotion>
</circle>`;

  const node = `<g>
  <rect class="pulse" x="${NODE.x - 6}" y="${NODE.y - 6}" width="${NODE.w + 12}" height="${NODE.h + 12}" rx="20" fill="none" stroke="${t.accent}" stroke-width="2"/>
  <rect x="${NODE.x}" y="${NODE.y}" width="${NODE.w}" height="${NODE.h}" rx="16" fill="${t.panel2}" stroke="${t.accent}" stroke-width="1.5"/>
  <text x="${NODE.x + NODE.w / 2}" y="${NODE.y + 62}" text-anchor="middle" font-size="40" font-weight="700" fill="${t.text}" letter-spacing="-1.5">dario</text>
  <text x="${NODE.x + NODE.w / 2}" y="${NODE.y + 88}" text-anchor="middle" font-size="13" fill="${t.dim}">http://localhost:3456</text>
  <text x="${NODE.x + NODE.w / 2}" y="${NODE.y + 122}" text-anchor="middle" font-size="12.5" fill="${t.bright}">/v1/messages</text>
  <text x="${NODE.x + NODE.w / 2}" y="${NODE.y + 142}" text-anchor="middle" font-size="12.5" fill="${t.cyan}">/v1/chat/completions</text>
  <text x="${NODE.x + NODE.w / 2}" y="${NODE.y + 162}" text-anchor="middle" font-size="10.5" fill="${t.muted}">reads the shape · picks the plan</text>
  <text x="${NODE.x + NODE.w / 2}" y="${NODE.y + 177}" text-anchor="middle" font-size="10.5" fill="${t.muted}">replays it faithfully</text>
</g>`;

  const seats = [['work', 62, 82], ['personal', 34, 56], ['side', 88, 70]];
  const claude = cards.claude;
  const claudeCard = `<g>
  <rect x="${CARD_X}" y="${claude.y}" width="${CARD_W}" height="${claude.h}" rx="12" fill="${t.panel}" stroke="${t.border}"/>
  <text x="${CARD_X + 16}" y="${claude.y + 26}" font-size="15" font-weight="700" fill="${t.text}">${claude.title}</text>
  <text x="${CARD_X + 16}" y="${claude.y + 44}" font-size="11.5" fill="${t.dim}">${esc(claude.sub)}</text>
  ${seats.map(([alias, a, b], i) => {
    const y = claude.y + 60 + i * 18;
    return `<text x="${CARD_X + 16}" y="${y + 8}" font-size="11" fill="${t.dim}">${alias}</text>
  <rect x="${CARD_X + 84}" y="${y}" width="140" height="8" rx="4" fill="${t.track}"/>
  <rect x="${CARD_X + 84}" y="${y}" width="${a}" height="8" rx="4" fill="${t.accent}"><animate attributeName="width" values="${a};${b};${a}" dur="${9 + i * 2}s" repeatCount="indefinite"/></rect>
  <text x="${CARD_X + 232}" y="${y + 8}" font-size="10.5" fill="${t.muted}">5h</text>`;
  }).join('\n  ')}
  <text x="${CARD_X + 16}" y="${claude.y + claude.h - 10}" font-size="10.5" fill="${t.muted}">headroom-routed · sticky · 429 retry</text>
  <g opacity="0">
    <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.5;0.52;0.75;0.78;1" dur="14s" repeatCount="indefinite"/>
    <rect x="${CARD_X + CARD_W - 74}" y="${claude.y + 12}" width="58" height="20" rx="10" fill="${t.red}" opacity="0.18"/>
    <text x="${CARD_X + CARD_W - 45}" y="${claude.y + 26}" text-anchor="middle" font-size="12" font-weight="700" fill="${t.red}">429</text>
  </g>
  <g opacity="0">
    <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.33;0.35;0.48;0.5;1" dur="14s" repeatCount="indefinite"/>
    <rect x="${CARD_X + CARD_W - 74}" y="${claude.y + 12}" width="58" height="20" rx="10" fill="${t.green}" opacity="0.18"/>
    <text x="${CARD_X + CARD_W - 45}" y="${claude.y + 26}" text-anchor="middle" font-size="11" font-weight="700" fill="${t.green}">200</text>
  </g>
</g>`;

  const cg = cards.chatgpt;
  const chatgptCard = `<g>
  <rect x="${CARD_X}" y="${cg.y}" width="${CARD_W}" height="${cg.h}" rx="12" fill="${t.panel}" stroke="${t.border}"/>
  <text x="${CARD_X + 16}" y="${cg.y + 26}" font-size="15" font-weight="700" fill="${t.text}">${cg.title}</text>
  <text x="${CARD_X + 16}" y="${cg.y + 44}" font-size="11.5" fill="${t.dim}">${esc(cg.sub)}</text>
  <text x="${CARD_X + 16}" y="${cg.y + 64}" font-size="10" fill="${t.muted}">serves /v1/messages + chat/completions</text>
  <text x="${CARD_X + 16}" y="${cg.y + 80}" font-size="10" fill="${t.muted}">Claude pool fails over here, and back</text>
  <g opacity="0">
    <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.6;0.63;0.85;0.9;1" dur="14s" repeatCount="indefinite"/>
    <rect x="${CARD_X + 24}" y="${cg.y + cg.h + 6}" width="224" height="20" rx="10" fill="${t.magenta}" opacity="0.14"/>
    <text x="${CARD_X + CARD_W / 2}" y="${cg.y + cg.h + 20}" text-anchor="middle" font-size="10.5" fill="${t.magenta}">x-dario-pool-fallback: gpt-5.6-sol</text>
  </g>
</g>`;

  const ky = cards.keys;
  const keysCard = `<g>
  <rect x="${CARD_X}" y="${ky.y}" width="${CARD_W}" height="${ky.h}" rx="12" fill="${t.panel}" stroke="${t.border}"/>
  <text x="${CARD_X + 16}" y="${ky.y + 26}" font-size="15" font-weight="700" fill="${t.text}">${ky.title}</text>
  <text x="${CARD_X + 16}" y="${ky.y + 44}" font-size="11.5" fill="${t.dim}">${esc(ky.sub)}</text>
  <text x="${CARD_X + 16}" y="${ky.y + 64}" font-size="10" fill="${t.muted}">any OpenAI-compatible endpoint</text>
  <text x="${CARD_X + 16}" y="${ky.y + 80}" font-size="10" fill="${t.cyan}">openai:gpt-4o · groq:llama · local:qwen</text>
</g>`;

  const legend = `<g font-size="11" fill="${t.dim}">
  <circle cx="44" cy="${H - 20}" r="3.5" fill="${t.bright}"/><text x="54" y="${H - 16}">Anthropic Messages shape</text>
  <circle cx="240" cy="${H - 20}" r="3.5" fill="${t.cyan}"/><text x="250" y="${H - 16}">OpenAI chat shape</text>
  <text x="${W - 36}" y="${H - 16}" text-anchor="end">one endpoint · either wire shape · either plan · failover between them</text>
</g>`;

  const body = `<rect width="${W}" height="${H}" rx="18" fill="${t.bg}"${t.name === 'light' ? ` stroke="${t.border}"` : ''}/>
<radialGradient id="ga" cx="0.25" cy="0.2" r="0.6"><stop offset="0" stop-color="${t.glowA}"/><stop offset="1" stop-color="rgba(0,0,0,0)"/></radialGradient>
<radialGradient id="gb" cx="0.85" cy="0.9" r="0.6"><stop offset="0" stop-color="${t.glowB}"/><stop offset="1" stop-color="rgba(0,0,0,0)"/></radialGradient>
<rect width="${W}" height="${H}" rx="18" fill="url(#ga)"/><rect width="${W}" height="${H}" rx="18" fill="url(#gb)"/>
<text x="${CHIP.x + 2}" y="${CHIP.y0 - 14}" font-size="11" fill="${t.muted}" letter-spacing="1.5">TOOLS YOU ALREADY USE</text>
<text x="${CARD_X + 2}" y="${cards.claude.y - 12}" font-size="11" fill="${t.muted}" letter-spacing="1.5">PLANS YOU ALREADY PAY FOR</text>
${routeEls}
${altRoute}
${chipEls}
${node}
${claudeCard}
${chatgptCard}
${keysCard}
${packets}
${responses}
${failoverPacket}
${legend}`;

  const style = `.pulse{animation:pulse 3.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes pulse{0%,100%{opacity:.18}50%{opacity:.6}}`;

  return svgDoc({
    w: W, h: H,
    title: 'dario routes every AI tool you use to the subscriptions you already pay for',
    desc: 'Diagram: coding tools on the left (Claude Code, Cursor, Cline, Aider, Continue, Zed, Codex CLI, the Agent SDK) send requests to a local dario endpoint at localhost:3456, which forwards each one to a Claude plan (a pool of seats routed by headroom), a ChatGPT plan, or an API-key backend. When the Claude pool returns 429 the request is served by the ChatGPT plan and the response carries an x-dario-pool-fallback header.',
    body, style,
  });
}

mkdirSync(OUT_DIR, { recursive: true });
for (const theme of Object.values(THEMES)) {
  const file = `${OUT_DIR}/hero-${theme.name}.svg`;
  writeFileSync(file, render(theme));
  console.log('wrote', file);
}
