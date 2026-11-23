import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './config/env.js';
import healthRoutes from './routes/health.routes.js';
import menuRoutes from './routes/menu.routes.js';
import vendorMenuRoutes from './routes/vendor-menu.routes.js';
import ordersRoutes from './routes/orders.routes.js';
import vendorOrdersRoutes from './routes/vendor-orders.routes.js';
import vendorSubscriptionRoutes from './routes/vendor-subscription.routes.js';
import stripeWebhookRoutes from './routes/webhook.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';
import profileRoutes from './routes/profile.routes.js';
import adminMenuRoutes from './routes/admin-menu.routes.js';
import adminUsersRoutes from './routes/admin-users.routes.js';
import adminTransactionsRoutes from './routes/admin-transactions.routes.js';
import { notFoundMiddleware } from './middleware/not-found.middleware.js';
import { errorMiddleware } from './middleware/error.middleware.js';
import { createRateLimiter } from './middleware/rate-limit.middleware.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', env.trustProxy);
  app.set('query parser', 'simple');

  const corsOptions = {
    origin(requestOrigin, callback) {
      if (!requestOrigin) {
        return callback(null, true);
      }

      const normalizedOrigin = requestOrigin.replace(/\/+$/, '');
      if (env.allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      const corsError = new Error('Origin not allowed by CORS');
      corsError.statusCode = 403;
      return callback(corsError);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  };

  const apiRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: 'Too many API requests from this client. Please try again shortly.',
    skip: (req) => req.path === '/health' || req.path === '/webhooks/stripe',
  });

  const sensitiveMutationLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 40,
    message: 'Too many sensitive requests. Please wait a moment and try again.',
    skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  });

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(morgan(env.isProduction ? 'combined' : 'dev'));
  // Stripe webhook signature verification requires the exact raw request Buffer before JSON parsing.
  app.use(
    '/api/webhooks/stripe',
    express.raw({ type: 'application/json', limit: '1mb' }),
    stripeWebhookRoutes,
  );
  app.use('/api', apiRateLimiter);
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  app.use('/api/health', healthRoutes);
  app.use('/api/menu', menuRoutes);
  app.use('/api/vendor/menu', sensitiveMutationLimiter, vendorMenuRoutes);
  app.use('/api/orders', sensitiveMutationLimiter, ordersRoutes);
  app.use('/api/vendor/orders', sensitiveMutationLimiter, vendorOrdersRoutes);
  app.use('/api/vendor/subscription', sensitiveMutationLimiter, vendorSubscriptionRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/profile', sensitiveMutationLimiter, profileRoutes);
  app.use('/api/admin/menu', sensitiveMutationLimiter, adminMenuRoutes);
  app.use('/api/admin/users', sensitiveMutationLimiter, adminUsersRoutes);
  app.use('/api/admin/transactions', sensitiveMutationLimiter, adminTransactionsRoutes);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

const app = createApp();

export default app;
