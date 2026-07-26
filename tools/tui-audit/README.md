# TUI audit harness

Drives the **real** `startTuiApp()` through a fake TTY against a local stub
proxy — real sockets, real SSE, real raw-mode key parsing, real tab
mount/unmount — and audits every frame the app actually writes to stdout.

```bash
npm run build
npm run audit:tui            # or: npm run audit:tui -- --strict
```

Output lands in `.tui-audit/` (gitignored): one `frames-<cols>x<rows>.txt`
per geometry with the ANSI stripped, plus `findings.json`.

## What it checks

Per frame, across twelve geometries from 200×50 down to 24×8:

- **row width** — no line wider than `cols` (a wrapped row costs a second
  physical line and pushes the panel head off the top of the alt-screen)
- **frame height** — no more physical rows than the terminal has
- **SGR balance** — per line and cumulatively across the frame, so an
  unclosed `dim()`/`fg()` can't bleed into the next line or the next frame

`--strict` exits non-zero on any finding. Without it the exit code is 0 and
you read the report — the default, because a finding usually wants human
judgement about which tab should give up what.

## Why it isn't in `npm test`

It takes ~25 seconds, needs `dist/` built, and binds a port. `test/` holds
the fast pure-render assertions (`tui-tabs`, `tui-frame`, `tui-budget`);
this is the slow integration pass you run when changing render or layout
code.

## Safety

Sends navigation keys only — Tab and arrows. Never `s`/`d`/`r`/`R`/Enter,
which would write config or POST `/admin/resume`. The stub binds 39456, not
3456, so it cannot collide with a real `dario proxy`. Override with
`STUB_PORT`.

## The lesson worth keeping

This harness and the fixture sweeps in `test/` catch **different** classes
of bug, and neither is sufficient alone:

- It found three tabs rendering taller than the terminal at a default 80×24,
  scrolling the header and tab strip off the top — only visible with real
  data flowing through the real loop.
- It **missed** `progressBar()` throwing `RangeError` on a negative width,
  which crashed Analytics at any width ≤ 31, because its narrowest geometry
  was then 40 columns. A fixture sweep down to 24×6 caught that.
- Going the other way, `test/tui-frame.mjs` **missed** the Analytics title
  overflowing at 24 columns: at the 6-row height it sweeps, the frame clamp
  replaces the title with the `… more rows` note before its width can be
  measured. This harness caught it at 24×8.

Live runs are better evidence for what real data does; fixture sweeps are
better for edge geometry. If you extend either, push the ranges outward.
