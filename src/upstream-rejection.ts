export type UpstreamRejectionClass = 'billing' | 'rate_limit' | 'other';

export interface UpstreamRejection {
  class: UpstreamRejectionClass;
  marker: 'billing_required' | 'rate_limited' | 'upstream_rejected';
}

/** Classify subscription entitlement failures separately from temporary quota exhaustion. */
export function classifyUpstreamRejection(status: number, body: string): UpstreamRejection {
  const normalized = body.toLowerCase();
  const billing = status === 402
    || normalized.includes('payment_required')
    || normalized.includes('credit balance')
    || normalized.includes('plans & billing')
    || (status === 403 && normalized.includes('oauth_not_allowed_for_organization'));
  if (billing) return { class: 'billing', marker: 'billing_required' };
  if (status === 429) return { class: 'rate_limit', marker: 'rate_limited' };
  return { class: 'other', marker: 'upstream_rejected' };
}

/** Bounded diagnostic text; callers must apply their standard secret redactor first. */
export function diagnosticSnippet(body: string, maxLength = 500): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
