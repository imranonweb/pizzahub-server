import { Router } from 'express';
import { createOrdersController } from '../controllers/orders.controller.js';
import { requireAuth, requireCustomer } from '../middleware/auth.middleware.js';

export function createOrdersRouter({ authMiddleware = requireAuth, getDatabase } = {}) {
  const router = Router();
  const controller = createOrdersController({ getDatabase });

  router.use(authMiddleware, requireCustomer);
  router.post('/', controller.placeOrder);
  router.get('/', controller.listMyOrders);
  router.get('/my', controller.listMyOrders);
  router.get('/:id', controller.getMyOrderDetails);
  router.patch('/:id/cancel', controller.cancelMyOrder);

  return router;
}

export default createOrdersRouter();
