import { getDB } from '../config/database.js';
import { getPublicMenuItemById, listPublicMenuItems } from '../services/menu.service.js';
import { resolveControllerDatabase } from '../utils/service-helpers.js';
import {
  validateMenuItemIdParam,
  validatePublicMenuQuery,
} from '../validators/menu.validator.js';

export function createMenuController({ getDatabase = getDB } = {}) {
  return {
    async listPublicMenu(req, res) {
      const query = validatePublicMenuQuery(req.query);
      const db = await resolveControllerDatabase(getDatabase);
      const result = await listPublicMenuItems(query, db);

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getPublicMenuItem(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      const db = await resolveControllerDatabase(getDatabase);
      const item = await getPublicMenuItemById(itemId, db);

      return res.status(200).json({
        success: true,
        item,
      });
    },
  };
}

const defaultController = createMenuController();

export const { listPublicMenu, getPublicMenuItem } = defaultController;
