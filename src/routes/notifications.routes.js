import { Router } from 'express';
import { createNotificationsController } from '../controllers/notifications.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

export function createNotificationsRouter({ authMiddleware = requireAuth, getDatabase } = {}) {
  const router = Router();
  const controller = createNotificationsController({ getDatabase });

  router.use(authMiddleware);
  router.get('/', controller.listNotifications);
  router.get('/unread-count', controller.getUnreadCount);
  router.patch('/read-all', controller.markAllAsRead);
  router.post('/mark-all-read', controller.markAllAsRead);
  router.patch('/:id/read', controller.markAsRead);

  return router;
}

export default createNotificationsRouter();
