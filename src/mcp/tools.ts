/**
 * MCP tool registry for the dario MCP server (v3.27, direction #4).
 *
 * Each tool wraps an existing dario subsystem that's already covered by
 * its own tests, so these wrappers stay thin — fetch data, format it as
 * text content, return. All tools are read-only. Destructive operations
 * (login/logout, accounts add/remove, backend add/remove, proxy start)
 * are deliberately NOT exposed: an MCP client shouldn't be able to
 * mutate the user's dario state just by being connected, same boundary
 * as the sub-agent prompt (v3.26).
 *
 * `buildToolRegistry` is a factory so tests can inject fake backends for
 * each dario subsystem. In production, `buildDefaultToolRegistry` wires
 * up the real dynamic imports — the imports live inside the factory so
 * `src/mcp/protocol.ts` stays a pure module, decoupled from any of
 * dario's heavier code paths.
 */

import type { McpTool, McpToolResult } from './protocol.js';

/**
 * Injectable data sources for the tool handlers. Production wiring in
 * `buildDefaultToolRegistry` fills these in with the real dario imports;
 * tests can substitute pure synthetic data to avoid touching network /
 * filesystem / OAuth state.
 */
/**
 * Shape returned by the `usage` data source. Mirrors the public subset
 * of /analytics — keeps the MCP tool decoupled from internal Analytics
 * record fields. Single-account mode returns `{ mode: 'single-account' }`
 * with no stats since Analytics only collects in pool mode.
 */
export interface UsageSummary {
  mode: 'pool' | 'single-account';
  reachable: boolean;
  port?: number;
  detail?: string;
  window?: {
    minutes: number;
    requests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgLatencyMs: number;
    errorRate: number;
    subscriptionPercent: number;
    estimatedCost: number;
  };
  perAccount?: Record<string, { requests: number; subscriptionPercent: number }>;
}

export interface ToolDataSources {
  doctor: () => Promise<Array<{ status: string; label: string; detail: string }>>;
  status: () => Promise<{
    authenticated: boolean;
    status: string;
    expiresIn?: string;
    canRefresh?: boolean;
  }>;
  accounts: () => Promise<Array<{ alias: string; expiresAt: number }>>;
  backends: () => Promise<Array<{ name: string; baseUrl: string; model?: string }>>;
  subagent: () => Promise<{
    installed: boolean;
    path: string;
    fileVersion: string | null;
    current: boolean;
    agentsDirExists: boolean;
  }>;
  fingerprint: () => Promise<{
    runtime: string;
    runtimeVersion: string;
    status: string;
    detail: string;
    templateSource: string;
    templateSchema: number | null;
  }>;
  /** Burn-rate / consumption summary; see UsageSummary for the shape. */
  usage: () => Promise<UsageSummary>;
  darioVersion: () => string;
}

function textResult(text: string, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function buildToolRegistry(data: ToolDataSources): McpTool[] {
  const emptyObjectSchema = { type: 'object' as const, properties: {}, required: [] };

  return [
    {
      name: 'doctor',
      description: 'Run dario\'s health-report checks and return the formatted output. Covers: dario version, Node, platform, runtime TLS fingerprint, CC binary + compat, template source + drift, OAuth state, account pool, backends, CC sub-agent install. No side effects.',
      inputSchema: emptyObjectSchema,
      handler: async () => {
        const checks = await data.doctor();
        if (checks.length === 0) return textResult('No checks produced output.');
        const labelWidth = checks.reduce((n, c) => Math.max(n, c.label.length), 0);
        const prefix: Record<string, string> = {
          ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]', info: '[INFO]',
        };
        const lines = checks.map((c) => `${prefix[c.status] ?? '[????]'}  ${c.label.padEnd(labelWidth)}  ${c.detail}`);
        const failed = checks.filter((c) => c.status === 'fail').length;
        const warned = checks.filter((c) => c.status === 'warn').length;
        const summary = `\n\nSummary: ${checks.length} checks — ${failed} fail, ${warned} warn`;
        return textResult(lines.join('\n') + summary);
      },
    },

    {
      name: 'status',
      description: 'Report the dario OAuth authentication status: whether credentials are present, valid, and when they expire. Read-only.',
      inputSchema: emptyObjectSchema,
      handler: async () => {
        const s = await data.status();
        if (!s.authenticated) {
          const detail = s.status === 'none'
            ? 'No credentials — run `dario login`.'
            : s.status === 'expired' && s.canRefresh
              ? 'Credentials expired but refreshable — run `dario refresh` or `dario proxy`.'
              : `Not authenticated (status: ${s.status}).`;
          return textResult(`Authenticated: no\n${detail}`);
        }
        return textResult(`Authenticated: yes\nStatus: ${s.status}\nExpires in: ${s.expiresIn ?? 'unknown'}`);
      },
    },

    {
      name: 'accounts_list',
      description: 'List the accounts configured in dario\'s multi-account pool (~/.dario/accounts/). Returns alias + token expiry per account. Read-only.',
      inputSchema: emptyObjectSchema,
      handler: async () => {
        const accounts = await data.accounts();
        if (accounts.length === 0) {
          return textResult('No pool accounts configured. dario runs in single-account mode from ~/.dario/credentials.json.');
        }
        const now = Date.now();
        const lines = accounts.map((a) => {
          const msLeft = Math.max(0, a.expiresAt - now);
          const hours = Math.floor(msLeft / 3600000);
          const mins = Math.floor((msLeft % 3600000) / 60000);
          const expiry = msLeft > 0 ? `${hours}h ${mins}m` : 'expired';
          return `  ${a.alias.padEnd(20)} token expires in ${expiry}`;
        });
        const note = accounts.length < 2
          ? '\n\nPool mode activates at 2+ accounts — currently single-account.'
          : '';
        return textResult(`${accounts.length} account${accounts.length === 1 ? '' : 's'}:\n${lines.join('\n')}${note}`);
      },
    },

    {
      name: 'backends_list',
      description: 'List configured OpenAI-compat backends (OpenAI, OpenRouter, Groq, LiteLLM, Ollama, etc.). Read-only — does not expose API keys.',
      inputSchema: emptyObjectSchema,
      handler: async () => {
        const backends = await data.backends();
        if (backends.length === 0) {
          return textResult('No OpenAI-compat backends configured. Claude subscription is the only route.');
        }
        const lines = backends.map((b) =>
          `  ${b.name.padEnd(20)} ${b.baseUrl}${b.model ? `  (default model: ${b.model})` : ''}`,
        );
        return textResult(`${backends.length} backend${backends.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
      },
    },

    {
      name: 'subagent_status',
      description: 'Report whether the dario CC sub-agent (~/.claude/agents/dario.md) is installed and whether it matches the running dario version. Read-only.',
      inputSchema: emptyObjectSchema,
      handler: async () => {
        const s = await data.subagent();
        const lines: string[] = [];
        lines.push(`Path: ${s.path}`);
        lines.push(`~/.claude/agents exists: ${s.agentsDirExists ? 'yes' : 'no'}`);
        lines.push(`Installed: ${s.installed ? `yes (v${s.fileVersion ?? 'unknown'})` : 'no'}`);
        if (s.installed && !s.current) {
          lines.push('Note: file version does not match running dario — run `dario subagent install` to refresh.');
        }
        if (!s.installed && s.agentsDirExists) {
          lines.push('Install with: `dario subagent install`.');
        }
        return textResult(lines.join('\n'));
      },
    },

    {
      name: 'fingerprint_info',
      description: 'Report dario\'s runtime / TLS fingerprint state: whether the proxy is running under Bun (matches CC\'s TLS stack) or Node (diverges), which template source is active (live-captured vs bundled), and the template schema version. Read-only.',
      inputSchema: emptyObjectSchema,
      handler: async () => {
        const f = await data.fingerprint();
        const lines: string[] = [];
        lines.push(`Runtime:         ${f.runtime} ${f.runtimeVersion}`);
        lines.push(`TLS status:      ${f.status}`);
        lines.push(`TLS detail:      ${f.detail}`);
        lines.push(`Template source: ${f.templateSource}`);
        lines.push(`Template schema: v${f.templateSchema ?? '?'}`);
        lines.push(`dario version:   ${data.darioVersion()}`);
        return textResult(lines.join('\n'));
      },
    },

    {
      name: 'usage',
      description: 'Burn-rate summary of the running dario proxy\'s traffic over the last 60 minutes: requests, token totals, subscription % vs. extra-usage, per-account rotation if pool mode is on. Read-only — fetches /analytics from the local proxy. Returns a compact text summary; pair with the `dario usage --json` CLI for the full /analytics payload.',
      inputSchema: emptyObjectSchema,
      handler: async () => {
        const u = await data.usage();
        if (!u.reachable) {
          const lines: string[] = [];
          lines.push(`Proxy not reachable on port ${u.port ?? 3456}.`);
          if (u.detail) lines.push(`Detail: ${u.detail}`);
          lines.push('');
          lines.push('`usage` summarizes traffic from a running proxy. Start `dario proxy`, then re-call.');
          lines.push('For a one-off rate-limit snapshot, run `dario doctor --usage` (~1 subscription request).');
          return textResult(lines.join('\n'), true);
        }
        if (u.mode === 'single-account') {
          return textResult([
            'Mode: single-account',
            '',
            'Analytics history is collected only in pool mode (2+ accounts in ~/.dario/accounts/).',
            'For a one-off rate-limit snapshot from Anthropic, run `dario doctor --usage`.',
          ].join('\n'));
        }
        const lines: string[] = [];
        const w = u.window;
        lines.push('Mode:    pool');
        lines.push(`Window:  last ${w?.minutes ?? 60} minutes`);
        lines.push(`Requests:        ${w?.requests ?? 0}`);
        if (w && w.requests > 0) {
          lines.push(`Input tokens:    ${w.totalInputTokens.toLocaleString()}`);
          lines.push(`Output tokens:   ${w.totalOutputTokens.toLocaleString()}`);
          lines.push(`Avg latency:     ${w.avgLatencyMs} ms`);
          if (w.errorRate > 0) lines.push(`Error rate:      ${(w.errorRate * 100).toFixed(1)}%`);
          lines.push(`Subscription %:  ${w.subscriptionPercent}%`);
          if (w.estimatedCost > 0) lines.push(`Est. cost:       $${w.estimatedCost.toFixed(4)} (would-be API cost)`);
        }
        if (u.perAccount && Object.keys(u.perAccount).length > 0) {
          lines.push('');
          lines.push('Per-account:');
          const aliasWidth = Math.max(...Object.keys(u.perAccount).map((a) => a.length));
          for (const [alias, stats] of Object.entries(u.perAccount)) {
            lines.push(`  ${alias.padEnd(aliasWidth)}  ${stats.requests} req${stats.requests === 1 ? '' : 's'}  (${stats.subscriptionPercent}% subscription)`);
          }
        }
        return textResult(lines.join('\n'));
      },
    },
  ];
}

/**
 * Default production wiring — imports dario's real subsystems. Kept out
 * of `buildToolRegistry` so the registry factory stays pure over its
 * data sources (and the unit tests don't pay for dynamic imports).
 */
export async function buildDefaultToolRegistry(): Promise<McpTool[]> {
  const [doctorMod, oauthMod, accountsMod, backendMod, subagentMod, runtimeMod, templateMod, pkgVersion] = await Promise.all([
    import('../doctor.js'),
    import('../oauth.js'),
    import('../accounts.js'),
    import('../openai-backend.js'),
    import('../subagent.js'),
    import('../runtime-fingerprint.js'),
    import('../cc-template.js'),
    readDarioVersion(),
  ]);

  return buildToolRegistry({
    doctor: async () => {
      const checks = await doctorMod.runChecks();
      return checks.map((c: { status: string; label: string; detail: string }) => ({
        status: c.status,
        label: c.label,
        detail: c.detail,
      }));
    },
    status: async () => oauthMod.getStatus(),
    accounts: async () => {
      const loaded = await accountsMod.loadAllAccounts();
      return loaded.map((a: { alias: string; expiresAt: number }) => ({
        alias: a.alias,
        expiresAt: a.expiresAt,
      }));
    },
    backends: async () => {
      const backends = await backendMod.listBackends();
      return backends.map((b: { name: string; baseUrl: string; model?: string }) => ({
        name: b.name,
        baseUrl: b.baseUrl,
        model: b.model,
      }));
    },
    subagent: async () => subagentMod.loadSubagentStatus(),
    fingerprint: async () => {
      const rt = runtimeMod.detectRuntimeFingerprint();
      const tmpl = templateMod.CC_TEMPLATE as { _source?: string; _schemaVersion?: number };
      return {
        runtime: rt.runtime,
        runtimeVersion: rt.runtimeVersion,
        status: rt.status,
        detail: rt.detail,
        templateSource: tmpl._source ?? 'unknown',
        templateSchema: tmpl._schemaVersion ?? null,
      };
    },
    usage: async () => fetchUsage(),
    darioVersion: () => pkgVersion,
  });
}

/**
 * Fetch the local proxy's `/analytics` endpoint and shape it into the
 * MCP-tool surface. Port resolution mirrors `dario usage`:
 * DARIO_USAGE_PORT, then DARIO_PORT (proxy's own default-port env), then
 * 3456. 3-second timeout — we don't block the MCP client on a slow
 * proxy.
 *
 * Failure modes are returned as `{ reachable: false, detail }` rather
 * than thrown, so the tool handler can present a helpful message
 * instead of a generic protocol error.
 */
async function fetchUsage(): Promise<UsageSummary> {
  const port = process.env.DARIO_USAGE_PORT
    ? parseInt(process.env.DARIO_USAGE_PORT, 10)
    : process.env.DARIO_PORT
      ? parseInt(process.env.DARIO_PORT, 10)
      : 3456;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/analytics`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { mode: 'pool', reachable: false, port, detail: `HTTP ${res.status}` };
    }
    const body = await res.json() as Record<string, unknown>;
    if (body.mode === 'single-account') {
      return { mode: 'single-account', reachable: true, port };
    }
    const w = body.window as {
      minutes?: number; requests?: number;
      totalInputTokens?: number; totalOutputTokens?: number;
      avgLatencyMs?: number; errorRate?: number;
      subscriptionPercent?: number; estimatedCost?: number;
    } | undefined;
    return {
      mode: 'pool',
      reachable: true,
      port,
      window: {
        minutes: w?.minutes ?? 60,
        requests: w?.requests ?? 0,
        totalInputTokens: w?.totalInputTokens ?? 0,
        totalOutputTokens: w?.totalOutputTokens ?? 0,
        avgLatencyMs: w?.avgLatencyMs ?? 0,
        errorRate: w?.errorRate ?? 0,
        subscriptionPercent: w?.subscriptionPercent ?? 0,
        estimatedCost: w?.estimatedCost ?? 0,
      },
      perAccount: body.perAccount as Record<string, { requests: number; subscriptionPercent: number }> | undefined,
    };
  } catch (err) {
    return {
      mode: 'pool',
      reachable: false,
      port,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readDarioVersion(): Promise<string> {
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
