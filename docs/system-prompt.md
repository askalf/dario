# System-prompt mode (v3.34.0)

`dario proxy --system-prompt=<mode>` controls the system prompt dario sends upstream on Claude-backend requests. The default replays Claude Code's prompt verbatim — every existing setup keeps its current behavior. The non-default modes let you strip CC's behavioral constraints without losing subscription billing.

The empirical basis for this feature lives in [`docs/research/system-prompt.md`](./research/system-prompt.md) — short version: Anthropic's billing classifier doesn't read the system prompt content. We tested 7 mutations (single char, word substitution, full replacement, extra block, length padding) and all routed to `five_hour` (subscription). System prompt is for the model. The classifier reads other channels.

## Modes

| Mode | What it does | Output capability vs verbatim |
|---|---|---|
| `verbatim` *(default)* | CC's prompt unchanged, byte-for-byte | baseline |
| `partial` | Strip `# Tone and style`, `# Text output`, and the scope/verbosity/comment bullets in `# Doing tasks`. Keeps every `IMPORTANT:` refusal reminder and every tool description. | ~1.2–2.8× on open-ended work |
| `aggressive` | Partial + remove the prompt-level RLHF restatements (`IMPORTANT: Assist with authorized security testing…`, `IMPORTANT: You must NEVER generate or guess URLs…`) and the `# Executing actions with care` section. | <3% above partial |
| `<file path>` | Replace the slot entirely with the contents of a file you control. The escape hatch for users running well-defined agent workflows with their own system prompt. | depends on your prompt |

## Aggressive vs partial — what's the actual difference?

Aggressive is provided for completeness, not because it does meaningful work. The added removals are *prompt-level restatements* of refusal categories — reminders the prompt makes about RLHF behavior that's already trained into the model's weights. Removing the reminder doesn't remove the trained behavior. We measured this: 9 trials (3 prompts × 3 strip levels), aggressive vs partial added <3% practical change on benign tasks.

If you're choosing between `partial` and `aggressive`, choose `partial`. The aggressive mode exists so the test matrix could distinguish "behavioral constraint" (real, in the prompt, ~1.2–2.8× effect) from "alignment restatement" (decorative, in the prompt but trained into the weights, <3% effect).

## Custom file mode

```bash
dario proxy --system-prompt=/path/to/your-prompt.txt
```

The CLI reads the file at startup and passes the contents to the runtime path. The proxy never re-reads the file — to change the prompt, restart the proxy. An empty file or unreadable path fails fast with a clear error rather than silently degrading to verbatim.

The custom prompt **replaces** the entire `system[2].text` slot. Your client's own system prompt (the one your agent normally sends) is still appended after, just as it would be on top of the CC verbatim default. So a custom prompt + your agent's prompt = the model's full instruction context.

## Configuration sources

```bash
dario proxy --system-prompt=partial                    # CLI flag
DARIO_SYSTEM_PROMPT=partial dario proxy                # env var
dario proxy --system-prompt=/etc/dario/prompt.txt      # file path
```

CLI flag wins over env var. Both are read at proxy startup; mid-run changes require a restart.

`dario doctor` surfaces the active mode + char-count delta vs CC's default, so you can confirm at a glance which mode is actually live without reading the proxy log.

## What this is NOT

- **Not bypassing alignment.** The model's refusal behavior on harmful content is RLHF-trained into the weights, not the prompt. You can run `--system-prompt=aggressive` and still get refusals on harmful requests — that's the entire point of including aggressive in the test matrix and measuring <3% delta.
- **Not detected as misuse by the classifier.** 7/7 variants routed to `five_hour` in the empirical test. If Anthropic later starts fingerprinting system-prompt content, you'll see it in the rate-limit-classifier headers; we'll document the change and update this page.
- **Not specific to dario.** Any client building its own request body could already do this. Dario makes it a one-flag operation that preserves CC's other wire-shape axes (header order, body field order, billing tag, beta flags) so the rest of the subscription routing path keeps working.

## Reproducibility

The strip rules in `src/cc-template.ts:resolveSystemPrompt` are ported byte-for-byte from `scripts/test-constraint-removal.mjs`, which is committed in this repo. The empirical billing-classifier validation script is `scripts/test-system-prompt-mods.mjs`. Both run real upstream requests against your own subscription.

```bash
node scripts/test-system-prompt-mods.mjs            # 7 upstream requests, classifier readout per variant
node scripts/test-constraint-removal.mjs             # 9 upstream requests, behavior delta per variant
```

If you find a mutation that flips the classifier, file an issue with the request-id and the variant — that's a fingerprint axis we don't know about, and that's worth knowing.
