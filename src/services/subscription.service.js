import { ObjectId } from 'mongodb';
import { getDB } from '../config/database.js';
import { env } from '../config/env.js';
import { createAuthHttpError } from '../config/jwt.js';
import { getStripeClient } from '../config/stripe.js';
import { FREE_PLAN_ACTIVE_ITEM_LIMIT } from '../validators/menu.validator.js';
import { safeNotify } from './notification.service.js';

const OBJECT_ID_HEX_REGEX = /^[a-f\d]{24}$/i;

const SAFE_USER_SUBSCRIPTION_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  email: 1,
  businessName: 1,
  role: 1,
  subscriptionPlan: 1,
  subscriptionStatus: 1,
  subscriptionExpiresAt: 1,
  cancelAtPeriodEnd: 1,
  stripeCustomerId: 1,
  stripeSubscriptionId: 1,
  subscriptionLastEventAt: 1,
});

const SAFE_TRANSACTION_PROJECTION = Object.freeze({
  _id: 1,
  vendorId: 1,
  plan: 1,
  amount: 1,
  currency: 1,
  stripeSessionId: 1,
  stripeSubscriptionId: 1,
  stripeInvoiceId: 1,
  eventType: 1,
  status: 1,
  createdAt: 1,
});

function buildIdCandidates(rawId) {
  const value = String(rawId);
  if (OBJECT_ID_HEX_REGEX.test(value)) {
    return [new ObjectId(value), value];
  }
  return [value];
}

function buildObjectIdOrStringFilter(rawId) {
  if (OBJECT_ID_HEX_REGEX.test(rawId)) {
    return {
      $or: [{ _id: new ObjectId(rawId) }, { _id: rawId }, { id: rawId }],
    };
  }
  return {
    $or: [{ _id: rawId }, { id: rawId }],
  };
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function extractSubscriptionPeriodEnd(subscription) {
  const raw =
    subscription?.current_period_end ??
    subscription?.items?.data?.[0]?.current_period_end ??
    null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return new Date(raw * 1000);
  }
  return null;
}

function extractInvoiceSubscriptionId(invoice) {
  if (typeof invoice?.subscription === 'string') {
    return invoice.subscription;
  }
  if (typeof invoice?.subscription?.id === 'string') {
    return invoice.subscription.id;
  }
  const parentSub = invoice?.parent?.subscription_details?.subscription;
  if (typeof parentSub === 'string') {
    return parentSub;
  }
  if (typeof parentSub?.id === 'string') {
    return parentSub.id;
  }
  return null;
}

function extractInvoicePeriodEnd(invoice) {
  const lineEnd = invoice?.lines?.data?.[0]?.period?.end;
  if (typeof lineEnd === 'number' && Number.isFinite(lineEnd) && lineEnd > 0) {
    return new Date(lineEnd * 1000);
  }
  return null;
}

function isStandaloneTransactionError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    error?.code === 20 ||
    /Transaction numbers are only allowed on a replica set|does not support transactions/i.test(
      message,
    )
  );
}

export function resolveEffectiveSubscriptionState(userDoc) {
  const storedPlan = userDoc?.subscriptionPlan === 'premium' ? 'premium' : 'free';
  const expiresAtIso = toIsoOrNull(userDoc?.subscriptionExpiresAt);
  const expiresAtMs = expiresAtIso ? new Date(expiresAtIso).getTime() : null;
  const isExpired =
    (storedPlan === 'premium' && expiresAtMs !== null && expiresAtMs <= Date.now()) ||
    userDoc?.subscriptionStatus === 'expired';
  const effectivePlan = storedPlan === 'premium' && !isExpired ? 'premium' : 'free';

  let status = typeof userDoc?.subscriptionStatus === 'string' ? userDoc.subscriptionStatus : '';
  if (!status) {
    status = effectivePlan === 'premium' ? 'active' : isExpired ? 'expired' : 'free';
  } else if (isExpired) {
    status = 'expired';
  }

  return {
    plan: effectivePlan,
    storedPlan,
    status,
    cancelAtPeriodEnd: userDoc?.cancelAtPeriodEnd === true && !isExpired,
    subscriptionExpiresAt: expiresAtIso,
    isExpired,
    hasBillingCustomer: Boolean(userDoc?.stripeCustomerId),
    activeItemLimit: effectivePlan === 'premium' ? null : FREE_PLAN_ACTIVE_ITEM_LIMIT,
  };
}

export function getAvailableSubscriptionPlans() {
  return [
    {
      id: 'free',
      name: 'Free Kitchen Plan',
      priceCents: 0,
      price: 0,
      currency: env.stripeCurrency,
      interval: null,
      activeItemLimit: FREE_PLAN_ACTIVE_ITEM_LIMIT,
      features: [
        `Up to ${FREE_PLAN_ACTIVE_ITEM_LIMIT} active menu items`,
        'Standard listing placement',
        'Order management dashboard',
      ],
    },
    {
      id: 'premium',
      name: 'PizzaHub Premium Plan',
      priceCents: env.stripePremiumPriceCents,
      price: Math.round((env.stripePremiumPriceCents / 100) * 100) / 100,
      currency: env.stripeCurrency,
      interval: 'month',
      activeItemLimit: null,
      features: [
        'Unlimited active menu items',
        'Verified Premium vendor badge',
        'Featured placement on public menu',
      ],
    },
  ];
}

function serializeTransaction(doc) {
  return {
    id: String(doc._id ?? doc.id),
    vendorId: String(doc.vendorId ?? ''),
    plan: typeof doc.plan === 'string' ? doc.plan : 'premium',
    amount: Number(doc.amount ?? 0),
    currency: typeof doc.currency === 'string' ? doc.currency : env.stripeCurrency,
    stripeSessionId: typeof doc.stripeSessionId === 'string' ? doc.stripeSessionId : null,
    stripeSubscriptionId:
      typeof doc.stripeSubscriptionId === 'string' ? doc.stripeSubscriptionId : null,
    status: typeof doc.status === 'string' ? doc.status : 'unknown',
    createdAt: toIsoOrNull(doc.createdAt),
  };
}

export async function reconcileExpiredVendorSubscription(vendorDoc, db = getDB()) {
  if (!vendorDoc) {
    return vendorDoc;
  }

  const state = resolveEffectiveSubscriptionState(vendorDoc);
  if (!state.isExpired || vendorDoc.subscriptionPlan !== 'premium') {
    return vendorDoc;
  }

  const vendorId = String(vendorDoc._id ?? vendorDoc.id);
  const now = new Date();
  const updatedDoc = await db.collection('users').findOneAndUpdate(
    {
      $and: [buildObjectIdOrStringFilter(vendorId), { subscriptionPlan: 'premium' }],
    },
    {
      $set: {
        subscriptionPlan: 'free',
        subscriptionStatus: 'expired',
        cancelAtPeriodEnd: false,
        updatedAt: now,
      },
    },
    { returnDocument: 'after', projection: SAFE_USER_SUBSCRIPTION_PROJECTION },
  );

  await safeNotify(
    {
      userId: vendorId,
      role: 'vendor',
      type: 'subscription_status',
      title: 'Premium Subscription Expired',
      message:
        'Your Premium subscription period ended and your account has reverted to the Free plan (3 active items max).',
      relatedResourceId: vendorDoc.stripeSubscriptionId || vendorId,
      link: '/dashboard/vendor/subscription',
      metadata: { subscriptionPlan: 'free', status: 'expired' },
      eventKey: `sub:expired:${vendorId}:${state.subscriptionExpiresAt}`,
    },
    db,
  );

  return updatedDoc ?? {
    ...vendorDoc,
    subscriptionPlan: 'free',
    subscriptionStatus: 'expired',
    cancelAtPeriodEnd: false,
  };
}

export async function getVendorSubscriptionSummary(vendorId, db = getDB()) {
  let vendorDoc = await db
    .collection('users')
    .findOne(buildObjectIdOrStringFilter(vendorId), {
      projection: SAFE_USER_SUBSCRIPTION_PROJECTION,
    });

  if (!vendorDoc) {
    throw createAuthHttpError(404, 'Vendor account not found.');
  }

  vendorDoc = await reconcileExpiredVendorSubscription(vendorDoc, db);

  const vendorCandidates = buildIdCandidates(vendorId);
  const txDocs = await db
    .collection('transactions')
    .find({ vendorId: { $in: vendorCandidates } }, { projection: SAFE_TRANSACTION_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .limit(10)
    .toArray();

  return {
    subscription: resolveEffectiveSubscriptionState(vendorDoc),
    recentTransactions: txDocs.map(serializeTransaction),
    plans: getAvailableSubscriptionPlans(),
  };
}

export async function createVendorCheckoutSession(
  { vendorId, plan, successUrl, cancelUrl },
  { db = getDB(), stripeClient } = {},
) {
  let vendorDoc = await db
    .collection('users')
    .findOne(buildObjectIdOrStringFilter(vendorId), {
      projection: SAFE_USER_SUBSCRIPTION_PROJECTION,
    });

  if (!vendorDoc) {
    throw createAuthHttpError(404, 'Vendor account not found.');
  }

  vendorDoc = await reconcileExpiredVendorSubscription(vendorDoc, db);
  const currentState = resolveEffectiveSubscriptionState(vendorDoc);

  if (currentState.plan === 'premium' && !currentState.cancelAtPeriodEnd) {
    throw createAuthHttpError(409, 'You already have an active Premium subscription.');
  }

  const stripe = stripeClient ?? getStripeClient();

  let stripeCustomerId =
    typeof vendorDoc.stripeCustomerId === 'string' && vendorDoc.stripeCustomerId
      ? vendorDoc.stripeCustomerId
      : null;

  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: vendorDoc.email || undefined,
      name: vendorDoc.businessName || vendorDoc.name || undefined,
      metadata: {
        vendorId: String(vendorId),
      },
    });
    stripeCustomerId = customer.id;

    await db.collection('users').updateOne(buildObjectIdOrStringFilter(vendorId), {
      $set: {
        stripeCustomerId,
        updatedAt: new Date(),
      },
    });
  }

  const lineItem = env.stripePremiumPriceId
    ? { price: env.stripePremiumPriceId, quantity: 1 }
    : {
        price_data: {
          currency: env.stripeCurrency,
          unit_amount: env.stripePremiumPriceCents,
          recurring: { interval: 'month' },
          product_data: {
            name: 'PizzaHub Premium Kitchen Subscription',
            description: 'Unlimited active menu items and featured placement on PizzaHub.',
          },
        },
        quantity: 1,
      };

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    client_reference_id: String(vendorId),
    line_items: [lineItem],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      vendorId: String(vendorId),
      plan,
    },
    subscription_data: {
      metadata: {
        vendorId: String(vendorId),
        plan,
      },
    },
  });

  return {
    sessionId: session.id,
    checkoutUrl: session.url,
  };
}

export async function createVendorPortalSession(
  { vendorId, returnUrl },
  { db = getDB(), stripeClient } = {},
) {
  const vendorDoc = await db
    .collection('users')
    .findOne(buildObjectIdOrStringFilter(vendorId), {
      projection: SAFE_USER_SUBSCRIPTION_PROJECTION,
    });

  if (!vendorDoc) {
    throw createAuthHttpError(404, 'Vendor account not found.');
  }

  if (!vendorDoc.stripeCustomerId) {
    throw createAuthHttpError(
      400,
      'No billing account exists yet. Upgrade to Premium first to manage billing.',
    );
  }

  const stripe = stripeClient ?? getStripeClient();
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: vendorDoc.stripeCustomerId,
    return_url: returnUrl,
  });

  return {
    url: portalSession.url,
  };
}

async function resolveVendorForWebhook(eventObject, db) {
  const candidateVendorId =
    eventObject?.metadata?.vendorId ||
    eventObject?.client_reference_id ||
    eventObject?.subscription_details?.metadata?.vendorId ||
    eventObject?.parent?.subscription_details?.metadata?.vendorId ||
    null;

  if (typeof candidateVendorId === 'string' && candidateVendorId.trim()) {
    const byId = await db
      .collection('users')
      .findOne(buildObjectIdOrStringFilter(candidateVendorId.trim()), {
        projection: SAFE_USER_SUBSCRIPTION_PROJECTION,
      });
    if (byId) {
      return byId;
    }
  }

  const customerId =
    typeof eventObject?.customer === 'string'
      ? eventObject.customer
      : eventObject?.customer?.id ?? null;

  if (customerId) {
    const byCustomer = await db.collection('users').findOne(
      { stripeCustomerId: customerId },
      { projection: SAFE_USER_SUBSCRIPTION_PROJECTION },
    );
    if (byCustomer) {
      return byCustomer;
    }
  }

  const subscriptionId =
    typeof eventObject?.id === 'string' && eventObject.object === 'subscription'
      ? eventObject.id
      : extractInvoiceSubscriptionId(eventObject);

  if (subscriptionId) {
    return db.collection('users').findOne(
      { stripeSubscriptionId: subscriptionId },
      { projection: SAFE_USER_SUBSCRIPTION_PROJECTION },
    );
  }

  return null;
}

async function persistWebhookUpdates({ vendorFilter, userSet, txDoc }, db) {
  const applyWrites = async (session) => {
    const opts = session ? { session } : undefined;
    if (userSet) {
      await db.collection('users').updateOne(vendorFilter, { $set: userSet }, opts);
    }
    if (txDoc) {
      await db.collection('transactions').insertOne(txDoc, opts);
    }
  };

  if (typeof db.client?.startSession === 'function') {
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await applyWrites(session);
      });
      return;
    } catch (error) {
      if (!isStandaloneTransactionError(error)) {
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }

  await applyWrites(undefined);
}

export async function processStripeWebhookEvent(event, { db = getDB() } = {}) {
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') {
    throw createAuthHttpError(400, 'Invalid Stripe event payload.');
  }

  const existingEventTx = await db.collection('transactions').findOne(
    { stripeEventId: event.id },
    { projection: { _id: 1, stripeEventId: 1 } },
  );

  if (existingEventTx) {
    return {
      received: true,
      duplicate: true,
      eventId: event.id,
    };
  }

  const supportedTypes = new Set([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'invoice.payment_succeeded',
    'invoice.payment_failed',
  ]);

  if (!supportedTypes.has(event.type)) {
    return {
      received: true,
      ignored: true,
      eventId: event.id,
      type: event.type,
    };
  }

  const eventObject = event.data?.object ?? {};
  const vendorDoc = await resolveVendorForWebhook(eventObject, db);

  if (!vendorDoc) {
    console.warn(`[StripeWebhook] Unable to resolve vendor for event ${event.id} (${event.type})`);
    return {
      received: true,
      ignored: true,
      eventId: event.id,
      reason: 'Vendor not found',
    };
  }

  const vendorIdStr = String(vendorDoc._id ?? vendorDoc.id);
  const storedVendorId = OBJECT_ID_HEX_REGEX.test(vendorIdStr)
    ? new ObjectId(vendorIdStr)
    : vendorIdStr;
  const vendorFilter = buildObjectIdOrStringFilter(vendorIdStr);

  const now = new Date();
  const eventCreatedAt =
    typeof event.created === 'number' && Number.isFinite(event.created)
      ? event.created
      : Math.floor(now.getTime() / 1000);
  const isStaleEvent =
    typeof vendorDoc.subscriptionLastEventAt === 'number' &&
    eventCreatedAt < vendorDoc.subscriptionLastEventAt;

  let userSet = null;
  let txDoc = null;
  let notification = null;

  if (event.type === 'checkout.session.completed') {
    const isPaid =
      eventObject.payment_status === 'paid' ||
      eventObject.payment_status === 'no_payment_required';
    const subId =
      typeof eventObject.subscription === 'string'
        ? eventObject.subscription
        : eventObject.subscription?.id ?? null;
    const customerId =
      typeof eventObject.customer === 'string'
        ? eventObject.customer
        : eventObject.customer?.id ?? vendorDoc.stripeCustomerId ?? null;

    if (!isStaleEvent && isPaid) {
      const existingExpiry =
        vendorDoc.subscriptionExpiresAt &&
        new Date(vendorDoc.subscriptionExpiresAt).getTime() > now.getTime()
          ? new Date(vendorDoc.subscriptionExpiresAt)
          : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      userSet = {
        subscriptionPlan: 'premium',
        subscriptionStatus: 'active',
        cancelAtPeriodEnd: false,
        subscriptionExpiresAt: existingExpiry,
        ...(customerId ? { stripeCustomerId: customerId } : {}),
        ...(subId ? { stripeSubscriptionId: subId } : {}),
        subscriptionLastEventAt: eventCreatedAt,
        updatedAt: now,
      };
    }

    txDoc = {
      vendorId: storedVendorId,
      plan: 'premium',
      amount:
        typeof eventObject.amount_total === 'number'
          ? eventObject.amount_total
          : env.stripePremiumPriceCents,
      currency:
        typeof eventObject.currency === 'string'
          ? eventObject.currency.toLowerCase()
          : env.stripeCurrency,
      stripeSessionId: eventObject.id ?? null,
      stripeSubscriptionId: subId,
      stripeEventId: event.id,
      eventType: event.type,
      status: isPaid ? 'paid' : 'pending',
      createdAt: now,
    };

    if (isPaid && !isStaleEvent) {
      notification = {
        userId: vendorIdStr,
        role: 'vendor',
        type: 'subscription_status',
        title: 'Premium Subscription Activated',
        message:
          'Your PizzaHub Premium subscription is now active with unlimited menu listings.',
        relatedResourceId: subId || eventObject.id || vendorIdStr,
        link: '/dashboard/vendor/subscription',
        metadata: { subscriptionPlan: 'premium', status: 'active' },
        eventKey: `sub:activated:${event.id}`,
      };
    }
  } else if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated'
  ) {
    const subStatus = typeof eventObject.status === 'string' ? eventObject.status : 'active';
    const periodEnd = extractSubscriptionPeriodEnd(eventObject);
    const cancelAtPeriodEnd = eventObject.cancel_at_period_end === true;
    const isEntitledStatus = subStatus === 'active' || subStatus === 'trialing';
    const isNotExpired = !periodEnd || periodEnd.getTime() > now.getTime();
    const nextPlan = isEntitledStatus && isNotExpired ? 'premium' : 'free';
    const nextStatus =
      nextPlan === 'premium'
        ? cancelAtPeriodEnd
          ? 'cancelling'
          : 'active'
        : subStatus === 'canceled'
          ? 'cancelled'
          : subStatus;

    if (!isStaleEvent) {
      userSet = {
        subscriptionPlan: nextPlan,
        subscriptionStatus: nextStatus,
        cancelAtPeriodEnd: nextPlan === 'premium' && cancelAtPeriodEnd,
        ...(periodEnd ? { subscriptionExpiresAt: periodEnd } : {}),
        ...(eventObject.customer ? { stripeCustomerId: String(eventObject.customer) } : {}),
        ...(eventObject.id ? { stripeSubscriptionId: String(eventObject.id) } : {}),
        subscriptionLastEventAt: eventCreatedAt,
        updatedAt: now,
      };
    }

    txDoc = {
      vendorId: storedVendorId,
      plan: nextPlan,
      amount: 0,
      currency: env.stripeCurrency,
      stripeSessionId: null,
      stripeSubscriptionId: eventObject.id ?? null,
      stripeEventId: event.id,
      eventType: event.type,
      status: nextStatus,
      createdAt: now,
    };

    if (!isStaleEvent && cancelAtPeriodEnd && nextPlan === 'premium') {
      notification = {
        userId: vendorIdStr,
        role: 'vendor',
        type: 'subscription_status',
        title: 'Subscription Cancellation Scheduled',
        message:
          'Your Premium subscription will remain active until the end of your current billing period.',
        relatedResourceId: eventObject.id || vendorIdStr,
        link: '/dashboard/vendor/subscription',
        metadata: { subscriptionPlan: 'premium', status: 'cancelling' },
        eventKey: `sub:cancelling:${event.id}`,
      };
    }
  } else if (event.type === 'customer.subscription.deleted') {
    if (!isStaleEvent) {
      userSet = {
        subscriptionPlan: 'free',
        subscriptionStatus: 'cancelled',
        cancelAtPeriodEnd: false,
        subscriptionExpiresAt: now,
        subscriptionLastEventAt: eventCreatedAt,
        updatedAt: now,
      };
    }

    txDoc = {
      vendorId: storedVendorId,
      plan: 'free',
      amount: 0,
      currency: env.stripeCurrency,
      stripeSessionId: null,
      stripeSubscriptionId: eventObject.id ?? null,
      stripeEventId: event.id,
      eventType: event.type,
      status: 'cancelled',
      createdAt: now,
    };

    if (!isStaleEvent) {
      notification = {
        userId: vendorIdStr,
        role: 'vendor',
        type: 'subscription_status',
        title: 'Premium Subscription Cancelled',
        message:
          'Your Premium subscription has been cancelled. Your account is now on the Free plan.',
        relatedResourceId: eventObject.id || vendorIdStr,
        link: '/dashboard/vendor/subscription',
        metadata: { subscriptionPlan: 'free', status: 'cancelled' },
        eventKey: `sub:cancelled:${event.id}`,
      };
    }
  } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    const subId = extractInvoiceSubscriptionId(eventObject);
    const periodEnd = extractInvoicePeriodEnd(eventObject);

    if (!isStaleEvent) {
      userSet = {
        subscriptionPlan: 'premium',
        subscriptionStatus: 'active',
        cancelAtPeriodEnd: false,
        ...(periodEnd ? { subscriptionExpiresAt: periodEnd } : {}),
        ...(subId ? { stripeSubscriptionId: subId } : {}),
        subscriptionLastEventAt: eventCreatedAt,
        updatedAt: now,
      };
    }

    txDoc = {
      vendorId: storedVendorId,
      plan: 'premium',
      amount:
        typeof eventObject.amount_paid === 'number'
          ? eventObject.amount_paid
          : env.stripePremiumPriceCents,
      currency:
        typeof eventObject.currency === 'string'
          ? eventObject.currency.toLowerCase()
          : env.stripeCurrency,
      stripeSessionId: null,
      stripeSubscriptionId: subId,
      stripeInvoiceId: eventObject.id ?? null,
      stripeEventId: event.id,
      eventType: event.type,
      status: 'paid',
      createdAt: now,
    };

    if (!isStaleEvent) {
      notification = {
        userId: vendorIdStr,
        role: 'vendor',
        type: 'subscription_status',
        title: 'Subscription Payment Confirmed',
        message: 'Your monthly PizzaHub Premium payment succeeded.',
        relatedResourceId: subId || eventObject.id || vendorIdStr,
        link: '/dashboard/vendor/subscription',
        metadata: { subscriptionPlan: 'premium', status: 'paid' },
        eventKey: `sub:paid:${event.id}`,
      };
    }
  } else if (event.type === 'invoice.payment_failed') {
    const subId = extractInvoiceSubscriptionId(eventObject);

    if (!isStaleEvent) {
      userSet = {
        subscriptionPlan: 'free',
        subscriptionStatus: 'past_due',
        subscriptionLastEventAt: eventCreatedAt,
        updatedAt: now,
      };
    }

    txDoc = {
      vendorId: storedVendorId,
      plan: 'premium',
      amount:
        typeof eventObject.amount_due === 'number'
          ? eventObject.amount_due
          : env.stripePremiumPriceCents,
      currency:
        typeof eventObject.currency === 'string'
          ? eventObject.currency.toLowerCase()
          : env.stripeCurrency,
      stripeSessionId: null,
      stripeSubscriptionId: subId,
      stripeInvoiceId: eventObject.id ?? null,
      stripeEventId: event.id,
      eventType: event.type,
      status: 'failed',
      createdAt: now,
    };

    if (!isStaleEvent) {
      notification = {
        userId: vendorIdStr,
        role: 'vendor',
        type: 'subscription_status',
        title: 'Subscription Payment Failed',
        message:
          'We could not process your Premium subscription payment. Please update your payment method.',
        relatedResourceId: subId || eventObject.id || vendorIdStr,
        link: '/dashboard/vendor/subscription',
        metadata: { subscriptionPlan: 'free', status: 'failed' },
        eventKey: `sub:failed:${event.id}`,
      };
    }
  }

  try {
    await persistWebhookUpdates({ vendorFilter, userSet, txDoc }, db);
  } catch (error) {
    if (error?.code === 11000) {
      return {
        received: true,
        duplicate: true,
        eventId: event.id,
      };
    }
    throw error;
  }

  if (notification) {
    await safeNotify(notification, db);
  }

  return {
    received: true,
    duplicate: false,
    staleIgnored: isStaleEvent,
    eventId: event.id,
    type: event.type,
  };
}
