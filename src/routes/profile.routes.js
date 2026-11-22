import { Router } from 'express';
import { createProfileController } from '../controllers/profile.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

export function createProfileRouter({ authMiddleware = requireAuth, getDatabase } = {}) {
  const router = Router();
  const controller = createProfileController({ getDatabase });

  router.use(authMiddleware);
  router.get('/', controller.getMyProfile);
  router.patch('/', controller.updateMyProfile);

  return router;
}

export default createProfileRouter();
