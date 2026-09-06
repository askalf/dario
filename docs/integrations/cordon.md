# dario + cordon: share a subscription without leaking PII

dario lets a team share one Claude or ChatGPT subscription through a single API endpoint. That endpoint sees every prompt. Put [cordon](https://github.com/askalf/cordon) in front of it and raw email addresses, phone numbers, card numbers, SSNs and API keys are tokenized **before** they reach dario, the provider, or the provider's logs. The client still gets the real values back in the reply.

```
client ──▶ cordon :8080 ──▶ dario :3456 ──▶ Anthropic / OpenAI
             │ redact / tokenize          │ subscription auth, pool, failover
             └ restore in the reply       └ nothing changes here
```

Both speak the Anthropic and OpenAI wire formats, so nothing about your clients changes except the base URL.

## Compose

```yaml
services:
  dario:
    image: ghcr.io/askalf/dario:latest
    environment:
      DARIO_API_KEY: ${DARIO_API_KEY}     # required, see docker.md
      DARIO_HOST: 0.0.0.0
    volumes:
      - dario_data:/home/dario/.dario
    expose: ["3456"]

  cordon:
    # cordon does not publish an image yet; build it from the repo.
    build: https://github.com/askalf/cordon.git
    environment:
      ANTHROPIC_BASE: http://dario:3456
      OPENAI_BASE: http://dario:3456
      DEFAULT_MODE: reversible           # de-identify upstream, restore in the reply
      FAIL_MODE: closed                  # if cordon cannot redact, it refuses, never forwards raw
      ACTIVE_SETS: pii,pci,secrets       # add phi if you need MRN/date detection
      ADMIN_TOKEN: ${CORDON_ADMIN_TOKEN}
      AUDIT_LOG: /app/data/audit.jsonl
      POLICY_STORE: /app/data/policies.json
    volumes:
      - cordon_data:/app/data
    ports: ["8080:8080"]                 # the only port clients need

volumes:
  dario_data:
  cordon_data:
```

Only cordon is published. dario stays reachable from cordon alone.

## Point clients at cordon

Use the same dario key you already hand out. cordon forwards `x-api-key` and `authorization` verbatim and never terminates auth.

```bash
# Anthropic-compatible clients
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=$DARIO_API_KEY

# OpenAI-compatible clients
export OPENAI_BASE_URL=http://localhost:8080/v1
export OPENAI_API_KEY=$DARIO_API_KEY
```

## What you get

```bash
curl localhost:8080/v1/messages \
  -H "x-api-key: $DARIO_API_KEY" -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5","max_tokens":64,"messages":[{"role":"user",
       "content":"draft a reply to jane@acme.com about card 4012-8888-8888-1881"}]}'
```

| | value |
|---|---|
| the model sees | `draft a reply to <EMAIL_7F3A2B_1> about card <CREDIT_CARD_7F3A2B_1>` |
| the client gets | the reply with `jane@acme.com` and the card number restored |
| response headers | `X-Redacted: 2`, `X-Redacted-Types: EMAIL:1,CREDIT_CARD:1` |
| audit log | counts and types per request, hash-chained, never values |

Streaming works in reversible mode; tokens are restored as they arrive.

## Per-request control

| header | effect |
|---|---|
| `X-Redact-Mode: strip` | irreversible placeholders, nothing restored |
| `X-Redact-Mode: off` | passthrough, still logged as a bypass |
| `X-Redact-Sets: pii,secrets` | narrow the detector set for this call |
| `X-Tenant: <id>` | pick a tenant policy instead of deriving it from the key |

Detection is deterministic (regex plus checksum validators, no ML), so a redaction never silently rewrites prose that isn't PII. Per-tenant policies and the audit chain are documented in the [cordon README](https://github.com/askalf/cordon#per-tenant-policy--admin).

## What this does not do

- It does not hide the prompt from dario's own logs before redaction, because there is nothing before redaction: cordon is the first hop.
- It does not replace provider-side data handling terms. It reduces what those terms apply to.
- `phi` is off by default. Its date detector redacts framework context (version strings, changelog dates) in coding prompts. Turn it on for clinical workloads only.
