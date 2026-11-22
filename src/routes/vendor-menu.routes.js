import { Router } from 'express';
import { createVendorMenuController } from '../controllers/vendor-menu.controller.js';
import { requireAuth, requireVendor } from '../middleware/auth.middleware.js';

export function createVendorMenuRouter({ authMiddleware = requireAuth, getDatabase } = {}) {
  const router = Router();
  const controller = createVendorMenuController({ getDatabase });

  router.use(authMiddleware, requireVendor);
  router.get('/', controller.listMyMenuItems);
  router.post('/', controller.createMyMenuItem);
  router.get('/:id', controller.getMyMenuItem);
  router.patch('/:id', controller.updateMyMenuItem);
  router.patch('/:id/status', controller.updateMyMenuItemStatus);
  router.delete('/:id', controller.deleteMyMenuItem);

  return router;
}

export default createVendorMenuRouter();
