import { ObjectId } from 'mongodb';
import { getDB } from '../config/database.js';
import { createAuthHttpError } from '../config/jwt.js';
import { MENU_SORT_OPTIONS } from '../validators/menu.validator.js';

const OBJECT_ID_HEX_REGEX = /^[a-f\d]{24}$/i;

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

export const SAFE_PUBLIC_VENDOR_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  businessName: 1,
  subscriptionPlan: 1,
  isBlocked: 1,
});

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
    subscriptionPlan: vendorDoc.subscriptionPlan === 'premium' ? 'premium' : 'free',
  };
}

export function serializePublicMenuItem(doc, vendorDoc) {
  const vendorId = String(doc.vendorId ?? '');
  const images = Array.from(
    new Set(
      Array.isArray(doc.images)
        ? doc.images.filter((img) => typeof img === 'string' && img.trim().length > 0)
        : typeof doc.images === 'string' && doc.images.trim().length > 0
          ? [doc.images.trim()]
          : [],
    ),
  );

  return {
    id: String(doc._id ?? doc.id),
    vendorId,
    itemName: typeof doc.itemName === 'string' ? doc.itemName : '',
    category: typeof doc.category === 'string' ? doc.category : '',
    description: typeof doc.description === 'string' ? doc.description : '',
    price: typeof doc.price === 'number' ? doc.price : Number(doc.price ?? 0),
    location: typeof doc.location === 'string' ? doc.location : '',
    images,
    status: 'approved',
    createdAt: toIsoString(doc.createdAt),
    vendor: serializePublicVendor(vendorDoc, vendorId),
  };
}

async function fetchVendorsByIds(vendorIds, db) {
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
      { projection: SAFE_PUBLIC_VENDOR_PROJECTION },
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
    menuCollection
      .find(filter, { projection: SAFE_PUBLIC_MENU_PROJECTION })
      .toArray(),
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
