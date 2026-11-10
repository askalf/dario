# Will my account get suspended?

The most common question about dario, and it deserves a straight answer: **I can't promise you won't be actioned, and I'd be skeptical of anyone who does.** Only Anthropic decides how it enforces its terms. What I can do is lay out exactly how dario works, so you can weigh the risk yourself instead of taking anyone's word for it.

**What dario does:**

- **Runs entirely on your machine.** Your subscription token never touches my servers or anyone else's; requests go straight from your computer to Anthropic.
- **Authenticates as you, with your own Claude login**, the same OAuth credential Claude Code itself uses. It uses no one else's account and shares nothing. It does make each request look like one from Claude Code: the request shape always, and with `--strict-tls` and `--stealth` the TLS handshake and the request timing too.
- **Doesn't modify your account, billing, or subscription settings.**
- **Sends requests in the shape the official client sends them**, rebuilt from your own installed binary, not spoofed from a hardcoded fake.
- **Reports nothing, anywhere.** No telemetry, no analytics, nothing phones home; [verifiable in the source](../README.md#trust--transparency), which is the point of keeping it small enough to audit.

**What dario does that Claude Code doesn't:** it lets tools *other than* Claude Code use that subscription. That's the whole point of it, and it's also the part that sits outside what Anthropic's own client does. Whether that falls within your plan's terms is Anthropic's call, not mine. Read [their terms](https://www.anthropic.com/legal/consumer-terms), read [DISCLAIMER.md](../DISCLAIMER.md), and decide deliberately. dario is a transparency tool, in that it documents request behavior Anthropic doesn't publish for subscribers, and it is also, plainly, routing subscription traffic that Anthropic's own tools bill differently. Both are true; decide with both in view.

**On policy risk specifically:** Anthropic's position on third-party clients has moved before and can move again. dario is built to surface that fast rather than paper over it; see [the billing split](guardrails.md#the-billing-split-a-contingency-dario-is-built-for) for the contingency already in place and the daily canary watching for it.

## Claude Desktop's third-party inference mode

Claude Desktop has a third-party inference mode (Developer → Configure Third-Party Inference → Gateway) that sends Messages API requests to a base URL with a static key. It is built for API keys and gateways, not for subscriptions.

**dario refuses it on a plan login.** Those requests arrive looking like Claude Code's own, so dario would not rebuild them: the app's request, with its own tools and identity headers, would leave on your subscription token. One user who ran Desktop that way on an earlier version reported account action ([#1363](https://github.com/askalf/dario/discussions/1363)). I can't say that pairing is what caused it, and I won't carry it while I can't. dario now answers those requests with a 403 naming this page and sends nothing upstream.

In upstream API-key mode (`ANTHROPIC_UPSTREAM_API_KEY`) the same requests are forwarded, since that is the pairing the mode was built for. I have not tested it.

Ongoing discussion, including other users' experiences: [#724](https://github.com/askalf/dario/discussions/724).

---

[← README](../README.md) · [all reference docs](../README.md#reference)
