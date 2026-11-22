import { getDB } from '../config/database.js';
import {
  deleteAdminMenuItem,
  getAdminMenuItemById,
  listAdminMenuItems,
  moderateAdminMenuItem,
} from '../services/menu.service.js';
import {
  validateAdminMenuListQuery,
  validateAdminMenuModerationBody,
  validateMenuItemIdParam,
} from '../validators/menu.validator.js';

export function createAdminMenuController({ getDatabase = getDB } = {}) {
  return {
    async listAllMenuItems(req, res) {
      const query = validateAdminMenuListQuery(req.query);
      const result = await listAdminMenuItems(query, getDatabase());

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getMenuItemDetails(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      const item = await getAdminMenuItemById(itemId, getDatabase());

      return res.status(200).json({
        success: true,
        item,
      });
    },

    async moderateMenuItemStatus(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      const { status, rejectionReason } = validateAdminMenuModerationBody(req.body);
      const item = await moderateAdminMenuItem(
        {
          itemId,
          adminId: req.user.id,
          targetStatus: status,
          rejectionReason,
        },
        getDatabase(),
      );

      const message =
        status === 'approved'
          ? 'Menu item approved and published.'
          : status === 'rejected'
            ? 'Menu item rejected.'
            : 'Menu item deactivated.';

      return res.status(200).json({
        success: true,
        message,
        item,
      });
    },

    async deleteMenuItem(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      await deleteAdminMenuItem(itemId, getDatabase());

      return res.status(200).json({
        success: true,
        message: 'Menu item deleted.',
      });
    },
  };
}

const defaultController = createAdminMenuController();

export const {
  listAllMenuItems,
  getMenuItemDetails,
  moderateMenuItemStatus,
  deleteMenuItem,
} = defaultController;
