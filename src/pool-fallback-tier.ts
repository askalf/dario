/** Backward-compatible selection of a pool-fallback target for one request.
 * A bare value or comma-separated model chain retains the legacy meaning.
 * Tier maps use `tier:model`, e.g. `haiku:gpt-5.4-mini,sonnet:gpt-5.6-terra`.
 * Unknown models use `default`, or the first (normally cheapest) configured tier.
 */
export function selectPoolFallbackModels(spec: string | undefined, requestedModel: string): string[] {
  const entries = (spec ?? '').trim().split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return [];
  const mapped = entries.every((entry) => /^[a-z]+:/i.test(entry));
  if (!mapped) return entries;

  const tiers = new Map<string, string>();
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const tier = entry.slice(0, colon).trim().toLowerCase();
    const model = entry.slice(colon + 1).trim();
    if (tier && model) tiers.set(tier, model);
  }
  const model = requestedModel.toLowerCase();
  const tier = /haiku|mini|small/.test(model) ? 'haiku'
    : /opus|sol|large/.test(model) ? 'opus'
    : /sonnet|terra|medium/.test(model) ? 'sonnet'
    : 'default';
  const target = tiers.get(tier) ?? tiers.get('default') ?? tiers.values().next().value;
  return target ? [target] : [];
}
