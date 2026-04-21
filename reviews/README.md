# Reviews

Independent senior-engineer-style reviews of dario from frontier LLMs. Same prompt given to each. Each reviewer was asked to read the code directly — not rely on the README's self-description — and to make concrete calls rather than hedge. Every verdict line is signed with the reviewer's model identifier + date so readers can trace which revision of which model said what.

These reviews exist for two reasons:

1. **Skeptic-ready credibility.** A list of stars or "featured by" logos is low signal. Four independent frontier models asked to do a real code review, each saying on record what they found, is a kind of claim readers can verify.
2. **Real engineering feedback.** Every reviewer surfaced specific push-back — magic constants that should be named, test tooling that should parallelize, drift resilience that should fail loud rather than silently fall back. The consolidated push-back is triaged into issues tagged [`review-feedback`](https://github.com/askalf/dario/issues?q=label%3Areview-feedback).

## Reviews in this directory

| Reviewer | Verdict | File |
|---|---|---|
| Grok 4 | *Production-ready local router with unusually strong engineering and transparency. Adopt if the use-case fits.* | [`grok-4-2026-04-21.md`](./grok-4-2026-04-21.md) |
| Claude Opus 4.7 | *A meaningfully well-engineered piece of reverse-engineered infrastructure; the fingerprint-replay claim is backed by the code.* | [`claude-opus-4-7-2026-04-21.md`](./claude-opus-4-7-2026-04-21.md) |
| Gemini 2.0 Pro | *Technically elite, zero-dependency proxy that successfully bridges the gap between consumer subscriptions and developer tooling through high-fidelity binary emulation.* | [`gemini-2-pro-2026-04-21.md`](./gemini-2-pro-2026-04-21.md) |
| ChatGPT (GPT-5.3) | *A legitimately well-engineered, low-dependency local proxy with precise wire-replay mechanics; trustworthy as a tool.* | [`gpt-5.3-2026-04-21.md`](./gpt-5.3-2026-04-21.md) |

## Prompt used

The exact prompt is in [`PROMPT.md`](./PROMPT.md). It instructs the reviewer to read the README, skim specific source files (`cc-template.ts`, `proxy.ts`, `live-fingerprint.ts`, `pool.ts`), spot-check 1–2 Discussions, and deliver a structured review under a senior-engineer code-review tone — 400–600 words, final verdict line signed with model name + date.

## Methodology notes

- GPT-5.3's first pass declined to fetch the source and wrote the review from priors. That draft has been preserved alongside the revised version (after the reviewer was pushed to actually fetch the listed files) so readers can see the before / after of priors-vs-evidence-backed review on the same subject.
- Gemini 2.0 Pro's review contains minor factual slips (dario version number, credential-store path, exact system-prompt size). These are noted in the file header of that review. Conclusions are unaffected.
- No reviewer had access to the maintainer's commit history or CI runs — only the public README, source tree, Discussions, and npm package metadata.

## Contributing a review

New reviews welcome. Run the prompt in [`PROMPT.md`](./PROMPT.md) against any model that can fetch URLs, save the output as `reviews/<model-id>-<YYYY-MM-DD>.md`, and open a PR. The bar is: concrete calls, a signed verdict line, and at least one piece of pushback the code actually deserves.
