# Review prompt

The exact prompt used for the four reviews in this directory. Identical text given to each reviewer so the results are comparable.

---

Please do a thorough, skeptical review of this open-source project as if you were a senior engineer evaluating it for adoption. The repo is **dario** at https://github.com/askalf/dario.

**Context.** dario is a local LLM router that turns a Claude Max / Pro subscription into a local Claude API by replaying the Claude Code wire fingerprint. It also unifies OpenAI / Groq / OpenRouter / Ollama / any OpenAI-compat URL behind one localhost endpoint. npm: `@askalf/dario`.

**What I'm asking you to do:**

1. Read the README in full — especially *What it actually does*, *Why you'll install this*, *Fingerprint axes*, *Multi-account pool mode*, *Shim mode*, *Trust and transparency*, and the FAQ.
2. Skim the source at https://github.com/askalf/dario/tree/master/src — specifically `cc-template.ts`, `proxy.ts`, `live-fingerprint.ts`, `pool.ts`. You don't need to trace every path, just enough to confirm the README's technical claims track the code.
3. Spot-check one or two Discussions: [#13 (detection signals)](https://github.com/askalf/dario/discussions/13), [#14 (Template Replay)](https://github.com/askalf/dario/discussions/14), [#39 (burn-rate causes)](https://github.com/askalf/dario/discussions/39), or [#1 (rate-limit headers)](https://github.com/askalf/dario/discussions/1).

4. Write a review that honestly addresses each of:
   - **Does the core claim hold?** dario replays Claude Code's exact wire shape so a Claude Max / Pro subscription bills against the plan instead of API overage. Is that coherent? Evidence in the code?
   - **Engineering quality.** Serious project or vibe-coded? Test coverage, separation of concerns, credential handling, dependency hygiene, failure modes.
   - **Documentation integrity.** Do the README and Discussions state things accurately, overclaim, or underclaim?
   - **Security posture.** Anything concerning in OAuth token handling, API key storage, or the local proxy surface?
   - **Who it's for.** Given what you saw, who should install this and who shouldn't?
   - **What would you push back on if you were reviewing a PR from this team?**

**Length:** 400–600 words. **Tone:** senior engineer in a code review, not marketing. If it deserves praise, praise it specifically. If it has weaknesses, name them. Don't hedge everything — make actual calls.

End your review with a one-line verdict, signed with your model name (e.g. *"— Reviewed by Grok 4, 2026-04-21"*) so I can quote it.

---

## If your tool refuses the first URL fetch

If your web-fetch tool returns 403/blocked/cache-only data on `github.com/askalf/dario`, fetch these raw URLs directly instead:

- https://raw.githubusercontent.com/askalf/dario/master/README.md
- https://raw.githubusercontent.com/askalf/dario/master/package.json
- https://raw.githubusercontent.com/askalf/dario/master/src/cc-template.ts
- https://raw.githubusercontent.com/askalf/dario/master/src/live-fingerprint.ts
- https://raw.githubusercontent.com/askalf/dario/master/src/pool.ts
- https://raw.githubusercontent.com/askalf/dario/master/src/proxy.ts
- https://raw.githubusercontent.com/askalf/dario/master/src/oauth.ts
- https://raw.githubusercontent.com/askalf/dario/master/src/accounts.ts

The `raw.githubusercontent.com` host returns file content directly without HTML cache layers and without CF challenges. If the github.com rendering shows you a version number that seems older than the one on npm (`@askalf/dario` should be 3.30.x+), you're hitting cached HTML — switch to the raw URLs above and start the review over from the live file content.
