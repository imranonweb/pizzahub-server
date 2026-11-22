import { z } from 'zod';
import {
  MAX_PAGINATION_PAGE,
  OBJECT_ID_HEX_REGEX,
  createValidationError,
  parsePositiveIntQueryParam,
} from '../utils/validation.js';

export const NOTIFICATION_TYPES = Object.freeze([
  'order_placed',
  'order_status',
  'order_delivered',
  'order_cancelled',
  'new_order',
  'vendor_order_cancelled',
  'menu_approved',
  'menu_rejected',
  'subscription_status',
  'menu_moderation',
  'platform_event',
]);

const ALLOWED_NOTIFICATION_TYPES = new Set(['all', ...NOTIFICATION_TYPES]);

export function validateNotificationIdParam(rawId) {
  if (typeof rawId !== 'string' || !OBJECT_ID_HEX_REGEX.test(rawId.trim())) {
    throw createValidationError('Invalid notification ID format.');
  }
  return rawId.trim();
}

export function validateNotificationListQuery(query = {}) {
  const unreadRaw = query.unread ?? query.unreadOnly;
  let unreadOnly = false;
  if (unreadRaw !== undefined && unreadRaw !== '') {
    const normalized = String(unreadRaw).trim().toLowerCase();
    if (normalized === 'true') {
      unreadOnly = true;
    } else if (normalized === 'false') {
      unreadOnly = false;
    } else {
      throw createValidationError('unread filter must be true or false.', {
        unread: 'unread filter must be true or false.',
      });
    }
  }

  const typeRaw = query.type;
  if (typeRaw !== undefined && typeof typeRaw !== 'string') {
    throw createValidationError('Notification type filter must be a string.', {
      type: 'Notification type filter must be a string.',
    });
  }
  const type =
    typeof typeRaw === 'string' && typeRaw.trim() ? typeRaw.trim().toLowerCase() : 'all';
  if (!ALLOWED_NOTIFICATION_TYPES.has(type)) {
    throw createValidationError('Invalid notification type filter.', {
      type: 'Invalid notification type filter.',
    });
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

  return { unreadOnly, type, page, limit };
}

export const notificationSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(500),
});
