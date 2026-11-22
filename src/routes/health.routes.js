import { Router } from 'express';
import { pingDB } from '../config/database.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    await pingDB();
    return res.status(200).json({
      success: true,
      message: 'PizzaHub API is running',
      database: 'connected',
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    return res.status(503).json({
      success: false,
      message: 'Database is unavailable',
      database: 'disconnected',
    });
  }
});

export default router;
