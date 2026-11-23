import { ObjectId } from 'mongodb';
import { ensureDBConnected, getDB } from '../config/database.js';
import { OBJECT_ID_HEX_REGEX } from './validation.js';

export function toIsoString(value) {
  if (!value) {
    return new Date(0).toISOString();
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export function toIsoOrNull(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Compares two ISO-8601 strings in descending chronological order (newest first),
 * then falls back to `id` descending without allocating Date objects.
 */
export function compareIsoCreatedAtDesc(aIso, bIso, aId, bId) {
  if (aIso !== bIso) {
    return bIso > aIso ? 1 : -1;
  }
  return String(bId ?? '').localeCompare(String(aId ?? ''));
}

export function buildPaginationMeta({ page, limit, total }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);

  return {
    page: safePage,
    limit,
    total,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPrevPage: safePage > 1,
  };
}

export function paginateArray(items, page, limit) {
  const pagination = buildPaginationMeta({ page, limit, total: items.length });
  const skip = (pagination.page - 1) * limit;

  return {
    items: items.slice(skip, skip + limit),
    pagination,
  };
}

export async function resolveControllerDatabase(getDatabase = getDB) {
  return getDatabase === getDB ? ensureDBConnected() : getDatabase();
}

export async function fetchUsersMapByIds(userIds, db, projection) {
  const uniqueIds = Array.from(new Set(userIds.map((id) => String(id ?? '')).filter(Boolean)));
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const objectIds = uniqueIds
    .filter((id) => OBJECT_ID_HEX_REGEX.test(id))
    .map((id) => new ObjectId(id));

  const idCandidates = [...objectIds, ...uniqueIds];
  const userDocs = await db
    .collection('users')
    .find(
      {
        $or: [{ _id: { $in: idCandidates } }, { id: { $in: uniqueIds } }],
      },
      { projection },
    )
    .toArray();

  const userMap = new Map();
  for (const user of userDocs) {
    if (user._id) {
      userMap.set(String(user._id), user);
    }
    if (user.id) {
      userMap.set(String(user.id), user);
    }
  }

  return userMap;
}

export function isStandaloneTransactionError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    error?.code === 20 ||
    /Transaction numbers are only allowed on a replica set|does not support transactions/i.test(
      message,
    )
  );
}

/**
 * Executes `work(session)` inside a MongoDB ACID transaction when supported (replica set/mongos),
 * gracefully falling back to non-session execution on standalone servers or mocks.
 */
export async function runWithOptionalTransaction(db, work) {
  if (typeof db.client?.startSession === 'function') {
    const session = db.client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } catch (error) {
      if (!isStandaloneTransactionError(error)) {
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }

  return work(undefined);
}
