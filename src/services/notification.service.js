import { ObjectId } from 'mongodb';
import { getDB } from '../config/database.js';
import { createAuthHttpError } from '../config/jwt.js';
import { buildPaginationMeta, toIsoString } from '../utils/service-helpers.js';
import {
  OBJECT_ID_HEX_REGEX,
  buildIdCandidates,
  buildObjectIdOrStringFilter,
} from '../utils/validation.js';

export const SAFE_NOTIFICATION_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  userId: 1,
  role: 1,
  type: 1,
  title: 1,
  message: 1,
  relatedResourceId: 1,
  link: 1,
  metadata: 1,
  read: 1,
  createdAt: 1,
  readAt: 1,
});

export function serializeNotification(doc) {
  return {
    id: String(doc._id ?? doc.id),
    userId: String(doc.userId ?? ''),
    role: typeof doc.role === 'string' ? doc.role : 'customer',
    type: typeof doc.type === 'string' ? doc.type : 'platform_event',
    title: typeof doc.title === 'string' ? doc.title : '',
    message: typeof doc.message === 'string' ? doc.message : '',
    relatedResourceId: doc.relatedResourceId ? String(doc.relatedResourceId) : null,
    link: typeof doc.link === 'string' && doc.link ? doc.link : undefined,
    metadata:
      doc.metadata && typeof doc.metadata === 'object' && !Array.isArray(doc.metadata)
        ? doc.metadata
        : undefined,
    read: doc.read === true,
    createdAt: toIsoString(doc.createdAt),
    readAt: doc.readAt ? toIsoString(doc.readAt) : null,
  };
}

export async function createNotification(
  {
    userId,
    role,
    type,
    title,
    message,
    relatedResourceId = null,
    link,
    metadata,
    eventKey,
  },
  db = getDB(),
) {
  const notificationsCollection = db.collection('notifications');
  const userIdStr = String(userId ?? '').trim();
  if (!userIdStr) {
    return null;
  }

  const userCandidates = buildIdCandidates(userIdStr);
  if (eventKey) {
    const existing = await notificationsCollection.findOne(
      {
        userId: { $in: userCandidates },
        eventKey,
      },
      { projection: SAFE_NOTIFICATION_PROJECTION },
    );
    if (existing) {
      return serializeNotification(existing);
    }
  }

  const now = new Date();
  const doc = {
    userId: OBJECT_ID_HEX_REGEX.test(userIdStr) ? new ObjectId(userIdStr) : userIdStr,
    role,
    type,
    title,
    message,
    relatedResourceId: relatedResourceId ? String(relatedResourceId) : null,
    ...(link ? { link } : {}),
    ...(metadata ? { metadata } : {}),
    ...(eventKey ? { eventKey } : {}),
    read: false,
    createdAt: now,
  };

  try {
    const result = await notificationsCollection.insertOne(doc);
    return serializeNotification({ ...doc, _id: result.insertedId });
  } catch (error) {
    // Handle concurrent duplicate-key insertions cleanly when eventKey unique index triggers.
    if (error?.code === 11000 && eventKey) {
      const existing = await notificationsCollection.findOne(
        { userId: { $in: userCandidates }, eventKey },
        { projection: SAFE_NOTIFICATION_PROJECTION },
      );
      return existing ? serializeNotification(existing) : null;
    }
    throw error;
  }
}

export async function safeNotify(input, db = getDB()) {
  try {
    return await createNotification(input, db);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Notification] Failed to persist notification (${input?.type}): ${msg}`);
    return null;
  }
}

export async function listUserNotifications(
  userId,
  { unreadOnly = false, type = 'all', page = 1, limit = 20 } = {},
  db = getDB(),
) {
  const notificationsCollection = db.collection('notifications');
  const userCandidates = buildIdCandidates(userId);
  const baseFilter = { userId: { $in: userCandidates } };
  const queryFilter = { ...baseFilter };

  if (unreadOnly) {
    queryFilter.read = false;
  }
  if (type !== 'all') {
    queryFilter.type = type;
  }

  const skip = (page - 1) * limit;
  const hasSubFilter = unreadOnly || type !== 'all';

  const [docs, unreadCount, totalCount, subFilteredCount] = await Promise.all([
    notificationsCollection
      .find(queryFilter, { projection: SAFE_NOTIFICATION_PROJECTION })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    notificationsCollection.countDocuments({ ...baseFilter, read: false }),
    notificationsCollection.countDocuments(baseFilter),
    hasSubFilter ? notificationsCollection.countDocuments(queryFilter) : Promise.resolve(null),
  ]);

  const filteredCount = hasSubFilter ? subFilteredCount : totalCount;

  return {
    notifications: docs.map(serializeNotification),
    unreadCount,
    totalCount,
    pagination: buildPaginationMeta({ page, limit, total: filteredCount }),
  };
}

export async function getUserUnreadNotificationCount(userId, db = getDB()) {
  const userCandidates = buildIdCandidates(userId);
  const unreadCount = await db.collection('notifications').countDocuments({
    userId: { $in: userCandidates },
    read: false,
  });

  return { unreadCount };
}

export async function markNotificationAsRead({ notificationId, userId }, db = getDB()) {
  const userCandidates = buildIdCandidates(userId);
  const notificationsCollection = db.collection('notifications');

  const existing = await notificationsCollection.findOne(
    {
      $and: [buildObjectIdOrStringFilter(notificationId), { userId: { $in: userCandidates } }],
    },
    { projection: SAFE_NOTIFICATION_PROJECTION },
  );

  if (!existing) {
    throw createAuthHttpError(404, 'Notification not found.');
  }

  if (existing.read === true) {
    return serializeNotification(existing);
  }

  const updatedDoc = await notificationsCollection.findOneAndUpdate(
    {
      $and: [buildObjectIdOrStringFilter(notificationId), { userId: { $in: userCandidates } }],
    },
    {
      $set: { read: true, readAt: new Date() },
    },
    { returnDocument: 'after', projection: SAFE_NOTIFICATION_PROJECTION },
  );

  if (!updatedDoc) {
    throw createAuthHttpError(404, 'Notification not found.');
  }

  return serializeNotification(updatedDoc);
}

export async function markAllUserNotificationsAsRead(userId, db = getDB()) {
  const userCandidates = buildIdCandidates(userId);
  const result = await db.collection('notifications').updateMany(
    { userId: { $in: userCandidates }, read: false },
    { $set: { read: true, readAt: new Date() } },
  );

  return {
    count: result?.modifiedCount ?? 0,
  };
}
