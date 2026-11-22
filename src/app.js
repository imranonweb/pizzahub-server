import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './config/env.js';
import healthRoutes from './routes/health.routes.js';
import profileRoutes from './routes/profile.routes.js';
import adminUsersRoutes from './routes/admin-users.routes.js';
import { notFoundMiddleware } from './middleware/not-found.middleware.js';
import { errorMiddleware } from './middleware/error.middleware.js';

const app = express();

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

app.use(helmet());
app.use(cors(corsOptions));
app.use(morgan(env.isProduction ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/health', healthRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/admin/users', adminUsersRoutes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
