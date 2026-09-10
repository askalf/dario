/** Backward-compatible selection of a pool-fallback target for one request.
 * A bare value or comma-separated model chain retains the legacy meaning.
 * Tier maps use `tier:model`, e.g. `haiku:gpt-5.6-luna,sonnet:gpt-5.6-terra`.
 * Unknown models use `default`, or the first (normally cheapest) configured tier.
 *
 * The Codex rungs are named for a size ladder — `sol` (sun) > `terra` (earth) >
 * `luna` (moon) — which is why the tier tests below read model NAMES rather
 * than any stated capability: the backend publishes a routable set and no tier
 * metadata, so the ladder is the only signal there is. `luna` was added when
 * codex-drift-watch reported the account-visible list as `gpt-5.5`,
 * `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-reserve` (dario#1272);
 * `gpt-5.4-mini`, the previous example here, is no longer on that list.
 */
export function selectPoolFallbackModels(spec: string | undefined, requestedModel: string): string[] {
  const entries = (spec ?? '').trim().split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return [];
  const mapped = entries.every((entry) => /^(haiku|sonnet|opus|default):/i.test(entry));
  if (!mapped) return entries;

  const tiers = new Map<string, string>();
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const tier = entry.slice(0, colon).trim().toLowerCase();
    const model = entry.slice(colon + 1).trim();
    if (tier && model) tiers.set(tier, model);
  }
  const model = requestedModel.toLowerCase();
  const tier = /haiku|mini|small|luna/.test(model) ? 'haiku'
    : /opus|sol|large/.test(model) ? 'opus'
    : /sonnet|terra|medium/.test(model) ? 'sonnet'
    : 'default';
  const target = tiers.get(tier) ?? tiers.get('default') ?? tiers.values().next().value;
  return target ? [target] : [];
}
