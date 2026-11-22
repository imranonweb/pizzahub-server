import { getDB } from '../config/database.js';
import {
  createVendorMenuItem,
  deleteVendorMenuItem,
  getVendorMenuItemById,
  listVendorMenuItems,
  updateVendorMenuItem,
  updateVendorMenuItemStatus,
} from '../services/menu.service.js';
import {
  validateCreateVendorMenuBody,
  validateMenuItemIdParam,
  validateUpdateVendorMenuBody,
  validateVendorMenuStatusBody,
} from '../validators/menu.validator.js';

export function createVendorMenuController({ getDatabase = getDB } = {}) {
  return {
    async listMyMenuItems(req, res) {
      const result = await listVendorMenuItems(req.user.id, getDatabase());
      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getMyMenuItem(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      const item = await getVendorMenuItemById(
        { itemId, vendorId: req.user.id },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        item,
      });
    },

    async createMyMenuItem(req, res) {
      const payload = validateCreateVendorMenuBody(req.body);
      const item = await createVendorMenuItem(
        { vendorId: req.user.id, payload },
        getDatabase(),
      );

      return res.status(201).json({
        success: true,
        message: 'Menu item created and queued as Pending for admin approval.',
        item,
      });
    },

    async updateMyMenuItem(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      const updates = validateUpdateVendorMenuBody(req.body);
      const item = await updateVendorMenuItem(
        { itemId, vendorId: req.user.id, updates },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        message: 'Menu item updated successfully.',
        item,
      });
    },

    async updateMyMenuItemStatus(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      const { status } = validateVendorMenuStatusBody(req.body);
      const item = await updateVendorMenuItemStatus(
        { itemId, vendorId: req.user.id, targetStatus: status },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        message:
          status === 'approved'
            ? 'Menu item is now active on the public menu.'
            : 'Menu item deactivated.',
        item,
      });
    },

    async deleteMyMenuItem(req, res) {
      const itemId = validateMenuItemIdParam(req.params.id);
      await deleteVendorMenuItem({ itemId, vendorId: req.user.id }, getDatabase());

      return res.status(200).json({
        success: true,
        message: 'Menu item deleted.',
      });
    },
  };
}

const defaultController = createVendorMenuController();

export const {
  listMyMenuItems,
  getMyMenuItem,
  createMyMenuItem,
  updateMyMenuItem,
  updateMyMenuItemStatus,
  deleteMyMenuItem,
} = defaultController;
