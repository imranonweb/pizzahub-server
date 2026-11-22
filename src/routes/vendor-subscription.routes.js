import { Router } from 'express';
import { createSubscriptionController } from '../controllers/subscription.controller.js';
import { requireAuth, requireVendor } from '../middleware/auth.middleware.js';

export function createVendorSubscriptionRouter({
  authMiddleware = requireAuth,
  getDatabase,
  stripeClient,
} = {}) {
  const router = Router();
  const controller = createSubscriptionController({ getDatabase, stripeClient });

  router.use(authMiddleware, requireVendor);
  router.get('/plans', controller.listPlans);
  router.get('/', controller.getMySubscription);
  router.post('/checkout', controller.createCheckout);
  router.post('/portal', controller.createPortal);

  return router;
}

export default createVendorSubscriptionRouter();
