import { Router } from 'express';
import { createMenuController } from '../controllers/menu.controller.js';

export function createMenuRouter({ getDatabase } = {}) {
  const router = Router();
  const controller = createMenuController({ getDatabase });

  router.get('/', controller.listPublicMenu);
  router.get('/:id', controller.getPublicMenuItem);

  return router;
}

export default createMenuRouter();
