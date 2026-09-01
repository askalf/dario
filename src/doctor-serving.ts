import type { Check } from './doctor.js';
import type { ProbeResult } from './serving-probe.js';

/**
 * Apply the authoritative can-it-serve verdict to doctor's structural rows.
 * Token freshness remains visible, but cannot stay green when the probe failed.
 */
export function applyServingVerdict(checks: readonly Check[], probe: ProbeResult): Check[] {
  if (probe.ok) {
    return [{ status: 'ok', label: 'Serving', detail: 'seat served the synthetic probe' }, ...checks];
  }
  const detail = `${probe.reason}: ${probe.detail ?? 'the seat cannot serve a request'}`;
  const structural = new Set(['OAuth', 'Pool', 'Pool routing', 'Identity']);
  return [
    { status: 'fail', label: 'Serving', detail },
    ...checks.map((check) => structural.has(check.label)
      ? { ...check, status: 'fail' as const, detail: `${check.detail}; NOT SERVING (${probe.reason})` }
      : check),
  ];
}
