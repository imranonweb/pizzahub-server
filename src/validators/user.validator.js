import { z } from 'zod';
import {
  MAX_PAGINATION_PAGE,
  OBJECT_ID_HEX_REGEX,
  createValidationError,
  formatZodIssues,
  isPlainObject,
  parsePositiveIntQueryParam,
} from '../utils/validation.js';

const PHONE_REGEX = /^[+\d().\-\s]{7,20}$/;

const PROTECTED_PROFILE_FIELDS = new Set([
  'role',
  'isBlocked',
  'subscriptionPlan',
  'subscriptionExpiresAt',
  'email',
  'emailVerified',
  '_id',
  'id',
  'createdAt',
  'updatedAt',
  'password',
  'passwordHash',
  'sessions',
  'accounts',
  'tokens',
]);

const ALLOWED_ROLE_FILTERS = new Set(['all', 'customer', 'vendor', 'admin']);
const ALLOWED_STATUS_FILTERS = new Set(['all', 'active', 'blocked']);

function isValidAvatarUrl(rawValue) {
  if (rawValue.length > 500) {
    return false;
  }
  if (rawValue.startsWith('/images/')) {
    return true;
  }

  try {
    const parsed = new URL(rawValue);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const profileImageSchema = z
  .union([
    z.null(),
    z.string({ error: 'Profile image must be a string or null.' }),
  ])
  .transform((value) => {
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  })
  .refine(
    (value) => value === null || isValidAvatarUrl(value),
    'Enter a valid https:// image URL (up to 500 characters), or leave blank.',
  );

const profileUpdateSchema = z
  .object({
    name: z
      .string({ error: 'Name must be a string.' })
      .trim()
      .min(2, 'Name must be at least 2 characters.')
      .max(80, 'Name must be 80 characters or fewer.')
      .optional(),
    image: profileImageSchema.optional(),
    contactPhone: z
      .string({ error: 'Contact phone must be a string.' })
      .trim()
      .refine(
        (value) =>
          value === '' ||
          (PHONE_REGEX.test(value) && value.replace(/\D/g, '').length >= 7),
        'Enter a valid phone number (7 to 20 characters).',
      )
      .optional(),
    deliveryAddress: z
      .string({ error: 'Delivery address must be a string.' })
      .trim()
      .refine(
        (value) => value === '' || (value.length >= 8 && value.length <= 240),
        'Delivery address must be between 8 and 240 characters.',
      )
      .optional(),
    businessName: z
      .string({ error: 'Business name must be a string.' })
      .trim()
      .max(100, 'Business name must be 100 characters or fewer.')
      .optional(),
  })
  .strict();

const blockStatusSchema = z
  .object({
    isBlocked: z.boolean({ error: 'isBlocked must be a boolean value.' }),
  })
  .strict();

export function validateObjectIdParam(rawId) {
  if (typeof rawId !== 'string' || !OBJECT_ID_HEX_REGEX.test(rawId.trim())) {
    throw createValidationError('Invalid user ID format.');
  }

  return rawId.trim();
}

export function validateProfileUpdate(body) {
  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const protectedKeys = Object.keys(body).filter((key) =>
    PROTECTED_PROFILE_FIELDS.has(key),
  );
  if (protectedKeys.length > 0) {
    throw createValidationError('Protected account fields cannot be modified.', undefined, 403);
  }

  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid profile update payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  const updates = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    throw createValidationError('Provide at least one editable profile field to update.');
  }

  return updates;
}

export function validateAdminUserListQuery(query = {}) {
  const searchRaw = query.search;
  if (searchRaw !== undefined && typeof searchRaw !== 'string') {
    throw createValidationError('Search query must be a string.');
  }
  const search = typeof searchRaw === 'string' ? searchRaw.trim() : '';
  if (search.length > 100) {
    throw createValidationError('Search query must be 100 characters or fewer.');
  }

  const roleRaw = query.role;
  if (roleRaw !== undefined && typeof roleRaw !== 'string') {
    throw createValidationError('Invalid role filter.');
  }
  const role =
    typeof roleRaw === 'string' && roleRaw.trim()
      ? roleRaw.trim().toLowerCase()
      : 'all';
  if (!ALLOWED_ROLE_FILTERS.has(role)) {
    throw createValidationError('Invalid role filter. Must be all, customer, vendor, or admin.');
  }

  const statusRaw = query.status ?? query.accountStatus;
  if (statusRaw !== undefined && typeof statusRaw !== 'string') {
    throw createValidationError('Invalid account status filter.');
  }
  const status =
    typeof statusRaw === 'string' && statusRaw.trim()
      ? statusRaw.trim().toLowerCase()
      : 'all';
  if (!ALLOWED_STATUS_FILTERS.has(status)) {
    throw createValidationError('Invalid status filter. Must be all, active, or blocked.');
  }

  const page = parsePositiveIntQueryParam(query.page, {
    fieldName: 'Page',
    defaultValue: 1,
    min: 1,
    max: MAX_PAGINATION_PAGE,
  });

  const limit = parsePositiveIntQueryParam(query.limit ?? query.pageSize, {
    fieldName: 'Limit',
    defaultValue: 20,
    min: 1,
    max: 100,
  });

  return { search, role, status, page, limit };
}

export function validateBlockStatusBody(body) {
  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const parsed = blockStatusSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid block status payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  return parsed.data;
}
