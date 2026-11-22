function toIsoOrNull(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const REVOKED_SUBSCRIPTION_STATUSES = new Set([
  'expired',
  'cancelled',
  'canceled',
  'past_due',
  'unpaid',
]);

/**
 * Computes effective subscription entitlement from persisted user fields.
 */
export function resolveEffectiveSubscriptionState(userDoc, { freePlanActiveItemLimit = 3 } = {}) {
  const storedPlan = userDoc?.subscriptionPlan === 'premium' ? 'premium' : 'free';
  const rawStatus =
    typeof userDoc?.subscriptionStatus === 'string'
      ? userDoc.subscriptionStatus.trim().toLowerCase()
      : '';
  const expiresAtIso = toIsoOrNull(userDoc?.subscriptionExpiresAt);
  const expiresAtMs = expiresAtIso ? new Date(expiresAtIso).getTime() : null;
  const isTimeExpired =
    storedPlan === 'premium' && expiresAtMs !== null && expiresAtMs <= Date.now();
  const isStatusRevoked = REVOKED_SUBSCRIPTION_STATUSES.has(rawStatus);
  const isExpired = isTimeExpired || rawStatus === 'expired';
  const effectivePlan =
    storedPlan === 'premium' && !isTimeExpired && !isStatusRevoked ? 'premium' : 'free';

  let status = rawStatus;
  if (!status) {
    status = effectivePlan === 'premium' ? 'active' : isExpired ? 'expired' : 'free';
  } else if (isTimeExpired) {
    status = 'expired';
  }

  return {
    plan: effectivePlan,
    storedPlan,
    status,
    cancelAtPeriodEnd: userDoc?.cancelAtPeriodEnd === true && effectivePlan === 'premium',
    subscriptionExpiresAt: expiresAtIso,
    isExpired,
    hasBillingCustomer: Boolean(userDoc?.stripeCustomerId),
    activeItemLimit: effectivePlan === 'premium' ? null : freePlanActiveItemLimit,
  };
}

/**
 * Returns the effective vendor plan ('free' | 'premium') respecting expiration and revoked states.
 */
export function resolveEffectiveSubscriptionPlan(userDoc) {
  return resolveEffectiveSubscriptionState(userDoc).plan;
}
