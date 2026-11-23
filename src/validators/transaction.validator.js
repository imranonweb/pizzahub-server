import {
  MAX_PAGINATION_PAGE,
  OBJECT_ID_HEX_REGEX,
  createValidationError,
  parsePositiveIntQueryParam,
} from '../utils/validation.js';

export const ADMIN_TRANSACTION_SORT_OPTIONS = Object.freeze({
  NEWEST: 'newest',
  OLDEST: 'oldest',
  AMOUNT_ASC: 'amount-asc',
  AMOUNT_DESC: 'amount-desc',
});

const ALLOWED_STATUS_FILTERS = new Set([
  'all',
  'paid',
  'failed',
  'pending',
  'active',
  'cancelling',
  'cancelled',
]);
const ALLOWED_PLAN_FILTERS = new Set(['all', 'free', 'premium']);
const ALLOWED_SORT_VALUES = new Set(Object.values(ADMIN_TRANSACTION_SORT_OPTIONS));

export function validateTransactionIdParam(rawId) {
  if (typeof rawId !== 'string' || !OBJECT_ID_HEX_REGEX.test(rawId.trim())) {
    throw createValidationError('Invalid transaction ID format.');
  }
  return rawId.trim();
}

export function validateAdminTransactionListQuery(query = {}) {
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
      'Invalid status filter. Allowed values: all, paid, failed, pending, active, cancelling, cancelled.',
      { status: 'Invalid transaction status filter.' },
    );
  }

  const planRaw = query.plan;
  if (planRaw !== undefined && typeof planRaw !== 'string') {
    throw createValidationError('Plan filter must be a string.', {
      plan: 'Plan filter must be a string.',
    });
  }
  const plan =
    typeof planRaw === 'string' && planRaw.trim() ? planRaw.trim().toLowerCase() : 'all';
  if (!ALLOWED_PLAN_FILTERS.has(plan)) {
    throw createValidationError('Invalid plan filter. Allowed values: all, free, premium.', {
      plan: 'Allowed values: all, free, premium.',
    });
  }

  const vendorIdRaw = query.vendorId;
  if (vendorIdRaw !== undefined && typeof vendorIdRaw !== 'string') {
    throw createValidationError('Invalid vendor ID format.', {
      vendorId: 'Invalid vendor ID format.',
    });
  }
  const vendorId = typeof vendorIdRaw === 'string' ? vendorIdRaw.trim() : '';
  if (vendorId && !OBJECT_ID_HEX_REGEX.test(vendorId)) {
    throw createValidationError('Invalid vendor ID format.', {
      vendorId: 'Invalid vendor ID format.',
    });
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
      : ADMIN_TRANSACTION_SORT_OPTIONS.NEWEST;
  if (!ALLOWED_SORT_VALUES.has(sort)) {
    throw createValidationError(
      'Invalid sort option. Allowed values: newest, oldest, amount-asc, amount-desc.',
      { sort: 'Allowed values: newest, oldest, amount-asc, amount-desc.' },
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

  return { search, status, plan, vendorId, sort, page, limit };
}
