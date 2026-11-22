import { getDB } from '../config/database.js';
import {
  getUserUnreadNotificationCount,
  listUserNotifications,
  markAllUserNotificationsAsRead,
  markNotificationAsRead,
} from '../services/notification.service.js';
import {
  validateNotificationIdParam,
  validateNotificationListQuery,
} from '../validators/notification.validator.js';

export function createNotificationsController({ getDatabase = getDB } = {}) {
  return {
    async listNotifications(req, res) {
      const query = validateNotificationListQuery(req.query);
      const result = await listUserNotifications(req.user.id, query, getDatabase());

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getUnreadCount(req, res) {
      const result = await getUserUnreadNotificationCount(req.user.id, getDatabase());

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async markAsRead(req, res) {
      const notificationId = validateNotificationIdParam(req.params.id);
      const notification = await markNotificationAsRead(
        { notificationId, userId: req.user.id },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        message: 'Notification marked as read.',
        notification,
      });
    },

    async markAllAsRead(req, res) {
      const result = await markAllUserNotificationsAsRead(req.user.id, getDatabase());

      return res.status(200).json({
        success: true,
        message: 'All notifications marked as read.',
        ...result,
      });
    },
  };
}

const defaultController = createNotificationsController();

export const {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
} = defaultController;
