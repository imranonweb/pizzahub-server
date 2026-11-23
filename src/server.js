import { env, validateEnv } from './config/env.js';
import { connectDB, closeDB } from './config/database.js';
import app from './app.js';

let server = null;
let isShuttingDown = false;
let shutdownHandlersRegistered = false;

function closeHttpServer() {
  if (!server) {
    return Promise.resolve();
  }

  const activeServer = server;
  server = null;

  return new Promise((resolve, reject) => {
    activeServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      console.log('HTTP server closed.');
      resolve();
    });
  });
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`Received ${signal}. Starting graceful shutdown...`);

  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  let exitCode = 0;

  try {
    await closeHttpServer();
  } catch (error) {
    exitCode = 1;
    console.error('Error closing HTTP server:', error.message);
  }

  try {
    await closeDB();
  } catch (error) {
    exitCode = 1;
    console.error('Error during database shutdown:', error.message);
  }

  clearTimeout(forceExitTimer);
  process.exit(exitCode);
}

function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) {
    return;
  }
  shutdownHandlersRegistered = true;

  process.once('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection');
    console.error('Unhandled promise rejection:', message);
  });
  process.once('uncaughtException', (error) => {
    console.error('Uncaught exception:', error?.message || 'Fatal server error');
    void gracefulShutdown('uncaughtException');
  });
}

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const httpServer = app.listen(env.port);

    const onError = (error) => {
      httpServer.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      httpServer.off('error', onError);
      server = httpServer;
      console.log(`PizzaHub server is running on port ${env.port} (${env.nodeEnv})`);
      resolve(httpServer);
    };

    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
  });
}

async function startServer() {
  try {
    validateEnv();
    await connectDB();
    await startHttpServer();
    registerShutdownHandlers();
  } catch (error) {
    console.error('Failed to start PizzaHub server:', error.message);

    try {
      await closeDB();
    } catch (closeError) {
      console.error('Cleanup error while closing database:', closeError.message);
    }

    process.exit(1);
  }
}

if (process.env.VERCEL !== '1') {
  startServer();
}

export default app;
