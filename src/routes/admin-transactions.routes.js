import { Router } from 'express';
import { createAdminTransactionsController } from '../controllers/admin-transactions.controller.js';
import { requireAdmin, requireAuth } from '../middleware/auth.middleware.js';

export function createAdminTransactionsRouter({ authMiddleware = requireAuth, getDatabase } = {}) {
  const router = Router();
  const controller = createAdminTransactionsController({ getDatabase });

  router.use(authMiddleware, requireAdmin);
  router.get('/', controller.listTransactions);
  router.get('/:id', controller.getTransactionDetails);

  // Payment records are strictly immutable (admin cannot create, edit, or delete transactions).
  router.post('/', controller.rejectMutation);
  router.put('/:id', controller.rejectMutation);
  router.patch('/:id', controller.rejectMutation);
  router.delete('/:id', controller.rejectMutation);

  return router;
}

export default createAdminTransactionsRouter();
