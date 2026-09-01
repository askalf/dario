/**
 * Public doctor execution path.
 *
 * The structural collector stays isolated in doctor-core so the opt-in live
 * serving verdict can be applied once, at the boundary shared by the CLI and
 * MCP callers.
 */
export * from './doctor-core.js';

import {
  runChecks as collectChecks,
  type Check,
  type RunChecksOptions,
} from './doctor-core.js';
import { applyServingVerdict } from './doctor-serving.js';
import { getServingProbe } from './serving-probe.js';

/**
 * Collect doctor rows and, when --probe is requested, make the live serving
 * result authoritative over structural OAuth/pool/identity conclusions.
 */
export async function runChecks(opts: RunChecksOptions = {}): Promise<Check[]> {
  const checks = await collectChecks(opts);
  if (!opts.probe) return checks;

  const upstreamApiKey = (process.env.ANTHROPIC_UPSTREAM_API_KEY ?? '').trim();
  const probe = await getServingProbe({
    ...(upstreamApiKey
      ? { upstreamApiKey }
      : {
          getToken: async () => {
            const { getAccessToken } = await import('./oauth.js');
            return getAccessToken();
          },
        }),
  });
  return applyServingVerdict(checks, probe);
}

export { applyServingVerdict } from './doctor-serving.js';
