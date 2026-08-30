/**
 * Shadow compare (v6.0.0) — run one prompt past a second model family and keep
 * both answers, without the client ever knowing.
 *
 * WHY THIS SHAPE. Once dario can serve either wire shape from either
 * subscription, the obvious question stops being "can I reach GPT" and becomes
 * "which of these two is actually better at MY work". Answering that from
 * benchmarks is close to worthless; answering it from your own real traffic is
 * not. So a compare is triggered per-request by a header, on prompts you were
 * sending anyway.
 *
 * THE CLIENT IS NEVER AFFECTED. The primary answer streams through untouched
 * and the comparison runs beside it — the request is not held open for it, and
 * a compare that fails, times out, or has nowhere to go is dropped silently
 * with the record still written. A diagnostic that can degrade the thing it is
 * measuring is worse than no diagnostic.
 *
 * BOTH SIDES ARE RECORDED IN THE CLIENT'S OWN WIRE SHAPE. The comparison is
 * dispatched through the same forwardToCodex translation the real path uses, so
 * an Anthropic-shape request yields two Anthropic-shape answers. Comparing a
 * Messages response against a raw Responses payload would mean eyeballing
 * across two formats and calling the difference a model difference.
 *
 * Raw payloads are stored rather than extracted text: extraction is exactly
 * where a subtle bug would quietly make two answers look more alike than they
 * are, and this release was written off the back of five failures that read as
 * successes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';

import { forwardToCodex, getCodexModelSlugs, isCodexModel } from './codex-backend.js';
import { hasAnyCodexAccount, selectCodexAccount, getFreshCodexAccount } from './codex-accounts.js';

/** Request header that arms a comparison: `x-dario-compare: <model>`. */
export const COMPARE_HEADER = 'x-dario-compare';

/** Response header naming the model a comparison was run against. */
export const COMPARE_RESULT_HEADER = 'x-dario-compared-with';

export const COMPARE_DIR = join(homedir(), '.dario', 'compare');

export interface CompareSide {
  status: number | null;
  /** The response payload exactly as written — SSE text or a JSON body. */
  body: string;
  ms: number;
}

export interface CompareRecord {
  ts: string;
  path: string;
  shape: 'openai' | 'anthropic';
  streaming: boolean;
  primaryModel: string;
  comparedModel: string;
  /** The client's request body, verbatim, so a record replays on its own. */
  request: unknown;
  primary: CompareSide;
  compare: CompareSide | null;
  /** Why there is no compare side, when there isn't one. */
  skipped?: string;
}

/**
 * Read the compare target from request headers. Returns null when unarmed, and
 * for the empty value, so `-H 'x-dario-compare:'` reliably means "off" rather
 * than "compare against a model named empty string".
 */
export function readCompareTarget(headers: Record<string, unknown>): string | null {
  const raw = headers[COMPARE_HEADER] ?? headers[COMPARE_HEADER.toUpperCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

/**
 * Swap the model in a JSON request body. Returns null when the body is not
 * JSON — the caller then skips the comparison rather than sending something it
 * could not read.
 */
export function withModel(body: Buffer, model: string): Buffer | null {
  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    // A comparison is always non-streaming: nobody is watching it arrive, and a
    // single JSON body is far easier to diff later than two SSE transcripts.
    return Buffer.from(JSON.stringify({ ...parsed, model, stream: false }));
  } catch {
    return null;
  }
}

/**
 * Tee everything written to a real response into a buffer, leaving delivery
 * completely unchanged. `captured()` is meaningful once the response finishes.
 */
export function teeResponse(res: ServerResponse): { captured: () => CompareSide } {
  const started = Date.now();
  const chunks: string[] = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string') chunks.push(chunk);
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk.toString('utf-8'));
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof res.write;

  res.end = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string') chunks.push(chunk);
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk.toString('utf-8'));
    return (origEnd as (...a: unknown[]) => ServerResponse)(chunk, ...rest);
  }) as typeof res.end;

  return {
    captured: () => ({
      status: res.statusCode ?? null,
      body: chunks.join(''),
      ms: Date.now() - started,
    }),
  };
}

/**
 * A ServerResponse stand-in that keeps what was written instead of sending it.
 * The comparison has no socket of its own — it is answering nobody.
 */
function captureSink(): { sink: ServerResponse; side: () => CompareSide } {
  const started = Date.now();
  const state = { status: null as number | null, chunks: [] as string[], headersSent: false };
  const sink = {
    statusCode: 0,
    headersSent: false,
    writeHead(code: number) { state.status = code; state.headersSent = true; this.headersSent = true; return this; },
    setHeader() { return this; },
    write(s: unknown) { if (s !== undefined && s !== null) state.chunks.push(String(s)); return true; },
    end(s?: unknown) { if (s !== undefined && s !== null) state.chunks.push(String(s)); return this; },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  };
  return {
    sink: sink as unknown as ServerResponse,
    side: () => ({
      status: state.status,
      body: state.chunks.join(''),
      ms: Date.now() - started,
    }),
  };
}

/**
 * Run the comparison against the ChatGPT subscription.
 *
 * Resolves to a reason-for-skipping string when it declines, never throwing:
 * the caller is on the success path of a request it has already answered, and
 * a diagnostic must not be able to take that down.
 *
 * v6.0.0 compares against a Codex account only. Comparing against the Claude
 * pool would mean occupying a seat for a request nobody is waiting on, which is
 * a trade worth making deliberately rather than by default.
 */
export async function runCompare(opts: {
  body: Buffer;
  shape: 'openai' | 'anthropic';
  targetModel: string;
  corsOrigin: string;
  timeoutMs: number;
  verbose: boolean;
}): Promise<{ side: CompareSide | null; skipped?: string }> {
  try {
    if (!(await hasAnyCodexAccount())) return { side: null, skipped: 'no Codex account configured' };
    const stored = await selectCodexAccount();
    if (!stored) return { side: null, skipped: 'no Codex account configured' };

    const creds = await getFreshCodexAccount(stored);
    const slugs = await getCodexModelSlugs(creds).catch(() => [] as string[]);
    if (!isCodexModel(opts.targetModel, slugs)) {
      return { side: null, skipped: `${opts.targetModel} is not served by Codex account ${creds.alias}` };
    }

    const body = withModel(opts.body, opts.targetModel);
    if (!body) return { side: null, skipped: 'request body is not JSON' };

    const { sink, side } = captureSink();
    await forwardToCodex(
      {} as never, sink, body, creds, opts.corsOrigin, {},
      opts.timeoutMs, opts.verbose, opts.shape,
    );
    return { side: side() };
  } catch (err) {
    return { side: null, skipped: `compare failed: ${(err as Error).message}` };
  }
}

/**
 * Persist one record. Returns the path written, or null on failure — a compare
 * log that cannot be written is not worth failing a served request over.
 */
export function writeCompareRecord(record: CompareRecord, dir: string = COMPARE_DIR): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = record.ts.replace(/[:.]/g, '-');
    // Separators out, then dot-runs collapsed. Stripping separators alone
    // already prevents traversal, but leaving `..` in a filename invites the
    // next reader to assume it was never considered.
    const safeModel = record.comparedModel.replace(/[^\w.-]/g, '_').replace(/\.{2,}/g, '.');
    const path = join(dir, `${stamp}-${safeModel}.json`);
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
    return path;
  } catch {
    return null;
  }
}
