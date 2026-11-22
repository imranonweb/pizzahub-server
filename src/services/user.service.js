import { getDB } from '../config/database.js';
import { createAuthHttpError } from '../config/jwt.js';
import { buildObjectIdOrStringFilter, escapeRegex } from '../utils/validation.js';

const VALID_ROLES = new Set(['customer', 'vendor', 'admin']);

export const SAFE_USER_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  isBlocked: 1,
  businessName: 1,
  contactPhone: 1,
  deliveryAddress: 1,
  subscriptionPlan: 1,
  subscriptionExpiresAt: 1,
  emailVerified: 1,
  createdAt: 1,
  updatedAt: 1,
});

function toIsoStringOrNull(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serializeUser(doc) {
  const normalizedRole =
    typeof doc.role === 'string' && VALID_ROLES.has(doc.role.trim().toLowerCase())
      ? doc.role.trim().toLowerCase()
      : 'customer';

  return {
    id: String(doc._id ?? doc.id),
    name: typeof doc.name === 'string' ? doc.name : '',
    email: typeof doc.email === 'string' ? doc.email : '',
    image: typeof doc.image === 'string' && doc.image.length > 0 ? doc.image : null,
    role: normalizedRole,
    isBlocked: doc.isBlocked === true,
    businessName: typeof doc.businessName === 'string' ? doc.businessName : '',
    contactPhone: typeof doc.contactPhone === 'string' ? doc.contactPhone : '',
    deliveryAddress: typeof doc.deliveryAddress === 'string' ? doc.deliveryAddress : '',
    subscriptionPlan: doc.subscriptionPlan === 'premium' ? 'premium' : 'free',
    subscriptionExpiresAt: toIsoStringOrNull(doc.subscriptionExpiresAt),
    emailVerified: doc.emailVerified === true,
    createdAt: toIsoStringOrNull(doc.createdAt),
    updatedAt: toIsoStringOrNull(doc.updatedAt),
  };
}

export async function getCurrentUserProfile(userId, db = getDB()) {
  const userDoc = await db
    .collection('users')
    .findOne(buildObjectIdOrStringFilter(userId), { projection: SAFE_USER_PROJECTION });

  if (!userDoc) {
    throw createAuthHttpError(404, 'User profile not found.');
  }

  return serializeUser(userDoc);
}

export async function updateCurrentUserProfile({ userId, actorRole, updates }, db = getDB()) {
  if ('businessName' in updates && actorRole !== 'vendor') {
    throw createAuthHttpError(403, 'Only vendor accounts can update businessName.');
  }

  const safeSet = {
    updatedAt: new Date(),
  };

  if ('name' in updates) {
    safeSet.name = updates.name;
  }
  if ('image' in updates) {
    safeSet.image = updates.image;
  }
  if ('contactPhone' in updates) {
    safeSet.contactPhone = updates.contactPhone;
  }
  if ('deliveryAddress' in updates) {
    safeSet.deliveryAddress = updates.deliveryAddress;
  }
  if ('businessName' in updates) {
    safeSet.businessName = updates.businessName;
  }

  const updatedDoc = await db
    .collection('users')
    .findOneAndUpdate(
      buildObjectIdOrStringFilter(userId),
      { $set: safeSet },
      { returnDocument: 'after', projection: SAFE_USER_PROJECTION },
    );

  if (!updatedDoc) {
    throw createAuthHttpError(404, 'User profile not found.');
  }

  return serializeUser(updatedDoc);
}

export async function listAdminUsers({ search, role, status, page, limit }, db = getDB()) {
  const usersCollection = db.collection('users');
  const filter = {};

  if (role !== 'all') {
    filter.role = role;
  }

  if (status === 'blocked') {
    filter.isBlocked = true;
  } else if (status === 'active') {
    filter.isBlocked = { $ne: true };
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: regex }, { email: regex }, { businessName: regex }];
  }

  const skip = (page - 1) * limit;

  const [docs, filteredTotal, total, blocked, customers, vendors, admins] = await Promise.all([
    usersCollection
      .find(filter, { projection: SAFE_USER_PROJECTION })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    usersCollection.countDocuments(filter),
    usersCollection.countDocuments({}),
    usersCollection.countDocuments({ isBlocked: true }),
    usersCollection.countDocuments({ role: 'customer' }),
    usersCollection.countDocuments({ role: 'vendor' }),
    usersCollection.countDocuments({ role: 'admin' }),
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredTotal / limit));

  return {
    users: docs.map(serializeUser),
    pagination: {
      page,
      limit,
      total: filteredTotal,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
    counts: {
      total,
      active: Math.max(0, total - blocked),
      blocked,
      customers,
      vendors,
      admins,
    },
  };
}

export async function getAdminUserById(targetUserId, db = getDB()) {
  const userDoc = await db
    .collection('users')
    .findOne(buildObjectIdOrStringFilter(targetUserId), { projection: SAFE_USER_PROJECTION });

  if (!userDoc) {
    throw createAuthHttpError(404, 'User not found.');
  }

  return serializeUser(userDoc);
}

export async function setAdminUserBlockStatus({ actorId, targetUserId, isBlocked }, db = getDB()) {
  if (String(actorId) === String(targetUserId) && isBlocked === true) {
    throw createAuthHttpError(400, 'You cannot block your own administrator account.');
  }

  const updatedDoc = await db
    .collection('users')
    .findOneAndUpdate(
      buildObjectIdOrStringFilter(targetUserId),
      { $set: { isBlocked, updatedAt: new Date() } },
      { returnDocument: 'after', projection: SAFE_USER_PROJECTION },
    );

  if (!updatedDoc) {
    throw createAuthHttpError(404, 'User not found.');
  }

  return serializeUser(updatedDoc);
}
