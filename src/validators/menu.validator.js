import { createAuthHttpError } from '../config/jwt.js';

const OBJECT_ID_HEX_REGEX = /^[a-f\d]{24}$/i;

export const MENU_SORT_OPTIONS = Object.freeze({
  FEATURED: 'featured',
  PRICE_ASC: 'price-asc',
  PRICE_DESC: 'price-desc',
  NEWEST: 'newest',
});

const ALLOWED_SORT_VALUES = new Set(Object.values(MENU_SORT_OPTIONS));

function createValidationError(message, errors) {
  const error = createAuthHttpError(400, message);
  if (errors && Object.keys(errors).length > 0) {
    error.errors = errors;
  }
  return error;
}

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
