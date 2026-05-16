# Rendering the social-preview image

The repo's GitHub social-preview image (the `og:image` that appears on every X / HN / Reddit / Slack share of `github.com/askalf/dario`) lives outside the repo — GitHub uploads it via Settings → Options → Social preview.

This directory has the source template (`og-image.html`) and the recipe to render it to a 1280×640 PNG.

## Render recipe (Chrome / Chromium / Edge — any Chromium-based browser)

1. Open `scripts/og-image.html` directly in Chrome:

   ```sh
   # Linux / macOS
   open scripts/og-image.html

   # Windows
   start scripts/og-image.html
   ```

2. Open DevTools (F12 or Ctrl+Shift+I).

3. Cmd+Shift+P (Mac) or Ctrl+Shift+P (Linux/Windows) → search for **"Capture screenshot"** → pick "Capture full size screenshot".

   This produces a PNG at the exact 1280×640 dimensions GitHub expects (no scaling, no cropping).

4. Upload to GitHub:

   1. Go to https://github.com/askalf/dario/settings
   2. Scroll to **Social preview**
   3. **Edit** → upload the PNG you just saved
   4. Save

## Why HTML + DevTools instead of a Node script

A pure-Node PNG renderer would either need a native dep (sharp / canvas) — which would break the repo's "0 runtime dependencies" invariant if it ever leaked into anything users install — or a 200+ LOC pure-zlib PNG encoder plus a bitmap-font rasterizer. Neither is worth the maintenance cost for a one-time visual artifact that lives outside the repo anyway.

The HTML template is also easier to iterate on: change colors, swap mockup data, preview live in the browser, screenshot again. The whole pipeline is "edit file → save → reload → screenshot."

## Updating the og:image after a future release

Edit `og-image.html`:

- `.version-pill` — bump to the current major (e.g. `v5.0`)
- `.install-line` — keep as `npm i -g @askalf/dario` (always latest)
- `.tui` block — update mockup to reflect any new tab / feature you want the preview to show off
- `.meta-row` — update if the "0 runtime deps / SLSA / hourly drift" facts change

Then re-run the render recipe and re-upload.
