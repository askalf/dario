export type UpstreamRejectionClass = 'billing' | 'rate_limit' | 'credential' | 'other';

export interface UpstreamRejection {
  class: UpstreamRejectionClass;
  marker: 'billing_required' | 'rate_limited' | 'credential_rejected' | 'upstream_rejected';
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
  if (status === 401 || normalized.includes('authentication_error') || normalized.includes('invalid_grant')) {
    return { class: 'credential', marker: 'credential_rejected' };
  }
  return { class: 'other', marker: 'upstream_rejected' };
}

/** Operator action paired with the failure class. Never suggest credential churn for billing. */
export function rejectionRemediation(rejection: UpstreamRejection): string {
  switch (rejection.class) {
    case 'billing':
      return 'The subscription or payment method needs operator attention. Restarting, re-transplanting credentials, logging in again, or removing the pool account will not help.';
    case 'rate_limit':
      return 'The quota window self-clears; wait for the upstream reset window, then retry.';
    case 'credential':
      return 'The credential was rejected; follow the OAuth re-authentication runbook.';
    default:
      return 'Upstream rejected the request for an unclassified reason; inspect the bounded diagnostic before changing credentials.';
  }
}

/** Stable reason string for health, doctor, and workflow consumers. */
export function rejectionReason(rejection: UpstreamRejection): string {
  if (rejection.class === 'billing') return 'billing-required';
  if (rejection.class === 'rate_limit') return 'rate-limited';
  if (rejection.class === 'credential') return 'auth-rejected';
  return 'upstream-rejected';
}

/** Bounded diagnostic text; callers must apply their standard secret redactor first. */
export function diagnosticSnippet(body: string, maxLength = 500): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
