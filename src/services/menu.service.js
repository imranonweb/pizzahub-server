import { ObjectId } from 'mongodb';
import { getDB } from '../config/database.js';
import { createAuthHttpError } from '../config/jwt.js';
import {
  ADMIN_MENU_SORT_OPTIONS,
  FREE_PLAN_ACTIVE_ITEM_LIMIT,
  MENU_SORT_OPTIONS,
  VENDOR_MENU_SORT_OPTIONS,
} from '../validators/menu.validator.js';

const OBJECT_ID_HEX_REGEX = /^[a-f\d]{24}$/i;
const VALID_MENU_STATUSES = new Set(['pending', 'approved', 'rejected', 'inactive']);

export const SAFE_PUBLIC_MENU_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  vendorId: 1,
  itemName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  status: 1,
  createdAt: 1,
});

export const SAFE_VENDOR_MENU_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  vendorId: 1,
  itemName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  status: 1,
  rejectionReason: 1,
  createdAt: 1,
  updatedAt: 1,
});

export const SAFE_ADMIN_MENU_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  vendorId: 1,
  itemName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  status: 1,
  rejectionReason: 1,
  approvedAt: 1,
  approvedBy: 1,
  rejectedAt: 1,
  rejectedBy: 1,
  createdAt: 1,
  updatedAt: 1,
});

export const SAFE_PUBLIC_VENDOR_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  businessName: 1,
  subscriptionPlan: 1,
  subscriptionExpiresAt: 1,
  isBlocked: 1,
});

export const SAFE_ADMIN_VENDOR_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  email: 1,
  businessName: 1,
  subscriptionPlan: 1,
  subscriptionExpiresAt: 1,
});

const vendorActivationQueues = new Map();

async function withVendorActivationLock(vendorId, task) {
  const key = String(vendorId);
  const previous = vendorActivationQueues.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  vendorActivationQueues.set(key, chained);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (vendorActivationQueues.get(key) === chained) {
      vendorActivationQueues.delete(key);
    }
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function buildVendorIdCandidates(vendorId) {
  const raw = String(vendorId);
  if (OBJECT_ID_HEX_REGEX.test(raw)) {
    return [new ObjectId(raw), raw];
  }
  return [raw];
}

function toIsoString(value) {
  if (!value) {
    return new Date(0).toISOString();
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function normalizeImages(rawImages) {
  return Array.from(
    new Set(
      Array.isArray(rawImages)
        ? rawImages.filter((img) => typeof img === 'string' && img.trim().length > 0)
        : typeof rawImages === 'string' && rawImages.trim().length > 0
          ? [rawImages.trim()]
          : [],
    ),
  );
}

function resolveEffectiveSubscriptionPlan(vendorDoc) {
  if (vendorDoc?.subscriptionPlan !== 'premium') {
    return 'free';
  }
  if (!vendorDoc.subscriptionExpiresAt) {
    return 'premium';
  }
  const expiresAt =
    vendorDoc.subscriptionExpiresAt instanceof Date
      ? vendorDoc.subscriptionExpiresAt
      : new Date(vendorDoc.subscriptionExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return 'premium';
  }
  return expiresAt.getTime() > Date.now() ? 'premium' : 'free';
}

function serializePublicVendor(vendorDoc, fallbackVendorId) {
  if (!vendorDoc) {
    return {
      id: fallbackVendorId,
      name: 'Local Kitchen',
      businessName: 'Local Pizzeria',
      subscriptionPlan: 'free',
    };
  }

  const name =
    typeof vendorDoc.name === 'string' && vendorDoc.name.trim()
      ? vendorDoc.name.trim()
      : 'Local Kitchen';

  const businessName =
    typeof vendorDoc.businessName === 'string' && vendorDoc.businessName.trim()
      ? vendorDoc.businessName.trim()
      : name;

  return {
    id: String(vendorDoc._id ?? vendorDoc.id ?? fallbackVendorId),
    name,
    businessName,
    subscriptionPlan: resolveEffectiveSubscriptionPlan(vendorDoc),
  };
}

export function serializePublicMenuItem(doc, vendorDoc) {
  const vendorId = String(doc.vendorId ?? '');

  return {
    id: String(doc._id ?? doc.id),
    vendorId,
    itemName: typeof doc.itemName === 'string' ? doc.itemName : '',
    category: typeof doc.category === 'string' ? doc.category : '',
    description: typeof doc.description === 'string' ? doc.description : '',
    price: typeof doc.price === 'number' ? doc.price : Number(doc.price ?? 0),
    location: typeof doc.location === 'string' ? doc.location : '',
    images: normalizeImages(doc.images),
    status: 'approved',
    createdAt: toIsoString(doc.createdAt),
    vendor: serializePublicVendor(vendorDoc, vendorId),
  };
}

export function serializeVendorMenuItem(doc) {
  const rawStatus = typeof doc.status === 'string' ? doc.status.trim().toLowerCase() : 'pending';
  const status = VALID_MENU_STATUSES.has(rawStatus) ? rawStatus : 'pending';

  return {
    id: String(doc._id ?? doc.id),
    vendorId: String(doc.vendorId ?? ''),
    itemName: typeof doc.itemName === 'string' ? doc.itemName : '',
    category: typeof doc.category === 'string' ? doc.category : '',
    description: typeof doc.description === 'string' ? doc.description : '',
    price: typeof doc.price === 'number' ? doc.price : Number(doc.price ?? 0),
    location: typeof doc.location === 'string' ? doc.location : '',
    images: normalizeImages(doc.images),
    status,
    rejectionReason:
      typeof doc.rejectionReason === 'string' && doc.rejectionReason.trim()
        ? doc.rejectionReason.trim()
        : null,
    createdAt: toIsoString(doc.createdAt),
    updatedAt: doc.updatedAt ? toIsoString(doc.updatedAt) : null,
  };
}

function computeVendorMenuStats(items) {
  const stats = {
    total: items.length,
    active: 0,
    pending: 0,
    rejected: 0,
    inactive: 0,
  };

  for (const item of items) {
    if (item.status === 'approved') stats.active += 1;
    else if (item.status === 'pending') stats.pending += 1;
    else if (item.status === 'rejected') stats.rejected += 1;
    else if (item.status === 'inactive') stats.inactive += 1;
  }

  return stats;
}

async function fetchVendorsByIds(vendorIds, db, projection = SAFE_PUBLIC_VENDOR_PROJECTION) {
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
      { projection },
    )
    .toArray();

  const vendorMap = new Map();
  for (const vendor of vendorDocs) {
    if (vendor._id) {
      vendorMap.set(String(vendor._id), vendor);
    }
    if (vendor.id) {
      vendorMap.set(String(vendor.id), vendor);
    }
  }

  return vendorMap;
}

function sortPublicItems(items, sortOption) {
  const sorted = [...items];

  sorted.sort((a, b) => {
    if (sortOption === MENU_SORT_OPTIONS.PRICE_ASC) {
      if (a.price !== b.price) {
        return a.price - b.price;
      }
    } else if (sortOption === MENU_SORT_OPTIONS.PRICE_DESC) {
      if (a.price !== b.price) {
        return b.price - a.price;
      }
    } else if (sortOption === MENU_SORT_OPTIONS.FEATURED) {
      const aPremium = a.vendor.subscriptionPlan === 'premium' ? 1 : 0;
      const bPremium = b.vendor.subscriptionPlan === 'premium' ? 1 : 0;
      if (aPremium !== bPremium) {
        return bPremium - aPremium;
      }
    }

    const timeDiff = toTimestamp(b.createdAt) - toTimestamp(a.createdAt);
    if (timeDiff !== 0) {
      return timeDiff;
    }

    return b.id.localeCompare(a.id);
  });

  return sorted;
}

export async function listPublicMenuItems(
  { search, category, location, sort, page, limit },
  db = getDB(),
) {
  const menuCollection = db.collection('menuItems');
  const filter = { status: 'approved' };

  if (search) {
    filter.itemName = new RegExp(escapeRegex(search), 'i');
  }

  if (category) {
    filter.category = new RegExp(`^${escapeRegex(category)}$`, 'i');
  }

  if (location) {
    filter.location = new RegExp(escapeRegex(location), 'i');
  }

  const [matchingDocs, approvedLocationDocs] = await Promise.all([
    menuCollection.find(filter, { projection: SAFE_PUBLIC_MENU_PROJECTION }).toArray(),
    menuCollection
      .find({ status: 'approved' }, { projection: { location: 1, vendorId: 1 } })
      .toArray(),
  ]);

  const allVendorIds = [
    ...matchingDocs.map((doc) => doc.vendorId),
    ...approvedLocationDocs.map((doc) => doc.vendorId),
  ];
  const vendorMap = await fetchVendorsByIds(allVendorIds, db);

  const visibleItems = matchingDocs
    .filter((doc) => {
      const vendor = vendorMap.get(String(doc.vendorId ?? ''));
      return vendor?.isBlocked !== true;
    })
    .map((doc) => serializePublicMenuItem(doc, vendorMap.get(String(doc.vendorId ?? ''))));

  const sortedItems = sortPublicItems(visibleItems, sort);

  const total = sortedItems.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const skip = (safePage - 1) * limit;
  const paginatedItems = sortedItems.slice(skip, skip + limit);

  const locations = Array.from(
    new Set(
      approvedLocationDocs
        .filter((doc) => {
          const vendor = vendorMap.get(String(doc.vendorId ?? ''));
          return vendor?.isBlocked !== true;
        })
        .map((doc) => (typeof doc.location === 'string' ? doc.location.trim() : ''))
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return {
    items: paginatedItems,
    locations,
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

export async function getPublicMenuItemById(itemId, db = getDB()) {
  const idFilter = buildObjectIdOrStringFilter(itemId);
  const doc = await db.collection('menuItems').findOne(
    {
      $and: [idFilter, { status: 'approved' }],
    },
    { projection: SAFE_PUBLIC_MENU_PROJECTION },
  );

  if (!doc) {
    throw createAuthHttpError(404, 'Menu item not found.');
  }

  const vendorMap = await fetchVendorsByIds([doc.vendorId], db);
  const vendorDoc = vendorMap.get(String(doc.vendorId ?? ''));

  if (vendorDoc?.isBlocked === true) {
    throw createAuthHttpError(404, 'Menu item not found.');
  }

  return serializePublicMenuItem(doc, vendorDoc);
}

async function getOwnedMenuItemOrThrow(itemId, vendorId, db) {
  const vendorCandidates = buildVendorIdCandidates(vendorId);
  const doc = await db.collection('menuItems').findOne(
    {
      $and: [buildObjectIdOrStringFilter(itemId), { vendorId: { $in: vendorCandidates } }],
    },
    { projection: SAFE_VENDOR_MENU_PROJECTION },
  );

  if (!doc) {
    throw createAuthHttpError(404, 'Menu item not found.');
  }

  return doc;
}

function sortVendorItems(items, sortOption) {
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (sortOption === VENDOR_MENU_SORT_OPTIONS.PRICE_ASC) {
      if (a.price !== b.price) return a.price - b.price;
    } else if (sortOption === VENDOR_MENU_SORT_OPTIONS.PRICE_DESC) {
      if (a.price !== b.price) return b.price - a.price;
    } else if (sortOption === VENDOR_MENU_SORT_OPTIONS.NAME_ASC) {
      const cmp = a.itemName.localeCompare(b.itemName);
      if (cmp !== 0) return cmp;
    }

    const timeDiff = toTimestamp(b.createdAt) - toTimestamp(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
  });
  return sorted;
}

export async function listVendorMenuItems(
  vendorId,
  { search = '', category = '', status = 'all', sort = VENDOR_MENU_SORT_OPTIONS.NEWEST, page = 1, limit = 50 } = {},
  db = getDB(),
) {
  const vendorCandidates = buildVendorIdCandidates(vendorId);
  const docs = await db
    .collection('menuItems')
    .find({ vendorId: { $in: vendorCandidates } }, { projection: SAFE_VENDOR_MENU_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  const allItems = docs.map(serializeVendorMenuItem);
  const stats = computeVendorMenuStats(allItems);

  const normalizedSearch = search.toLowerCase();
  const normalizedCategory = category.toLowerCase();

  const filtered = allItems.filter((item) => {
    if (status !== 'all' && item.status !== status) {
      return false;
    }
    if (normalizedCategory && item.category.toLowerCase() !== normalizedCategory) {
      return false;
    }
    if (normalizedSearch) {
      const haystack = `${item.itemName} ${item.location} ${item.description} ${item.category}`.toLowerCase();
      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }
    return true;
  });

  const sorted = sortVendorItems(filtered, sort);
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const skip = (safePage - 1) * limit;

  return {
    items: sorted.slice(skip, skip + limit),
    stats,
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

export async function getVendorMenuItemById({ itemId, vendorId }, db = getDB()) {
  const doc = await getOwnedMenuItemOrThrow(itemId, vendorId, db);
  return serializeVendorMenuItem(doc);
}

export async function createVendorMenuItem({ vendorId, payload }, db = getDB()) {
  const now = new Date();
  const storedVendorId = OBJECT_ID_HEX_REGEX.test(vendorId) ? new ObjectId(vendorId) : vendorId;

  const newDoc = {
    vendorId: storedVendorId,
    itemName: payload.itemName,
    category: payload.category,
    description: payload.description,
    price: payload.price,
    location: payload.location,
    images: payload.images,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  const result = await db.collection('menuItems').insertOne(newDoc);
  return serializeVendorMenuItem({
    ...newDoc,
    _id: result.insertedId,
  });
}

export async function updateVendorMenuItem({ itemId, vendorId, updates }, db = getDB()) {
  const existing = await getOwnedMenuItemOrThrow(itemId, vendorId, db);

  const safeSet = {
    updatedAt: new Date(),
  };

  for (const field of ['itemName', 'category', 'description', 'price', 'location', 'images']) {
    if (field in updates) {
      safeSet[field] = updates[field];
    }
  }

  // Editing an approved, inactive, or rejected listing requires fresh admin moderation.
  const updateOperation = { $set: safeSet };
  if (existing.status !== 'pending') {
    safeSet.status = 'pending';
    updateOperation.$unset = { rejectionReason: '' };
  }

  const vendorCandidates = buildVendorIdCandidates(vendorId);
  const updatedDoc = await db.collection('menuItems').findOneAndUpdate(
    {
      $and: [buildObjectIdOrStringFilter(itemId), { vendorId: { $in: vendorCandidates } }],
    },
    updateOperation,
    { returnDocument: 'after', projection: SAFE_VENDOR_MENU_PROJECTION },
  );

  if (!updatedDoc) {
    throw createAuthHttpError(404, 'Menu item not found.');
  }

  return serializeVendorMenuItem(updatedDoc);
}

export async function updateVendorMenuItemStatus(
  { itemId, vendorId, targetStatus },
  db = getDB(),
) {
  return withVendorActivationLock(vendorId, async () => {
    const existing = await getOwnedMenuItemOrThrow(itemId, vendorId, db);
    const vendorCandidates = buildVendorIdCandidates(vendorId);

    if (existing.status === 'pending') {
      throw createAuthHttpError(
        400,
        'Pending items require admin approval before they can go live on the public menu.',
      );
    }

    if (existing.status === 'rejected') {
      throw createAuthHttpError(400, 'Rejected items cannot be self-activated.');
    }

    if (existing.status === targetStatus) {
      throw createAuthHttpError(
        400,
        targetStatus === 'approved'
          ? 'This menu item is already active.'
          : 'This menu item is already inactive.',
      );
    }

    if (targetStatus === 'approved') {
      const vendorDoc = await db
        .collection('users')
        .findOne(buildObjectIdOrStringFilter(vendorId), {
          projection: { subscriptionPlan: 1, subscriptionExpiresAt: 1 },
        });

      const effectivePlan = resolveEffectiveSubscriptionPlan(vendorDoc);
      if (effectivePlan === 'free') {
        const activeCount = await db.collection('menuItems').countDocuments({
          vendorId: { $in: vendorCandidates },
          status: 'approved',
        });

        if (activeCount >= FREE_PLAN_ACTIVE_ITEM_LIMIT) {
          throw createAuthHttpError(
            409,
            `Free plan allows up to ${FREE_PLAN_ACTIVE_ITEM_LIMIT} active menu items. Deactivate an active item or upgrade to Premium.`,
          );
        }
      }
    }

    const updatedDoc = await db.collection('menuItems').findOneAndUpdate(
      {
        $and: [
          buildObjectIdOrStringFilter(itemId),
          { vendorId: { $in: vendorCandidates } },
          { status: existing.status },
        ],
      },
      { $set: { status: targetStatus, updatedAt: new Date() } },
      { returnDocument: 'after', projection: SAFE_VENDOR_MENU_PROJECTION },
    );

    if (!updatedDoc) {
      throw createAuthHttpError(409, 'Menu item status could not be updated. Please retry.');
    }

    return serializeVendorMenuItem(updatedDoc);
  });
}

export async function deleteVendorMenuItem({ itemId, vendorId }, db = getDB()) {
  await getOwnedMenuItemOrThrow(itemId, vendorId, db);

  const itemIdCandidates = buildVendorIdCandidates(itemId);
  const linkedOrdersCount = await db.collection('orders').countDocuments({
    $or: [
      { itemId: { $in: itemIdCandidates } },
      { 'items.menuItemId': { $in: itemIdCandidates } },
    ],
  });

  if (linkedOrdersCount > 0) {
    throw createAuthHttpError(
      409,
      'Cannot delete a menu item that has existing order history. Deactivate it instead.',
    );
  }

  const vendorCandidates = buildVendorIdCandidates(vendorId);
  const result = await db.collection('menuItems').deleteOne({
    $and: [buildObjectIdOrStringFilter(itemId), { vendorId: { $in: vendorCandidates } }],
  });

  if (!result || result.deletedCount === 0) {
    throw createAuthHttpError(404, 'Menu item not found.');
  }

  return true;
}

const ALLOWED_ADMIN_TRANSITIONS = Object.freeze({
  pending: new Set(['approved', 'rejected']),
  approved: new Set(['rejected', 'inactive']),
  inactive: new Set(['approved', 'rejected']),
  rejected: new Set(),
});

function serializeAdminVendor(vendorDoc, fallbackVendorId) {
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

export function serializeAdminMenuItem(doc, vendorDoc) {
  const base = serializeVendorMenuItem(doc);
  return {
    ...base,
    approvedAt: doc.approvedAt ? toIsoString(doc.approvedAt) : null,
    rejectedAt: doc.rejectedAt ? toIsoString(doc.rejectedAt) : null,
    vendor: serializeAdminVendor(vendorDoc, base.vendorId),
  };
}

function computeAdminMenuCounts(items) {
  const counts = {
    all: items.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    inactive: 0,
  };

  for (const item of items) {
    if (item.status in counts) {
      counts[item.status] += 1;
    }
  }

  return counts;
}

function sortAdminItems(items, sortOption) {
  const sorted = [...items];
  const statusRank = { pending: 0, approved: 1, inactive: 2, rejected: 3 };

  sorted.sort((a, b) => {
    if (sortOption === ADMIN_MENU_SORT_OPTIONS.OLDEST) {
      const diff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
      if (diff !== 0) return diff;
    } else if (sortOption === ADMIN_MENU_SORT_OPTIONS.PRICE_ASC) {
      if (a.price !== b.price) return a.price - b.price;
    } else if (sortOption === ADMIN_MENU_SORT_OPTIONS.PRICE_DESC) {
      if (a.price !== b.price) return b.price - a.price;
    } else if (sortOption === ADMIN_MENU_SORT_OPTIONS.STATUS) {
      const rankDiff = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
      if (rankDiff !== 0) return rankDiff;
    }

    const timeDiff = toTimestamp(b.createdAt) - toTimestamp(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
  });

  return sorted;
}

export async function listAdminMenuItems(
  {
    search = '',
    category = '',
    status = 'all',
    vendorId = '',
    sort = ADMIN_MENU_SORT_OPTIONS.NEWEST,
    page = 1,
    limit = 50,
  } = {},
  db = getDB(),
) {
  const docs = await db
    .collection('menuItems')
    .find({}, { projection: SAFE_ADMIN_MENU_PROJECTION })
    .toArray();

  const vendorMap = await fetchVendorsByIds(
    docs.map((doc) => doc.vendorId),
    db,
    SAFE_ADMIN_VENDOR_PROJECTION,
  );

  const serialized = docs.map((doc) =>
    serializeAdminMenuItem(doc, vendorMap.get(String(doc.vendorId ?? ''))),
  );
  const counts = computeAdminMenuCounts(serialized);

  const normalizedSearch = search.toLowerCase();
  const normalizedCategory = category.toLowerCase();

  const filtered = serialized.filter((item) => {
    if (status !== 'all' && item.status !== status) {
      return false;
    }
    if (normalizedCategory && item.category.toLowerCase() !== normalizedCategory) {
      return false;
    }
    if (vendorId && item.vendorId !== vendorId) {
      return false;
    }
    if (normalizedSearch) {
      const haystack = [
        item.itemName,
        item.description,
        item.location,
        item.category,
        item.vendor.businessName,
        item.vendor.name,
        item.vendor.email,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }
    return true;
  });

  const sorted = sortAdminItems(filtered, sort);
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const skip = (safePage - 1) * limit;

  return {
    items: sorted.slice(skip, skip + limit),
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

export async function getAdminMenuItemById(itemId, db = getDB()) {
  const doc = await db
    .collection('menuItems')
    .findOne(buildObjectIdOrStringFilter(itemId), { projection: SAFE_ADMIN_MENU_PROJECTION });

  if (!doc) {
    throw createAuthHttpError(404, 'Menu item not found.');
  }

  const vendorMap = await fetchVendorsByIds([doc.vendorId], db, SAFE_ADMIN_VENDOR_PROJECTION);
  return serializeAdminMenuItem(doc, vendorMap.get(String(doc.vendorId ?? '')));
}

export async function moderateAdminMenuItem(
  { itemId, adminId, targetStatus, rejectionReason = '' },
  db = getDB(),
) {
  const initialDoc = await db
    .collection('menuItems')
    .findOne(buildObjectIdOrStringFilter(itemId), { projection: SAFE_ADMIN_MENU_PROJECTION });

  if (!initialDoc) {
    throw createAuthHttpError(404, 'Menu item not found.');
  }

  const vendorKey = String(initialDoc.vendorId ?? '');
  if (vendorKey === String(adminId)) {
    throw createAuthHttpError(403, 'Administrators cannot approve or reject their own listings.');
  }

  return withVendorActivationLock(vendorKey, async () => {
    const existing = await db
      .collection('menuItems')
      .findOne(buildObjectIdOrStringFilter(itemId), { projection: SAFE_ADMIN_MENU_PROJECTION });

    if (!existing) {
      throw createAuthHttpError(404, 'Menu item not found.');
    }

    if (existing.status === targetStatus) {
      const sameMsg =
        targetStatus === 'approved'
          ? 'This menu item is already approved.'
          : targetStatus === 'rejected'
            ? 'This menu item is already rejected.'
            : 'This menu item is already inactive.';
      throw createAuthHttpError(400, sameMsg);
    }

    if (existing.status === 'rejected') {
      throw createAuthHttpError(
        400,
        'Rejected items must be updated by the vendor before re-review.',
      );
    }

    const allowedNext = ALLOWED_ADMIN_TRANSITIONS[existing.status];
    if (!allowedNext || !allowedNext.has(targetStatus)) {
      throw createAuthHttpError(400, 'Invalid menu item status transition.');
    }

    if (targetStatus === 'approved') {
      const vendorDoc = await db
        .collection('users')
        .findOne(buildObjectIdOrStringFilter(vendorKey), {
          projection: { subscriptionPlan: 1, subscriptionExpiresAt: 1 },
        });

      const effectivePlan = resolveEffectiveSubscriptionPlan(vendorDoc);
      if (effectivePlan === 'free') {
        const vendorCandidates = buildVendorIdCandidates(vendorKey);
        const activeCount = await db.collection('menuItems').countDocuments({
          vendorId: { $in: vendorCandidates },
          status: 'approved',
        });

        if (activeCount >= FREE_PLAN_ACTIVE_ITEM_LIMIT) {
          throw createAuthHttpError(
            409,
            `Vendor has reached the Free plan limit of ${FREE_PLAN_ACTIVE_ITEM_LIMIT} active menu items.`,
          );
        }
      }
    }

    const now = new Date();
    let updateOperation;

    if (targetStatus === 'approved') {
      updateOperation = {
        $set: {
          status: 'approved',
          updatedAt: now,
          approvedAt: now,
          approvedBy: String(adminId),
        },
        $unset: {
          rejectionReason: '',
          rejectedAt: '',
          rejectedBy: '',
        },
      };
    } else if (targetStatus === 'rejected') {
      updateOperation = {
        $set: {
          status: 'rejected',
          rejectionReason: rejectionReason.trim() || null,
          updatedAt: now,
          rejectedAt: now,
          rejectedBy: String(adminId),
        },
        $unset: {
          approvedAt: '',
          approvedBy: '',
        },
      };
    } else {
      updateOperation = {
        $set: {
          status: 'inactive',
          updatedAt: now,
        },
      };
    }

    const updatedDoc = await db.collection('menuItems').findOneAndUpdate(
      {
        $and: [buildObjectIdOrStringFilter(itemId), { status: existing.status }],
      },
      updateOperation,
      { returnDocument: 'after', projection: SAFE_ADMIN_MENU_PROJECTION },
    );

    if (!updatedDoc) {
      throw createAuthHttpError(409, 'Menu item status could not be updated. Please retry.');
    }

    const vendorMap = await fetchVendorsByIds(
      [updatedDoc.vendorId],
      db,
      SAFE_ADMIN_VENDOR_PROJECTION,
    );
    return serializeAdminMenuItem(updatedDoc, vendorMap.get(String(updatedDoc.vendorId ?? '')));
  });
}

export async function deleteAdminMenuItem(itemId, db = getDB()) {
  const existing = await db
    .collection('menuItems')
    .findOne(buildObjectIdOrStringFilter(itemId), { projection: { _id: 1 } });

  if (!existing) {
    throw createAuthHttpError(404, 'Menu item not found.');
  }

  const itemIdCandidates = buildVendorIdCandidates(itemId);
  const linkedOrdersCount = await db.collection('orders').countDocuments({
    $or: [
      { itemId: { $in: itemIdCandidates } },
      { 'items.menuItemId': { $in: itemIdCandidates } },
    ],
  });

  if (linkedOrdersCount > 0) {
    throw createAuthHttpError(
      409,
      'Cannot delete a menu item that has existing order history. Reject or deactivate it instead.',
    );
  }

  const result = await db.collection('menuItems').deleteOne(buildObjectIdOrStringFilter(itemId));
  if (!result || result.deletedCount === 0) {
    throw createAuthHttpError(404, 'Menu item not found.');
  }

  return true;
}
