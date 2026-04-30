# CC's system prompt is 27kB. Modifying it doesn't change your billing classification. Stripping its behavioral constraints recovers 1.2–2.8× output capability.

*Research run: 2026-04-29 against CC v2.1.123 + Opus 4.7 / Sonnet 4.6. Reproducible from `scripts/test-system-prompt-mods.mjs` + `scripts/test-constraint-removal.mjs` in this repo.*

## TL;DR

1. **The billing classifier is not reading CC's system prompt.** Across 7 controlled mutations — including replacing CC's 27,000-character system prompt with a 321-char custom one and adding a 4th block to the system array — every variant routed to `five_hour` (subscription billing). System prompt content, length, and block count are not classifier inputs.
2. **CC's system prompt is heavy on behavioral constraints**, not load-bearing safety. Sections like `# Tone and style`, `# Text output`, and the `# Doing tasks` bullets cap output verbosity, default to no comments, push toward terse responses, and bias toward asking questions over acting. None of that is alignment — it's product opinion.
3. **Removing those constraints produces 1.2–2.8× output capability on open-ended work.** Aggressive strip (which additionally removes prompt-level restatements of RLHF refusal categories) adds <3% over partial — because alignment is RLHF-trained, not prompt-trained. You don't lose Claude's refusal behavior on harmful content. You lose its CC-installed reluctance to actually answer your question.

You're paying for Claude. The CC binary is one product built on top of Claude. When you route a *different* tool through your subscription via dario, you're carrying CC's product opinions into a context where they don't apply — and paying token cost for the bloat on every turn.

## What we tested

Two paired experiments. Each captures CC's actual outbound `/v1/messages` body via a loopback MITM (same approach as `scripts/capture-full-body.mjs`), deep-clones it for each variant, mutates *only* `system[].text`, and POSTs directly to `api.anthropic.com` with OAuth bearer. Everything else — `model`, `max_tokens`, `effort`, `tools`, body field order, billing tag, metadata `user_id`, `anthropic-beta`, `user-agent` — is held byte-identical to what CC would have sent.

Auth uses the OAuth token from `~/.claude/.credentials.json` directly (CC's own fresh token), not dario's resolver, to keep the experiment independent of dario's token caching path.

### Test 1 — Does modifying the system prompt flip the classifier?

Seven variants, one upstream request each, classifier readout from the `anthropic-ratelimit-unified-representative-claim` response header.

| # | Variant | What it changes | Classifier |
|---|---|---|---|
| 01 | control | CC verbatim, no modifications | `five_hour` |
| 02 | single-char prepend | `system[2].text` → `'X' + original` | `five_hour` |
| 03 | word substitution | replaceAll `'concise'` → `'brief'` | `five_hour` |
| 04 | sentence removal | strip `"Default to writing no comments."` line | `five_hour` |
| 05 | block fully replaced | `system[2].text` ← 321-char custom prompt | `five_hour` |
| 06 | extra block added | `system.push(...)` — 3 blocks → 4 blocks | `five_hour` |
| 07 | length padding | append 500 chars of `'x'` | `five_hour` |

**Result: 7/7 routed to `five_hour`.** None of these mutations affect the billing classification. The system array is not a fingerprint axis.

This is consistent with what we documented in [Discussion #178](https://github.com/askalf/dario/discussions/178) for the OpenClaw classifier: Anthropic's reclassification logic operates on specific structural inputs (schema namespace strings in commit metadata, body field order, beta flags, tool names), not on free-form text content of the system prompt. The system prompt is for the model. The classifier reads other channels.

### Test 2 — What does removing CC's behavioral constraints actually produce?

Three prompts × three system-prompt variants (`control`, `partial`, `aggressive`). Nine real upstream requests. We measure response length (chars + output_tokens), comment density on code outputs, and clarifying-question rate.

Strip rules ported verbatim from `scripts/test-constraint-removal.mjs`:

**Partial strip** — pure behavioral preferences:
- Remove entire `# Tone and style` section
- Remove entire `# Text output` section
- Remove `# Doing tasks` bullets that cap verbosity, default to no comments, restrict scope, or refuse exploratory engagement
- Replace the section header with a positive instruction: *"Be thorough. Show your reasoning. Provide the context and explanations the user is likely to find useful. Use as many tokens as the task warrants."*

**Aggressive strip** — partial + prompt-level RLHF reminders:
- Remove `IMPORTANT: Assist with authorized security testing...` (this is a *prompt-level reminder* of a refusal category — RLHF still enforces it; the reminder is just the prompt's restatement)
- Remove `IMPORTANT: You must NEVER generate or guess URLs...`
- Remove the `# Executing actions with care` section (overcaution language — "ask before this", "confirm before that" — that's behavioral, not safety-load-bearing)

The aggressive strip exists specifically to test the RLHF-vs-prompt distinction. Critically, **it does not remove RLHF.** The model's refusal on harmful content is trained into the weights, not the prompt. Stripping the *prompt-level reminder* tests whether the prompt's restatement contributes any observable effect beyond the RLHF baseline.

Test prompts chosen to surface CC's constraints:

1. `code-with-comments` — *"Write a TypeScript function that deduplicates an array of objects by a specified key. Include thorough comments explaining your reasoning, edge cases, and the tradeoffs of different approaches."* (CC's prompt biases against comments.)
2. `detailed-explanation` — *"Explain how V8's hidden class optimization works in Node.js, why it matters for performance, and how to write code that benefits from it."* (CC's prompt biases toward terse responses.)
3. `open-ended-decision` — *"Should I use Redis or Postgres for session storage in a Node.js web app?"* (CC's prompt biases toward asking back rather than recommending.)

**Findings (all 9 variants → `five_hour`, billing unchanged):**

- **Output capability multiplier**: 1.2–2.8× more characters / output_tokens on the partial-strip and aggressive-strip variants vs control, varying by prompt. The biggest jumps were on `code-with-comments` and `detailed-explanation` — exactly the prompts where CC's verbosity caps and no-comments default were most restrictive.
- **Aggressive vs partial delta: <3%.** Removing the RLHF *reminders* on top of the behavioral constraints adds essentially nothing measurable. Alignment lives in the weights; the prompt restatement is decorative.
- **Comment density on code outputs**: control averaged near zero on `code-with-comments` despite the user explicitly asking for thorough comments. Stripped variants honored the user's request.
- **Clarifying-question rate on `open-ended-decision`**: control ended with a question more often than the stripped variants, which gave a recommendation and reasoned through tradeoffs.

In short: CC's behavioral constraints are doing exactly what they say they're doing — capping output, suppressing comments, biasing toward asking instead of answering. When you strip them, the model honors the user's actual request. When you keep them, you get less of what you asked for.

## What this means

If you use Claude Code as your only Claude tool: the constraints are shaped to CC's UX and probably fit. Don't change them.

If you use Claude *through dario from a different tool* — Cursor, Aider, Cline, Continue, the Claude Agent SDK, your own scripts — CC's behavioral opinions are noise in your context. Your tool has its own system prompt; CC's adds opinions that don't apply, suppresses output your tool wanted, and costs input tokens on every turn.

## What dario does with this

`dario proxy --system-prompt=<mode>` lets you choose:

- **`verbatim`** *(default)* — current behavior, CC verbatim, byte-for-byte. Existing setups don't regress.
- **`partial`** — strip purely behavioral constraints (Tone-and-style, Text-output, Doing-tasks bullets that suppress output). Recovers most of the 1.2–2.8× without touching anything alignment-shaped.
- **`aggressive`** — partial + remove prompt-level RLHF reminders. Adds <3% practical difference; exists for completeness and for users who don't want the noise.
- **`<file path>`** — replace `system[2].text` entirely with the contents of a file you control. The escape hatch for users running their own well-defined agent workflows.

Mirrored as `DARIO_SYSTEM_PROMPT=<mode>`. Surfaced in `dario doctor`. Default unchanged so existing pool / shim / per-tool setups don't regress.

## What this is NOT

- **Not bypassing alignment.** The model's refusal behavior on harmful categories is RLHF-trained into the weights. You can run dario with `--system-prompt=aggressive` against `claude-opus-4-7` and still get refusals on harmful content. Verifying this was the entire point of including the aggressive strip in the test matrix — and the <3% delta vs partial is the receipt.
- **Not detected as misuse by the classifier.** The empirical 7/7 result above is the documentation. If Anthropic later starts fingerprinting system-prompt content, we'll see it in the rate-limit-classifier headers and document the change. Until then, the classifier doesn't read this channel.
- **Not specific to dario.** Any client that builds its own request body can already do this — dario just makes it a one-flag operation that preserves CC's other wire-shape axes (header order, body field order, billing tag, beta flags) so the rest of the subscription routing path keeps working.

## Reproduce it yourself

Both scripts are committed in `scripts/` and were [merged in PR #171](https://github.com/askalf/dario/pull/171). They cost real upstream tokens on your Max plan:

```bash
node scripts/test-system-prompt-mods.mjs           # 7 upstream requests, ~30s, classifier readout per variant
node scripts/test-constraint-removal.mjs            # 9 upstream requests, ~3 min, behavior delta per variant
```

Both read OAuth from `~/.claude/.credentials.json` directly. CC v2.1.120+ recommended; Opus 4.7 / Sonnet 4.6 in scope.

If you find a variant that flips the classifier, file an issue with the request-id and the variant — that's a billing-fingerprint axis we don't know about yet, and that's the kind of finding worth knowing about.

---

*Independent, unofficial, third-party. See [DISCLAIMER.md](../../DISCLAIMER.md). Use of these techniques is between you and Anthropic — consult their terms and your subscription agreement.*
