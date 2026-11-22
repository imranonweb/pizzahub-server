import { ObjectId } from 'mongodb';
import { createAuthHttpError } from '../config/jwt.js';

export const OBJECT_ID_HEX_REGEX = /^[a-f\d]{24}$/i;
export const MAX_PAGINATION_PAGE = 10000;

export function createValidationError(message, errors, statusCode = 400) {
  const error = createAuthHttpError(statusCode, message);
  if (errors && Object.keys(errors).length > 0) {
    error.errors = errors;
  }
  return error;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function formatZodIssues(issues) {
  const errors = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : 'body';
    if (!errors[key]) {
      errors[key] = issue.message;
    }
  }
  return errors;
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildIdCandidates(rawId) {
  const value = String(rawId);
  if (OBJECT_ID_HEX_REGEX.test(value)) {
    return [new ObjectId(value), value];
  }
  return [value];
}

export function buildObjectIdOrStringFilter(rawId) {
  if (OBJECT_ID_HEX_REGEX.test(rawId)) {
    return {
      $or: [{ _id: new ObjectId(rawId) }, { _id: rawId }, { id: rawId }],
    };
  }
  return {
    $or: [{ _id: rawId }, { id: rawId }],
  };
}

/**
 * Parses strictly positive integer query params without array/boolean coercion.
 */
export function parsePositiveIntQueryParam(rawValue, { fieldName, defaultValue, min = 1, max }) {
  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }

  let parsed;
  if (typeof rawValue === 'number') {
    parsed = rawValue;
  } else if (typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim())) {
    parsed = Number(rawValue.trim());
  } else {
    throw createValidationError(
      max
        ? `${fieldName} must be an integer between ${min} and ${max}.`
        : `${fieldName} must be a positive integer.`,
      {
        [fieldName.toLowerCase()]: max
          ? `${fieldName} must be an integer between ${min} and ${max}.`
          : `${fieldName} must be a positive integer.`,
      },
    );
  }

  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    throw createValidationError(
      max
        ? `${fieldName} must be an integer between ${min} and ${max}.`
        : `${fieldName} must be a positive integer.`,
      {
        [fieldName.toLowerCase()]: max
          ? `${fieldName} must be an integer between ${min} and ${max}.`
          : `${fieldName} must be a positive integer.`,
      },
    );
  }

  return parsed;
}
