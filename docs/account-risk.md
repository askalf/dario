# Will my account get suspended?

The most common question about dario, and it deserves a straight answer: **I can't promise you won't be actioned, and I'd be skeptical of anyone who does.** Only Anthropic decides how it enforces its terms. What I can do is lay out exactly how dario works, so you can weigh the risk yourself instead of taking anyone's word for it.

**What dario does:**

- **Runs entirely on your machine.** Your subscription token never touches my servers or anyone else's; requests go straight from your computer to Anthropic.
- **Authenticates as you, with your own Claude login**, the same OAuth credential Claude Code itself uses. It impersonates nobody and shares nothing.
- **Doesn't modify your account, billing, or subscription settings.**
- **Sends requests in the shape the official client sends them**, rebuilt from your own installed binary, not spoofed from a hardcoded fake.
- **Reports nothing, anywhere.** No telemetry, no analytics, nothing phones home; [verifiable in the source](../README.md#trust--transparency), which is the point of keeping it auditable in a weekend.

**What dario does that Claude Code doesn't:** it lets tools *other than* Claude Code use that subscription. That's the whole point of it, and it's also the part that sits outside what Anthropic's own client does. Whether that falls within your plan's terms is Anthropic's call, not mine. Read [their terms](https://www.anthropic.com/legal/consumer-terms), read [DISCLAIMER.md](../DISCLAIMER.md), and decide deliberately. dario is a transparency tool, in that it documents request behavior Anthropic doesn't publish for subscribers, and it is also, plainly, routing subscription traffic that Anthropic's own tools bill differently. Both are true; decide with both in view.

**On policy risk specifically:** Anthropic's position on third-party clients has moved before and can move again. dario is built to surface that fast rather than paper over it; see [the billing split](guardrails.md#the-billing-split-a-contingency-dario-is-built-for) for the contingency already in place and the daily canary watching for it.

Ongoing discussion, including other users' experiences: [#724](https://github.com/askalf/dario/discussions/724).

---

[← README](../README.md) · [all reference docs](../README.md#reference)
