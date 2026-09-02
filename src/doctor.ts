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
import { getServingProbe, type ProbeResult } from './serving-probe.js';

interface DoctorDependencies {
  collect: (opts: RunChecksOptions) => Promise<Check[]>;
  probe: () => Promise<ProbeResult>;
}

async function productionProbe(): Promise<ProbeResult> {
  const upstreamApiKey = (process.env.ANTHROPIC_UPSTREAM_API_KEY ?? '').trim();
  return getServingProbe({
    ...(upstreamApiKey
      ? { upstreamApiKey }
      : {
          getToken: async () => {
            const { getAccessToken } = await import('./oauth.js');
            return getAccessToken();
          },
        }),
  });
}

/**
 * Collect doctor rows and, when --probe is requested, make the live serving
 * result authoritative over structural OAuth/pool/identity conclusions.
 */
export async function runDoctorChecks(
  opts: RunChecksOptions = {},
  dependencies: DoctorDependencies = { collect: collectChecks, probe: productionProbe },
): Promise<Check[]> {
  const checks = await dependencies.collect(opts);
  if (!opts.probe) return checks;

  const probe = await dependencies.probe();
  return applyServingVerdict(checks, probe);
}

/** Production entry point shared by the CLI and MCP callers. */
export async function runChecks(opts: RunChecksOptions = {}): Promise<Check[]> {
  return runDoctorChecks(opts);
}

export { applyServingVerdict } from './doctor-serving.js';
