import { ObjectId } from 'mongodb';
import { getDB } from '../config/database.js';
import { env } from '../config/env.js';
import { createAuthHttpError } from '../config/jwt.js';
import { resolveEffectiveSubscriptionPlan } from '../utils/subscription-state.js';
import { OBJECT_ID_HEX_REGEX, buildObjectIdOrStringFilter } from '../utils/validation.js';
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

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toTimestamp(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

async function fetchVendorsForTransactions(vendorIds, db) {
  const uniqueIds = Array.from(new Set(vendorIds.map((id) => String(id)).filter(Boolean)));
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const objectIds = uniqueIds
    .filter((id) => OBJECT_ID_HEX_REGEX.test(id))
    .map((id) => new ObjectId(id));
  const idCandidates = [...objectIds, ...uniqueIds];

  const vendorDocs = await db
    .collection('users')
    .find(
      {
        $or: [{ _id: { $in: idCandidates } }, { id: { $in: uniqueIds } }],
      },
      { projection: SAFE_TRANSACTION_VENDOR_PROJECTION },
    )
    .toArray();

  const vendorMap = new Map();
  for (const vendor of vendorDocs) {
    if (vendor._id) vendorMap.set(String(vendor._id), vendor);
    if (vendor.id) vendorMap.set(String(vendor.id), vendor);
  }
  return vendorMap;
}

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
    if (sortOption === ADMIN_TRANSACTION_SORT_OPTIONS.OLDEST) {
      const diff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
      if (diff !== 0) return diff;
    } else if (sortOption === ADMIN_TRANSACTION_SORT_OPTIONS.AMOUNT_ASC) {
      if (a.amount !== b.amount) return a.amount - b.amount;
    } else if (sortOption === ADMIN_TRANSACTION_SORT_OPTIONS.AMOUNT_DESC) {
      if (a.amount !== b.amount) return b.amount - a.amount;
    }

    const timeDiff = toTimestamp(b.createdAt) - toTimestamp(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
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

  const vendorMap = await fetchVendorsForTransactions(
    docs.map((doc) => doc.vendorId),
    db,
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
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const skip = (safePage - 1) * limit;

  return {
    transactions: sorted.slice(skip, skip + limit),
    counts,
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      hasNextPage: safePage < totalPages,
      hasPrevPage: safePage > 1,
    },
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

  const vendorMap = await fetchVendorsForTransactions([doc.vendorId], db);
  return serializeAdminTransaction(doc, vendorMap.get(String(doc.vendorId ?? '')));
}
