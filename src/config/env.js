import 'dotenv/config';

const parsedPort = Number(process.env.PORT);
const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
const isProduction = nodeEnv === 'production';

const rawClientUrl = process.env.CLIENT_URL?.trim() || (isProduction ? '' : 'http://localhost:3000');
const allowedOrigins = rawClientUrl
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const env = {
  port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 5000,
  nodeEnv,
  isProduction,
  clientUrl: allowedOrigins[0] || '',
  allowedOrigins,
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

  if (env.isProduction && env.allowedOrigins.length === 0) {
    missing.push('CLIENT_URL');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!/^mongodb(\+srv)?:\/\//i.test(env.mongodbUri)) {
    throw new Error(
      'Invalid MONGODB_URI: connection string must start with "mongodb://" or "mongodb+srv://"',
    );
  }

  for (const origin of env.allowedOrigins) {
    if (origin === '*') {
      throw new Error(
        'Invalid CLIENT_URL: wildcard "*" is not allowed when credentials are enabled',
      );
    }

    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('Invalid CLIENT_URL: must contain valid http:// or https:// origin(s)');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid CLIENT_URL: must use http:// or https:// protocol');
    }
  }
}
