import 'dotenv/config';

const parsedPort = Number(process.env.PORT);

export const env = {
  port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  mongodbUri: process.env.MONGODB_URI?.trim() || '',
  dbName: process.env.DB_NAME?.trim() || '',
};

export function validateEnv() {
  const missing = [];

  if (!env.mongodbUri) {
    missing.push('MONGODB_URI');
  }

  if (!env.dbName) {
    missing.push('DB_NAME');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!/^mongodb(\+srv)?:\/\//i.test(env.mongodbUri)) {
    throw new Error(
      'Invalid MONGODB_URI: connection string must start with "mongodb://" or "mongodb+srv://"',
    );
  }
}
