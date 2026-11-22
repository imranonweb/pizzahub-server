import { z } from 'zod';
import { env } from '../config/env.js';
import { createAuthHttpError } from '../config/jwt.js';

const PROTECTED_CHECKOUT_FIELDS = new Set([
  'vendorId',
  'userId',
  'price',
  'amount',
  'unitAmount',
  'currency',
  'status',
  'subscriptionPlan',
  'subscriptionExpiresAt',
  'stripeCustomerId',
  'stripeSubscriptionId',
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

function validateAllowedReturnUrl(rawUrl, fieldName) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw createValidationError(`Invalid ${fieldName}.`, {
      [fieldName]: `Invalid ${fieldName}.`,
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createValidationError(`Invalid ${fieldName} protocol.`, {
      [fieldName]: `Invalid ${fieldName} protocol.`,
    });
  }

  if (!env.allowedOrigins.includes(parsed.origin)) {
    throw createValidationError(`${fieldName} origin is not allowed.`, {
      [fieldName]: `${fieldName} origin is not allowed.`,
    });
  }

  return parsed.toString();
}

const checkoutBodySchema = z
  .object({
    plan: z
      .enum(['premium'], {
        error: 'Only the "premium" subscription plan can be purchased.',
      })
      .default('premium'),
    successUrl: z.string({ error: 'successUrl must be a string.' }).trim().optional(),
    cancelUrl: z.string({ error: 'cancelUrl must be a string.' }).trim().optional(),
  })
  .strict();

const portalBodySchema = z
  .object({
    returnUrl: z.string({ error: 'returnUrl must be a string.' }).trim().optional(),
  })
  .strict();

export function validateCreateCheckoutBody(body = {}) {
  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const protectedKeys = Object.keys(body).filter((key) => PROTECTED_CHECKOUT_FIELDS.has(key));
  if (protectedKeys.length > 0) {
    throw createValidationError(
      'Protected subscription fields cannot be supplied by the client.',
      undefined,
      403,
    );
  }

  const parsed = checkoutBodySchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid checkout request payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  const defaultBase = env.clientUrl || env.allowedOrigins[0] || 'http://localhost:3000';
  const successUrl = parsed.data.successUrl
    ? validateAllowedReturnUrl(parsed.data.successUrl, 'successUrl')
    : `${defaultBase}/payment/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = parsed.data.cancelUrl
    ? validateAllowedReturnUrl(parsed.data.cancelUrl, 'cancelUrl')
    : `${defaultBase}/payment/cancel`;

  return {
    plan: parsed.data.plan,
    successUrl,
    cancelUrl,
  };
}

export function validatePortalSessionBody(body = {}) {
  if (body === undefined || body === null) {
    const defaultBase = env.clientUrl || env.allowedOrigins[0] || 'http://localhost:3000';
    return { returnUrl: `${defaultBase}/dashboard/vendor/subscription` };
  }

  if (!isPlainObject(body)) {
    throw createValidationError('Request body must be a JSON object.');
  }

  const parsed = portalBodySchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = formatZodIssues(parsed.error.issues);
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid billing portal payload.';
    throw createValidationError(firstMessage, fieldErrors, 400);
  }

  const defaultBase = env.clientUrl || env.allowedOrigins[0] || 'http://localhost:3000';
  const returnUrl = parsed.data.returnUrl
    ? validateAllowedReturnUrl(parsed.data.returnUrl, 'returnUrl')
    : `${defaultBase}/dashboard/vendor/subscription`;

  return { returnUrl };
}
