import { getDB } from '../config/database.js';
import {
  cancelCustomerOrder,
  createCustomerOrder,
  getCustomerOrderById,
  listCustomerOrders,
} from '../services/order.service.js';
import {
  validateCancelOrderBody,
  validateCreateOrderBody,
  validateOrderIdParam,
  validateOrderListQuery,
} from '../validators/order.validator.js';

export function createOrdersController({ getDatabase = getDB } = {}) {
  return {
    async placeOrder(req, res) {
      const payload = validateCreateOrderBody(req.body);
      const result = await createCustomerOrder(
        { customerId: req.user.id, payload },
        getDatabase(),
      );

      return res.status(201).json({
        success: true,
        message: 'Order placed successfully.',
        ...result,
      });
    },

    async listMyOrders(req, res) {
      const query = validateOrderListQuery(req.query);
      const result = await listCustomerOrders(req.user.id, query, getDatabase());

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getMyOrderDetails(req, res) {
      const orderId = validateOrderIdParam(req.params.id);
      const order = await getCustomerOrderById(
        { orderId, customerId: req.user.id },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        order,
      });
    },

    async cancelMyOrder(req, res) {
      const orderId = validateOrderIdParam(req.params.id);
      const { reason } = validateCancelOrderBody(req.body);
      const order = await cancelCustomerOrder(
        { orderId, customerId: req.user.id, reason },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        message: 'Order cancelled successfully.',
        order,
      });
    },
  };
}

const defaultController = createOrdersController();

export const {
  placeOrder,
  listMyOrders,
  getMyOrderDetails,
  cancelMyOrder,
} = defaultController;
