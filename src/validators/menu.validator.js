import { z } from 'zod';
import { createAuthHttpError } from '../config/jwt.js';

const OBJECT_ID_HEX_REGEX = /^[a-f\d]{24}$/i;

export const MENU_CATEGORIES = Object.freeze([
  'Classic Pizzas',
  'Vegetarian Pizzas',
  'Meat Lovers',
  'Specialty / Gourmet Pizzas',
  'Sides & Appetizers',
  'Beverages & Desserts',
]);

export const MAX_MENU_IMAGES = 5;
export const FREE_PLAN_ACTIVE_ITEM_LIMIT = 3;

export const MENU_SORT_OPTIONS = Object.freeze({
  FEATURED: 'featured',
  PRICE_ASC: 'price-asc',
  PRICE_DESC: 'price-desc',
  NEWEST: 'newest',
});

const ALLOWED_SORT_VALUES = new Set(Object.values(MENU_SORT_OPTIONS));
const ALLOWED_CATEGORIES_SET = new Set(MENU_CATEGORIES);

const PROTECTED_MENU_FIELDS = new Set([
  '_id',
  'id',
  'vendorId',
  'status',
  'rejectionReason',
  'approvedAt',
  'approvedBy',
  'rejectedAt',
  'rejectedBy',
  'createdAt',
  'updatedAt',
]);

function createValidationError(message, errors, statusCode = 400) {
  const error = createAuthHttpError(statusCode, message);
  if (errors && Object.keys(errors).length > 0) {
    error.errors = errors;
  }
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatZodIssues(issues) {
  const errors = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : 'body';
    if (!errors[key]) {
      errors[key] = issue.message;
    }
  }
  return errors;
}

function isValidMenuImageUrl(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed || trimmed.length > 500) {
    return false;
  }
  if (trimmed.startsWith('/images/')) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const itemNameSchema = z
  .string({ error: 'Item name must be a string.' })
  .trim()
  .min(2, 'Item name must be at least 2 characters.')
  .max(80, 'Item name must be 80 characters or fewer.');

const categorySchema = z
  .string({ error: 'Category must be a string.' })
  .trim()
  .refine(
    (value) => ALLOWED_CATEGORIES_SET.has(value),
    'Choose one of the official menu categories.',
  );

const descriptionSchema = z
  .string({ error: 'Description must be a string.' })
  .trim()
  .min(15, 'Description must be at least 15 characters.')
  .max(500, 'Description must be 500 characters or fewer.');

const priceSchema = z
  .number({ error: 'Price must be a valid number.' })
  .refine((value) => Number.isFinite(value), 'Price must be a valid number.')
  .refine((value) => value > 0, 'Price must be greater than $0.00.')
  .refine((value) => value <= 500, 'Price cannot exceed $500.00 per item.')
  .refine(
    (value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-6,
    'Enter a valid price with at most two decimal places.',
  )
  .transform((value) => Math.round(value * 100) / 100);

const locationSchema = z
  .string({ error: 'Location must be a string.' })
  .trim()
  .min(2, 'Location must be at least 2 characters.')
  .max(80, 'Location must be 80 characters or fewer.');

const imagesSchema = z
  .array(
    z
      .string({ error: 'Each image must be a valid URL string.' })
      .trim()
      .refine(
        (value) => isValidMenuImageUrl(value),
        'Each image must be a valid https:// URL or /images/ path.',
      ),
    { error: 'Images must be an array of image URLs.' },
  )
  .transform((list) => Array.from(new Set(list)))
  .refine((list) => list.length >= 1, 'Upload at least one image before submitting.')
  .refine(
    (list) => list.length <= MAX_MENU_IMAGES,
    `You can attach up to ${MAX_MENU_IMAGES} images per listing.`,
  );

const createVendorMenuSchema = z
  .object({
    itemName: itemNameSchema,
    category: categorySchema,
    description: descriptionSchema,
    price: priceSchema,
    location: locationSchema,
    images: imagesSchema,
  })
  .strict();

const updateVendorMenuSchema = z
  .object({
    itemName: itemNameSchema.optional(),
    category: categorySchema.optional(),
    description: descriptionSchema.optional(),
    price: priceSchema.optional(),
    location: locationSchema.optional(),
    images: imagesSchema.optional(),
  })
  .strict();

const vendorMenuStatusSchema = z
  .object({
    status: z.enum(['approved', 'inactive'], {
      error: 'Status must be either "approved" or "inactive".',
    }),
  })
  .strict();

export function validateMenuItemIdParam(rawId) {
  if (typeof rawId !== 'string' || !OBJECT_ID_HEX_REGEX.test(rawId.trim())) {
    throw createValidationError('Invalid menu item ID format.');
  }

  return rawId.trim();
}

export function validatePublicMenuQuery(query = {}) {
  const searchRaw = query.search;
  if (searchRaw !== undefined && typeof searchRaw !== 'string') {
    throw createValidationError('Search query must be a string.', {
      search: 'Search query must be a string.',
    });
  }
  const search = typeof searchRaw === 'string' ? searchRaw.trim() : '';
  if (search.length > 100) {
    throw createValidationError('Search query must be 100 characters or fewer.', {
      search: 'Search query must be 100 characters or fewer.',
    });
  }

  const categoryRaw = query.category;
  if (categoryRaw !== undefined && typeof categoryRaw !== 'string') {
    throw createValidationError('Category filter must be a string.', {
      category: 'Category filter must be a string.',
    });
  }
  const categoryTrimmed = typeof categoryRaw === 'string' ? categoryRaw.trim() : '';
  if (categoryTrimmed.length > 80) {
    throw createValidationError('Category filter must be 80 characters or fewer.', {
      category: 'Category filter must be 80 characters or fewer.',
    });
  }
  const category =
    categoryTrimmed && categoryTrimmed.toLowerCase() !== 'all' ? categoryTrimmed : '';

  const locationRaw = query.location;
  if (locationRaw !== undefined && typeof locationRaw !== 'string') {
    throw createValidationError('Location filter must be a string.', {
      location: 'Location filter must be a string.',
    });
  }
  const locationTrimmed = typeof locationRaw === 'string' ? locationRaw.trim() : '';
  if (locationTrimmed.length > 80) {
    throw createValidationError('Location filter must be 80 characters or fewer.', {
      location: 'Location filter must be 80 characters or fewer.',
    });
  }
  const location =
    locationTrimmed && locationTrimmed.toLowerCase() !== 'all' ? locationTrimmed : '';

  const sortRaw = query.sort;
  if (sortRaw !== undefined && typeof sortRaw !== 'string') {
    throw createValidationError('Sort option must be a string.', {
      sort: 'Sort option must be a string.',
    });
  }
  const sort =
    typeof sortRaw === 'string' && sortRaw.trim()
      ? sortRaw.trim().toLowerCase()
      : MENU_SORT_OPTIONS.FEATURED;
  if (!ALLOWED_SORT_VALUES.has(sort)) {
    throw createValidationError(
      'Invalid sort option. Allowed values: featured, price-asc, price-desc, newest.',
      { sort: 'Allowed values: featured, price-asc, price-desc, newest.' },
    );
  }

  const pageRaw = query.page;
  let page = 1;
  if (pageRaw !== undefined && pageRaw !== '') {
    const parsedPage = Number(pageRaw);
    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      throw createValidationError('Page must be a positive integer.', {
        page: 'Page must be a positive integer.',
      });
    }
    page = parsedPage;
  }

  const limitRaw = query.limit ?? query.pageSize;
  let limit = 12;
  if (limitRaw !== undefined && limitRaw !== '') {
    const parsedLimit = Number(limitRaw);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
      throw createValidationError('Limit must be an integer between 1 and 50.', {
        limit: 'Limit must be an integer between 1 and 50.',
      });
    }
    limit = parsedLimit;
  }

  return {
    search,
    category,
    location,
    sort,
    page,
    limit,
  };
}

export function validateCreateVendorMenuBody(body) {
  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const protectedKeys = Object.keys(body).filter((key) => PROTECTED_MENU_FIELDS.has(key));
  if (protectedKeys.length > 0) {
    throw createValidationError('Protected menu fields cannot be supplied by the client.', undefined, 403);
  }

  const parsed = createVendorMenuSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid menu item payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  return parsed.data;
}

export function validateUpdateVendorMenuBody(body) {
  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const protectedKeys = Object.keys(body).filter((key) => PROTECTED_MENU_FIELDS.has(key));
  if (protectedKeys.length > 0) {
    throw createValidationError('Protected menu fields cannot be modified.', undefined, 403);
  }

  const parsed = updateVendorMenuSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid menu update payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  const updates = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    throw createValidationError('Provide at least one editable menu field to update.');
  }

  return updates;
}

export function validateVendorMenuStatusBody(body) {
  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const parsed = vendorMenuStatusSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid status update payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  return parsed.data;
}
