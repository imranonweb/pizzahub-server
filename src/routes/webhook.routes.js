import { Router } from 'express';
import { createSubscriptionController } from '../controllers/subscription.controller.js';

export function createStripeWebhookRouter({
  getDatabase,
  stripeClient,
  verifyWebhook,
} = {}) {
  const router = Router();
  const controller = createSubscriptionController({
    getDatabase,
    stripeClient,
    verifyWebhook,
  });

  router.post('/', controller.handleStripeWebhook);

  return router;
}

export default createStripeWebhookRouter();
