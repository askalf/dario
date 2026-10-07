/**
 * The betas a model family does not send although the opus base (TEMPLATE.anthropic_beta) carries
 * them. betaForModel removes each key's flags from every model whose lowercased id contains the
 * key, so `sonnet` covers the whole Sonnet line and `sonnet-4` only the Sonnet 4 line.
 *
 * An entry matches dario's header to the installed Claude Code's captured set for that family; it
 * says nothing about upstream acceptance. A beta can enable a request feature that the body still
 * uses after the flag is gone, so a removal here is only as sound as the capture it came from. The
 * wire-drift watcher reports a mismatch in either direction.
 *
 * scripts/wire-drift-fix.mjs adds to this object from a wire-drift report. It reads the JSON
 * literal between the markers and writes it back as JSON.stringify(drops, null, 2), so keep it
 * plain JSON in that form: the script refuses a block it cannot read back byte for byte.
 */
// wire-drift-fix:begin
export const FAMILY_BETA_DROPS: Readonly<Record<string, readonly string[]>> = {
  "haiku": [
    "mid-conversation-system-2026-04-07",
    "mid-conversation-tool-changes-2026-07-01",
    "inline-tools-2026-09-15",
    "effort-2025-11-24",
    "afk-mode-2026-01-31"
  ],
  "sonnet": [
    "mid-conversation-tool-changes-2026-07-01",
    "inline-tools-2026-09-15"
  ],
  "sonnet-4": [
    "mid-conversation-system-2026-04-07"
  ]
};
// wire-drift-fix:end
