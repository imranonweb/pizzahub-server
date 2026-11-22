import { getDB } from '../config/database.js';
import {
  getVendorOrderById,
  listVendorOrders,
  updateVendorOrderStatus,
} from '../services/order.service.js';
import {
  validateOrderIdParam,
  validateOrderListQuery,
  validateVendorOrderStatusBody,
} from '../validators/order.validator.js';

export function createVendorOrdersController({ getDatabase = getDB } = {}) {
  return {
    async listIncomingOrders(req, res) {
      const query = validateOrderListQuery(req.query);
      const result = await listVendorOrders(req.user.id, query, getDatabase());

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getIncomingOrderDetails(req, res) {
      const orderId = validateOrderIdParam(req.params.id);
      const order = await getVendorOrderById(
        { orderId, vendorId: req.user.id },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        order,
      });
    },

    async updateIncomingOrderStatus(req, res) {
      const orderId = validateOrderIdParam(req.params.id);
      const { status, note } = validateVendorOrderStatusBody(req.body);
      const order = await updateVendorOrderStatus(
        { orderId, vendorId: req.user.id, targetStatus: status, note },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        message: `Order status updated to ${status}.`,
        order,
      });
    },
  };
}

const defaultController = createVendorOrdersController();

export const {
  listIncomingOrders,
  getIncomingOrderDetails,
  updateIncomingOrderStatus,
} = defaultController;
