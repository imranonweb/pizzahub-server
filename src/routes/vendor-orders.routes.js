import { Router } from 'express';
import { createVendorOrdersController } from '../controllers/vendor-orders.controller.js';
import { requireAuth, requireVendor } from '../middleware/auth.middleware.js';

export function createVendorOrdersRouter({ authMiddleware = requireAuth, getDatabase } = {}) {
  const router = Router();
  const controller = createVendorOrdersController({ getDatabase });

  router.use(authMiddleware, requireVendor);
  router.get('/', controller.listIncomingOrders);
  router.get('/:id', controller.getIncomingOrderDetails);
  router.patch('/:id/status', controller.updateIncomingOrderStatus);

  return router;
}

export default createVendorOrdersRouter();
