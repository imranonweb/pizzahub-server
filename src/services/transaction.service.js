import { getDB } from '../config/database.js';
import { env } from '../config/env.js';
import { createAuthHttpError } from '../config/jwt.js';
import {
  compareIsoCreatedAtDesc,
  fetchUsersMapByIds,
  paginateArray,
  toIsoOrNull,
} from '../utils/service-helpers.js';
import { resolveEffectiveSubscriptionPlan } from '../utils/subscription-state.js';
import { buildObjectIdOrStringFilter } from '../utils/validation.js';
import { ADMIN_TRANSACTION_SORT_OPTIONS } from '../validators/transaction.validator.js';

export const SAFE_ADMIN_TRANSACTION_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
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

const SAFE_TRANSACTION_VENDOR_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  email: 1,
  businessName: 1,
  subscriptionPlan: 1,
  subscriptionStatus: 1,
  subscriptionExpiresAt: 1,
});

function serializeTransactionVendor(vendorDoc, fallbackVendorId) {
  if (!vendorDoc) {
    return {
      id: fallbackVendorId,
      name: 'Vendor',
      email: '',
      businessName: 'Local Pizzeria',
      subscriptionPlan: 'free',
    };
  }

  const name =
    typeof vendorDoc.name === 'string' && vendorDoc.name.trim()
      ? vendorDoc.name.trim()
      : 'Vendor';
  const businessName =
    typeof vendorDoc.businessName === 'string' && vendorDoc.businessName.trim()
      ? vendorDoc.businessName.trim()
      : name;

  return {
    id: String(vendorDoc._id ?? vendorDoc.id ?? fallbackVendorId),
    name,
    email: typeof vendorDoc.email === 'string' ? vendorDoc.email : '',
    businessName,
    subscriptionPlan: resolveEffectiveSubscriptionPlan(vendorDoc),
  };
}

export function serializeAdminTransaction(doc, vendorDoc) {
  const vendorId = String(doc.vendorId ?? '');
  const amountCents = Number(doc.amount ?? 0);

  return {
    id: String(doc._id ?? doc.id),
    vendorId,
    vendor: serializeTransactionVendor(vendorDoc, vendorId),
    plan: typeof doc.plan === 'string' ? doc.plan : 'premium',
    amount: Number.isFinite(amountCents) ? amountCents : 0,
    amountFormatted: Number.isFinite(amountCents)
      ? Math.round((amountCents / 100) * 100) / 100
      : 0,
    currency: typeof doc.currency === 'string' ? doc.currency : env.stripeCurrency,
    stripeSessionId: typeof doc.stripeSessionId === 'string' ? doc.stripeSessionId : null,
    stripeSubscriptionId:
      typeof doc.stripeSubscriptionId === 'string' ? doc.stripeSubscriptionId : null,
    stripeInvoiceId: typeof doc.stripeInvoiceId === 'string' ? doc.stripeInvoiceId : null,
    eventType: typeof doc.eventType === 'string' ? doc.eventType : null,
    status: typeof doc.status === 'string' ? doc.status : 'unknown',
    createdAt: toIsoOrNull(doc.createdAt),
  };
}

function computeTransactionCounts(transactions) {
  const counts = {
    total: transactions.length,
    paid: 0,
    failed: 0,
    pending: 0,
    cancelled: 0,
    totalRevenueCents: 0,
  };

  for (const tx of transactions) {
    if (tx.status === 'paid') {
      counts.paid += 1;
      counts.totalRevenueCents += tx.amount;
    } else if (tx.status === 'failed') {
      counts.failed += 1;
    } else if (tx.status === 'pending') {
      counts.pending += 1;
    } else if (tx.status === 'cancelled' || tx.status === 'cancelling') {
      counts.cancelled += 1;
    }
  }

  return counts;
}

function sortTransactions(transactions, sortOption) {
  const sorted = [...transactions];
  sorted.sort((a, b) => {
    const aTime = a.createdAt || '';
    const bTime = b.createdAt || '';
    if (sortOption === ADMIN_TRANSACTION_SORT_OPTIONS.OLDEST) {
      if (aTime !== bTime) return aTime < bTime ? -1 : 1;
      return a.id.localeCompare(b.id);
    } else if (sortOption === ADMIN_TRANSACTION_SORT_OPTIONS.AMOUNT_ASC) {
      if (a.amount !== b.amount) return a.amount - b.amount;
    } else if (sortOption === ADMIN_TRANSACTION_SORT_OPTIONS.AMOUNT_DESC) {
      if (a.amount !== b.amount) return b.amount - a.amount;
    }

    return compareIsoCreatedAtDesc(aTime, bTime, a.id, b.id);
  });
  return sorted;
}

export async function listAdminTransactions(
  {
    search = '',
    status = 'all',
    plan = 'all',
    vendorId = '',
    sort = ADMIN_TRANSACTION_SORT_OPTIONS.NEWEST,
    page = 1,
    limit = 20,
  } = {},
  db = getDB(),
) {
  const docs = await db
    .collection('transactions')
    .find({}, { projection: SAFE_ADMIN_TRANSACTION_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  const vendorMap = await fetchUsersMapByIds(
    docs.map((doc) => doc.vendorId),
    db,
    SAFE_TRANSACTION_VENDOR_PROJECTION,
  );

  const allSerialized = docs.map((doc) =>
    serializeAdminTransaction(doc, vendorMap.get(String(doc.vendorId ?? ''))),
  );
  const counts = computeTransactionCounts(allSerialized);

  const normalizedSearch = search.toLowerCase();
  const filtered = allSerialized.filter((tx) => {
    if (status !== 'all' && tx.status !== status) {
      return false;
    }
    if (plan !== 'all' && tx.plan !== plan) {
      return false;
    }
    if (vendorId && tx.vendorId !== vendorId) {
      return false;
    }
    if (normalizedSearch) {
      const haystack = [
        tx.id,
        tx.vendor.businessName,
        tx.vendor.name,
        tx.vendor.email,
        tx.plan,
        tx.status,
        tx.stripeSessionId || '',
        tx.stripeSubscriptionId || '',
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }
    return true;
  });

  const sorted = sortTransactions(filtered, sort);
  const { items: transactions, pagination } = paginateArray(sorted, page, limit);

  return {
    transactions,
    counts,
    pagination,
  };
}

export async function getAdminTransactionById(transactionId, db = getDB()) {
  const doc = await db
    .collection('transactions')
    .findOne(buildObjectIdOrStringFilter(transactionId), {
      projection: SAFE_ADMIN_TRANSACTION_PROJECTION,
    });

  if (!doc) {
    throw createAuthHttpError(404, 'Transaction not found.');
  }

  const vendorMap = await fetchUsersMapByIds(
    [doc.vendorId],
    db,
    SAFE_TRANSACTION_VENDOR_PROJECTION,
  );
  return serializeAdminTransaction(doc, vendorMap.get(String(doc.vendorId ?? '')));
}
