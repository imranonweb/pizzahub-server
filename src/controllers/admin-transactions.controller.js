import { getDB } from '../config/database.js';
import { createAuthHttpError } from '../config/jwt.js';
import {
  getAdminTransactionById,
  listAdminTransactions,
} from '../services/transaction.service.js';
import {
  validateAdminTransactionListQuery,
  validateTransactionIdParam,
} from '../validators/transaction.validator.js';

export function createAdminTransactionsController({ getDatabase = getDB } = {}) {
  return {
    async listTransactions(req, res) {
      const query = validateAdminTransactionListQuery(req.query);
      const result = await listAdminTransactions(query, getDatabase());

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getTransactionDetails(req, res) {
      const transactionId = validateTransactionIdParam(req.params.id);
      const transaction = await getAdminTransactionById(transactionId, getDatabase());

      return res.status(200).json({
        success: true,
        transaction,
      });
    },

    rejectMutation(_req, _res, next) {
      return next(
        createAuthHttpError(
          403,
          'Payment transaction records are read-only and cannot be modified.',
        ),
      );
    },
  };
}

const defaultController = createAdminTransactionsController();

export const { listTransactions, getTransactionDetails, rejectMutation } = defaultController;
