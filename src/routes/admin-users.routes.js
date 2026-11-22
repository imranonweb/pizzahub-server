import { Router } from 'express';
import { createAdminUsersController } from '../controllers/admin-users.controller.js';
import { requireAdmin, requireAuth } from '../middleware/auth.middleware.js';

export function createAdminUsersRouter({ authMiddleware = requireAuth, getDatabase } = {}) {
  const router = Router();
  const controller = createAdminUsersController({ getDatabase });

  router.use(authMiddleware, requireAdmin);
  router.get('/', controller.listUsers);
  router.get('/:id', controller.getUserDetails);
  router.patch('/:id/block', controller.updateUserBlockStatus);

  return router;
}

export default createAdminUsersRouter();
