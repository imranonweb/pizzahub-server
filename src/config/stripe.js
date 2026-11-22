import Stripe from 'stripe';
import { env } from './env.js';
import { createAuthHttpError } from './jwt.js';

let cachedStripeClient = null;
let cachedStripeKey = null;

export function getStripeClient() {
  if (!env.stripeSecretKey) {
    throw createAuthHttpError(503, 'Stripe billing is not configured.');
  }

  if (!cachedStripeClient || cachedStripeKey !== env.stripeSecretKey) {
    cachedStripeClient = new Stripe(env.stripeSecretKey);
    cachedStripeKey = env.stripeSecretKey;
  }

  return cachedStripeClient;
}

export function verifyStripeWebhookSignature({
  rawBody,
  signature,
  stripeClient,
  webhookSecret = env.stripeWebhookSecret,
}) {
  if (!webhookSecret) {
    throw createAuthHttpError(503, 'Stripe webhook verification is not configured.');
  }

  if (!signature || typeof signature !== 'string') {
    throw createAuthHttpError(400, 'Missing Stripe-Signature header.');
  }

  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
    throw createAuthHttpError(400, 'Webhook payload must be a raw request body.');
  }

  const client = stripeClient ?? new Stripe(env.stripeSecretKey || 'sk_webhook_verify_only');

  try {
    return client.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    throw createAuthHttpError(400, 'Invalid Stripe webhook signature.', { cause: error });
  }
}
