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
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_ORDER_ITEM_QUANTITY = 20;
export const MAX_DISTINCT_ORDER_ITEMS = 25;

export const ORDER_STATUSES = Object.freeze([
  'pending',
  'accepted',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
  'rejected',
  'cancelled',
]);

export const ORDER_LIST_SORT_OPTIONS = Object.freeze({
  NEWEST: 'newest',
  OLDEST: 'oldest',
  TOTAL_ASC: 'total-asc',
  TOTAL_DESC: 'total-desc',
});

const ALLOWED_STATUS_FILTERS = new Set(['all', 'active', ...ORDER_STATUSES]);
const ALLOWED_SORT_VALUES = new Set(Object.values(ORDER_LIST_SORT_OPTIONS));

const PROTECTED_ORDER_BODY_FIELDS = new Set([
  '_id',
  'id',
  'customerId',
  'vendorId',
  'vendorName',
  'vendorLocation',
  'subtotal',
  'total',
  'totalAmount',
  'price',
  'unitPrice',
  'status',
  'statusHistory',
  'timeline',
  'paymentStatus',
  'createdAt',
  'updatedAt',
]);

const PROTECTED_ORDER_ITEM_FIELDS = new Set([
  'unitPrice',
  'price',
  'lineTotal',
  'subtotal',
  'total',
  'vendorId',
  'itemName',
  'status',
]);

const orderItemInputSchema = z
  .object({
    menuItemId: z
      .string({ error: 'Menu item ID must be a string.' })
      .trim()
      .refine((value) => OBJECT_ID_HEX_REGEX.test(value), 'Invalid menu item ID format.'),
    quantity: z
      .number({ error: 'Quantity must be a whole number.' })
      .int('Quantity must be a whole number.')
      .min(1, 'Quantity must be at least 1.')
      .max(
        MAX_ORDER_ITEM_QUANTITY,
        `Quantity cannot exceed ${MAX_ORDER_ITEM_QUANTITY} per item.`,
      ),
  })
  .strict();

const createOrderSchema = z
  .object({
    items: z
      .array(orderItemInputSchema, { error: 'Items must be a non-empty array.' })
      .min(1, 'Add at least one menu item before placing an order.')
      .max(
        MAX_DISTINCT_ORDER_ITEMS,
        `You can include up to ${MAX_DISTINCT_ORDER_ITEMS} line items per order.`,
      )
      .optional(),
    itemId: z
      .string({ error: 'Menu item ID must be a string.' })
      .trim()
      .refine((value) => OBJECT_ID_HEX_REGEX.test(value), 'Invalid menu item ID format.')
      .optional(),
    quantity: z
      .number({ error: 'Quantity must be a whole number.' })
      .int('Quantity must be a whole number.')
      .min(1, 'Quantity must be at least 1.')
      .max(
        MAX_ORDER_ITEM_QUANTITY,
        `Quantity cannot exceed ${MAX_ORDER_ITEM_QUANTITY} per item.`,
      )
      .optional(),
    deliveryAddress: z
      .string({ error: 'Delivery address must be a string.' })
      .trim()
      .min(8, 'Provide a complete delivery address (at least 8 characters).')
      .max(240, 'Delivery address must be 240 characters or fewer.'),
    contactPhone: z
      .string({ error: 'Contact phone must be a string.' })
      .trim()
      .refine(
        (value) =>
          value === '' || (PHONE_REGEX.test(value) && value.replace(/\D/g, '').length >= 7),
        'Enter a valid phone number (7 to 20 characters).',
      )
      .optional(),
    orderNotes: z
      .string({ error: 'Order notes must be a string.' })
      .trim()
      .max(300, 'Order notes must be 300 characters or fewer.')
      .optional(),
    message: z
      .string({ error: 'Order message must be a string.' })
      .trim()
      .max(300, 'Order message must be 300 characters or fewer.')
      .optional(),
    deliveryDate: z
      .string({ error: 'Delivery date must be a string.' })
      .trim()
      .refine(
        (value) => ISO_DATE_REGEX.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()),
        'Delivery date must use YYYY-MM-DD format.',
      )
      .optional(),
  })
  .strict();

const cancelOrderSchema = z
  .object({
    reason: z
      .string({ error: 'Cancellation reason must be a string.' })
      .trim()
      .max(300, 'Cancellation reason must be 300 characters or fewer.')
      .optional(),
  })
  .strict();

const vendorOrderStatusSchema = z
  .object({
    status: z.enum(
      [
        'accepted',
        'rejected',
        'preparing',
        'ready',
        'out_for_delivery',
        'delivered',
        'pending',
        'cancelled',
      ],
      {
        error: 'Invalid order status value.',
      },
    ),
    note: z
      .string({ error: 'Status note must be a string.' })
      .trim()
      .max(300, 'Status note must be 300 characters or fewer.')
      .optional(),
  })
  .strict();

export function validateOrderIdParam(rawId) {
  if (typeof rawId !== 'string' || !OBJECT_ID_HEX_REGEX.test(rawId.trim())) {
    throw createValidationError('Invalid order ID format.');
  }
  return rawId.trim();
}

export function validateCreateOrderBody(body) {
  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const protectedTopLevel = Object.keys(body).filter((key) =>
    PROTECTED_ORDER_BODY_FIELDS.has(key),
  );
  if (protectedTopLevel.length > 0) {
    throw createValidationError(
      'Protected order fields cannot be supplied by the client.',
      undefined,
      403,
    );
  }

  if (Array.isArray(body.items)) {
    for (const item of body.items) {
      if (isPlainObject(item)) {
        const protectedItemKeys = Object.keys(item).filter((key) =>
          PROTECTED_ORDER_ITEM_FIELDS.has(key),
        );
        if (protectedItemKeys.length > 0) {
          throw createValidationError(
            'Protected order item fields cannot be supplied by the client.',
            undefined,
            403,
          );
        }
      }
    }
  }

  const parsed = createOrderSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid order request payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  const rawLines = parsed.data.items
    ? parsed.data.items
    : parsed.data.itemId
      ? [{ menuItemId: parsed.data.itemId, quantity: parsed.data.quantity ?? 1 }]
      : null;

  if (!rawLines || rawLines.length === 0) {
    throw createValidationError('Add at least one menu item before placing an order.', {
      items: 'Add at least one menu item before placing an order.',
    });
  }

  // Merge duplicate menuItemId entries and verify combined quantity cap.
  const mergedQuantities = new Map();
  for (const line of rawLines) {
    const nextQty = (mergedQuantities.get(line.menuItemId) ?? 0) + line.quantity;
    if (nextQty > MAX_ORDER_ITEM_QUANTITY) {
      throw createValidationError(
        `Combined quantity for an item cannot exceed ${MAX_ORDER_ITEM_QUANTITY}.`,
        { items: `Combined quantity cannot exceed ${MAX_ORDER_ITEM_QUANTITY}.` },
        400,
      );
    }
    mergedQuantities.set(line.menuItemId, nextQty);
  }

  const resolvedMessage = parsed.data.orderNotes ?? parsed.data.message ?? '';

  return {
    items: Array.from(mergedQuantities.entries()).map(([menuItemId, quantity]) => ({
      menuItemId,
      quantity,
    })),
    deliveryAddress: parsed.data.deliveryAddress,
    contactPhone: parsed.data.contactPhone ?? '',
    orderNotes: resolvedMessage,
    message: resolvedMessage,
    deliveryDate: parsed.data.deliveryDate ?? null,
  };
}

export function validateCancelOrderBody(body) {
  if (body === undefined || body === null) {
    return { reason: '' };
  }
  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const parsed = cancelOrderSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid cancellation payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  return {
    reason: parsed.data.reason ?? '',
  };
}

export function validateVendorOrderStatusBody(body) {
  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const parsed = vendorOrderStatusSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid order status payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  if (parsed.data.status === 'delivered' || parsed.data.status === 'out_for_delivery') {
    throw createValidationError(
      'Vendors cannot directly mark orders as delivered or out for delivery.',
      { status: 'Vendors cannot directly mark orders as delivered or out for delivery.' },
      403,
    );
  }

  return {
    status: parsed.data.status,
    note: parsed.data.note ?? '',
  };
}

export function validateOrderListQuery(query = {}) {
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

  const statusRaw = query.status;
  if (statusRaw !== undefined && typeof statusRaw !== 'string') {
    throw createValidationError('Status filter must be a string.', {
      status: 'Status filter must be a string.',
    });
  }
  const status =
    typeof statusRaw === 'string' && statusRaw.trim()
      ? statusRaw.trim().toLowerCase()
      : 'all';
  if (!ALLOWED_STATUS_FILTERS.has(status)) {
    throw createValidationError(
      'Invalid order status filter.',
      { status: 'Invalid order status filter.' },
    );
  }

  const sortRaw = query.sort;
  if (sortRaw !== undefined && typeof sortRaw !== 'string') {
    throw createValidationError('Sort option must be a string.', {
      sort: 'Sort option must be a string.',
    });
  }
  const sort =
    typeof sortRaw === 'string' && sortRaw.trim()
      ? sortRaw.trim().toLowerCase()
      : ORDER_LIST_SORT_OPTIONS.NEWEST;
  if (!ALLOWED_SORT_VALUES.has(sort)) {
    throw createValidationError(
      'Invalid sort option. Allowed values: newest, oldest, total-asc, total-desc.',
      { sort: 'Allowed values: newest, oldest, total-asc, total-desc.' },
    );
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

  return { search, status, sort, page, limit };
}
