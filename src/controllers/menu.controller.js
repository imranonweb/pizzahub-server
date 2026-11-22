import { getDB } from '../config/database.js';
import { getPublicMenuItemById, listPublicMenuItems } from '../services/menu.service.js';
import {
  validateMenuItemIdParam,
  validatePublicMenuQuery,
} from '../validators/menu.validator.js';

export function createMenuController({ getDatabase = getDB } = {}) {
  return {
    async listPublicMenu(req, res) {
      const query = validatePublicMenuQuery(req.query);
      const result = await listPublicMenuItems(query, getDatabase());

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getPublicMenuItem(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      const item = await getPublicMenuItemById(itemId, getDatabase());

      return res.status(200).json({
        success: true,
        item,
      });
    },
  };
}

const defaultController = createMenuController();

export const { listPublicMenu, getPublicMenuItem } = defaultController;
