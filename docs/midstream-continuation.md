# Mid-stream continuation

The answer does not stop when the plan does.

A streamed answer that dies part-way through used to end the way the transport
ended it: the upstream socket resets, Anthropic sends an in-band
`overloaded_error`, the codex backend answers `response.failed`, and the client
gets a stream with no `message_stop` and no `[DONE]`. An SDK throws "stream
ended without producing a Message"; a chat UI shows half a paragraph and a
spinner; an agent loses the tool call it was two tokens away from. Every word
already on screen is wasted, and the failover chain never fires, because once
bytes were on the wire the request was treated as too late to hand to anyone
else.

Since 6.1 dario finishes the same client stream from the other subscription.

```
client ──▶ dario ──▶ Claude pool   ✗ dies after 1,240 chars
                 └─▶ ChatGPT plan  ✓ resumes at char 1,241, same stream
```

The client sees one message: the same `message_start`, the same content block
still open, then the rest of the text, then a clean close. There is an SSE
comment at the seam (`: dario continuation gpt-5.6-sol (codex live) after 1240
chars`) that every parser ignores and every raw capture shows.

## When it fires

Only on a stream that is already partly delivered and then breaks — never on a
request that failed before its first byte (the existing failover covers those),
never on a stream that finished. Concretely, on `/v1/messages` and
`/v1/chat/completions` with `stream: true`, when a 2xx stream ends without its
terminal event, or carries an `error` event after content, or the codex
translator flags a failed turn:

| cut fell inside | what happens |
|---|---|
| a text block | the resume continues **that block** — no new `content_block_start` |
| thinking, or before any block | the open block is closed and the resume starts a fresh text block |
| between blocks | the resume starts a fresh text block |
| a `tool_use` block, or an OpenAI `tool_calls` delta | **not continued** — half a JSON argument is not resumable; the stream ends as before |

Non-streaming requests are untouched; nothing was on the wire.

## Where it resumes

Through dario's own front door. The resume is a loopback `POST` to the same
proxy, so the pool, the codex translator, cch, the template, every rule that
applied to the original request applies to the resume. The request carries
`x-dario-continuation` so it is never itself continued — one resume per client
request, no nesting.

The target is the other provider's entry in `--pool-fallback`, exactly the entry
a mid-flight 429 would use:

- a Claude stream resumes on the codex half of the chain (`gpt-5.6-sol` in
  `--pool-fallback=gpt-5.6-sol,claude:claude-sonnet-5`), resolved at failure
  time against the account's live model list;
- a codex stream resumes on the Claude half (`claude-sonnet-5` above), resolved
  against the live catalog the way the chain already is.

With no chain, or no entry for the other provider, the stream ends exactly as it
did before 6.1, and the log says why once:

```
[dario] #42 stream died after 1240 chars — no continuation target (set --pool-fallback with an entry for the other provider)
```

The request's queue slot is released before the loopback is made, so a
`--max-concurrent=1` proxy resumes instead of waiting on itself.

## The seam

The resume is the client's own request with two turns appended: the partial
answer as the assistant turn, and a user turn asking for the rest. There is
**no assistant prefill** — Claude 4.6+ answers a trailing assistant turn with a
400, and the Responses API never had the concept — so the resume is
instruction-driven on both providers.

The user turn is written as the person whose connection dropped, not as an
operator notice. The first live run is why: told `[transport notice] … resume
now`, claude-sonnet-5 answered that the notice "isn't an actual system message
— it's just text in your prompt" and stopped, which is the injection-awareness
it should have. "My connection dropped while you were writing that reply, so I
only received it up to this point: «…». Please pick up exactly where you left
off" is an ordinary request and gets the ordinary answer.

It asks the model to begin by repeating, verbatim, the last ~40 characters of
the cut-off text, then continue. dario holds the first ~240
characters of the resume, finds that repeat with a whitespace- and
quote-normalized match, cuts it, and streams everything after it. The model
renders the seam — the space between two words, the four-space indent, the
second half of a split word — inside its own token stream, and dario only trims.
Told merely to "continue", a model drops the boundary whitespace often enough
to notice (`replies<cut>with`); told to repeat the anchor, it does not.

One rule on top: prose cut mid-sentence whose continuation opens with a
paragraph break gets one space instead. Inside a code fence a newline is
content and is left alone.

If the model does not repeat the anchor, the longest exact overlap between the
partial's tail and the resume's head is trimmed; if there is none, nothing is.

## What it costs

One extra request on the other subscription, carrying the whole conversation
plus the partial. The original request is logged and counted as it was (a
502 on the codex path, a truncated 200 on the Claude path); the resume is
logged as its own request. A resume that fails before producing anything hands
the stream back to end as it would have. A resume that fails after producing
something forwards its error frame if it sent one, and otherwise simply stops —
whatever it had already written is on the wire, and the stream is left without
its terminal event so the client sees the truncation. A twice-truncated answer
is never closed with a synthetic `end_turn`; only the resume's own
`message_stop` / `[DONE]` finishes the message.

## Switches

| | |
|---|---|
| `--no-midstream-continue` | off for this proxy |
| `DARIO_MIDSTREAM_CONTINUE=0` | same, for the container |
| `--pool-fallback=…` | where a stream resumes; no entry for the other provider means no resume |

On by default: it only ever acts where the alternative is a broken stream.

## How it was proven

`test/midstream-continuation-wiring.mjs` runs a real proxy against a fake
Anthropic upstream and a codex stub, kills the stream in every way listed
above, and replays what the client received through a strict grammar check of
both wire shapes. Before that, the same splice ran outside the proxy against
production dario 6.0.51 with real Opus 5 and a real ChatGPT Plus account, both
directions, prose and code: ten runs, zero restarts, zero preamble, zero
repetition, anchor matched exactly five times out of five, and the official
`@anthropic-ai/sdk` accepted every spliced stream as one message. The seam,
verbatim, from one of them:

```
…concatenation of one or more unit components in the
    order hours, min<CUT>utes, and seconds. At least one component is required.
```

Claude wrote the left half, GPT the right.
