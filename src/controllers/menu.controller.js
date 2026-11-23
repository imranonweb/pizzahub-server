import { ensureDBConnected, getDB } from '../config/database.js';
import { getPublicMenuItemById, listPublicMenuItems } from '../services/menu.service.js';
import {
  validateMenuItemIdParam,
  validatePublicMenuQuery,
} from '../validators/menu.validator.js';

export function createMenuController({ getDatabase = getDB } = {}) {
  async function resolveDb() {
    return getDatabase === getDB ? ensureDBConnected() : getDatabase();
  }

  return {
    async listPublicMenu(req, res) {
      const query = validatePublicMenuQuery(req.query);
      const result = await listPublicMenuItems(query, await resolveDb());

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getPublicMenuItem(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      const item = await getPublicMenuItemById(itemId, await resolveDb());

      return res.status(200).json({
        success: true,
        item,
      });
    },
  };
}

const defaultController = createMenuController();

export const { listPublicMenu, getPublicMenuItem } = defaultController;
