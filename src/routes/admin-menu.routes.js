import { Router } from 'express';
import { createAdminMenuController } from '../controllers/admin-menu.controller.js';
import { requireAdmin, requireAuth } from '../middleware/auth.middleware.js';

export function createAdminMenuRouter({ authMiddleware = requireAuth, getDatabase } = {}) {
  const router = Router();
  const controller = createAdminMenuController({ getDatabase });

  router.use(authMiddleware, requireAdmin);
  router.get('/', controller.listAllMenuItems);
  router.get('/:id', controller.getMenuItemDetails);
  router.patch('/:id/status', controller.moderateMenuItemStatus);
  router.delete('/:id', controller.deleteMenuItem);

  return router;
}

export default createAdminMenuRouter();
