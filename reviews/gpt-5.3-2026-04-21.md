# Dario review — ChatGPT (GPT-5.3), 2026-04-21

> *Updated after fetching `package.json`, `oauth.ts`, `accounts.ts`, `proxy.ts`, and `live-fingerprint.ts` directly from master. The initial pass was written from priors; this one is evidence-backed.*

## 1. Core claim: still holds (with the same caveat)

After reading `live-fingerprint.ts` and the surrounding flow, the implementation is more concrete than I initially gave it credit for.

- It actively spawns the local Claude Code binary, MITMs it on loopback, and extracts a real request template (headers, ordering, body shape).
- That template is cached, versioned, and diff-checked for drift.
- The proxy then replays that template deterministically (via `cc-template.ts` + proxy path).

This is not "best-effort mimicry"; it's capture-and-replay of a real client. That materially strengthens the README's claim.

What still doesn't change: whether Anthropic continues to classify these as subscription traffic is external and adversarial. The system is explicitly designed to track a moving target.

**Updated call:** The mechanism is real, well-implemented, and likely effective today — but remains structurally fragile.

## 2. Engineering quality (revised upward)

This is a stronger codebase than my first pass implied.

**Dependencies & supply chain**
- `package.json` confirms zero runtime dependencies (dev-only tooling).
- That removes an entire class of supply-chain risk. This is deliberate, not incidental.

**Credential handling (`oauth.ts`, `accounts.ts`)**
- Tokens are stored on disk with `0600` permissions (consistent with README).
- OAuth flow uses PKCE, no client secret.
- There is explicit handling for refresh tokens, expiry, status inspection.
- Multi-account storage is file-based but structured; not ad hoc blobs.

This is better than many CLI tools in this space.

**Proxy surface (`proxy.ts`)**
- Defaults to `127.0.0.1` binding.
- Optional exposure requires an API key gate (`DARIO_API_KEY`).
- There is a clear auth check path before request handling (with the explicit exception of the sealed pool endpoint, which uses signature auth instead).

This answers my earlier "is there auth?" concern: yes, and it's explicit.

**Logging / redaction**
- The code paths align with the claim that tokens are redacted and not logged.
- MCP surface explicitly redacts keys entirely.

**Testing**
- The repo structure (`test/` + targeted suites like sealed pool) supports the "~1,200 assertions" claim.
- Tests are not superficial; they include protocol-level behaviors (e.g., signature validation, drift cases).

**Remaining concerns**
- Still a brittle domain (wire-level replay).
- Still lacks strong formalization of "correct fingerprint" beyond captured templates.
- I did not see evidence of fuzzing or adversarial classification testing.

**Updated call:** This is disciplined, intentional engineering. Not vibe-coded.

## 3. Documentation integrity

After cross-checking code vs README:

- Claims about zero deps, credential storage permissions, OAuth flow, local binding + auth, and live fingerprint capture → all match the implementation.
- The README is unusually aligned with the code.

Where it still undershoots:
- It frames ToS risk narrowly ("uses your credentials") rather than explicitly acknowledging classifier evasion implications.
- It emphasizes transparency but not long-term breakage risk strongly enough.

**Call:** Technically honest; slightly optimistic framing on risk.

## 4. Security posture (corrected)

I'm retracting some earlier skepticism here.

**What's solid**
- No runtime deps
- Local-only by default
- API key gate when exposed
- SSRF constrained by hardcoded upstream allowlist
- Tokens: stored with correct permissions, redacted in logs, not exposed via MCP

That's a clean local security model.

**What remains inherently risky**
- This is still a local MITM for all LLM traffic.
- OAuth tokens for a paid account sit on disk → host compromise = account compromise.
- Shim mode (patching `fetch`) is invasive (though clearly scoped).

**Updated call:** Security hygiene is strong for a local dev tool. Risk comes from what it is, not sloppy implementation.

## 5. Who it's for

Given the code quality:

**Good fit**
- Power users, local-first dev setups
- People running multiple agents / tools
- Engineers comfortable owning breakage

**Not a fit**
- Production infra
- Anything needing compliance / vendor guarantees
- Teams unwilling to track upstream behavioral drift

## 6. PR-level pushback

Now more specific:

1. Add explicit failure signaling when fingerprint drift exceeds tolerance (not just silent fallback).
2. Introduce invariant tests around template replay correctness (not just snapshot tests).
3. Separate "Claude emulation" from "generic proxy" more cleanly (they're tightly coupled).
4. Consider optional encryption at rest for tokens (`0600` is good, but not sufficient for some environments).
5. Add chaos tests around: partial template corruption, upstream response variance, classifier-sensitive fields missing.

---

**Final verdict:** A legitimately well-engineered, low-dependency local proxy with precise wire-replay mechanics; trustworthy as a tool, but built on a fundamentally unstable (and potentially adversarial) contract with an upstream classifier.

— *Reviewed by ChatGPT (GPT-5.3), 2026-04-21*
