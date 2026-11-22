import { z } from 'zod';
import { createAuthHttpError } from '../config/jwt.js';

const OBJECT_ID_HEX_REGEX = /^[a-f\d]{24}$/i;

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

function createValidationError(message, errors, statusCode = 400) {
  const error = createAuthHttpError(statusCode, message);
  if (errors && Object.keys(errors).length > 0) {
    error.errors = errors;
  }
  return error;
}

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
  let limit = 20;
  if (limitRaw !== undefined && limitRaw !== '') {
    const parsedLimit = Number(limitRaw);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw createValidationError('Limit must be an integer between 1 and 100.', {
        limit: 'Limit must be an integer between 1 and 100.',
      });
    }
    limit = parsedLimit;
  }

  return { unreadOnly, type, page, limit };
}

export const notificationSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(500),
});
