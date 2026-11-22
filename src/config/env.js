import 'dotenv/config';

const parsedPort = Number(process.env.PORT);
const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
const isProduction = nodeEnv === 'production';

const rawClientUrl = process.env.CLIENT_URL?.trim() || (isProduction ? '' : 'http://localhost:3000');
const allowedOrigins = rawClientUrl
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const betterAuthUrl =
  process.env.BETTER_AUTH_URL?.trim().replace(/\/+$/, '') ||
  (isProduction ? '' : allowedOrigins[0] || 'http://localhost:3000');

const betterAuthJwksUrl =
  process.env.BETTER_AUTH_JWKS_URL?.trim() ||
  (betterAuthUrl ? `${betterAuthUrl}/api/auth/jwks` : '');

const jwtIssuer = process.env.JWT_ISSUER?.trim().replace(/\/+$/, '') || betterAuthUrl;
const jwtAudience = process.env.JWT_AUDIENCE?.trim().replace(/\/+$/, '') || betterAuthUrl;

const rawStripePriceCents = process.env.STRIPE_PREMIUM_PRICE_CENTS?.trim();
const parsedStripePriceCents = rawStripePriceCents ? Number(rawStripePriceCents) : 2900;
const stripeCurrency = (process.env.STRIPE_CURRENCY?.trim() || 'usd').toLowerCase();

export const env = {
  port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 5000,
  nodeEnv,
  isProduction,
  clientUrl: allowedOrigins[0] || '',
  allowedOrigins,
  mongodbUri: process.env.MONGODB_URI?.trim() || '',
  dbName: process.env.DB_NAME?.trim() || '',
  betterAuthUrl,
  betterAuthJwksUrl,
  jwtIssuer,
  jwtAudience,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY?.trim() || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || '',
  stripePremiumPriceId: process.env.STRIPE_PREMIUM_PRICE_ID?.trim() || '',
  stripePremiumPriceCents: parsedStripePriceCents,
  stripeCurrency,
};

function assertValidHttpUrl(value, variableName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${variableName}: must be a valid http:// or https:// URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${variableName}: must use http:// or https:// protocol`);
  }
}

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

  if (env.isProduction && (!env.betterAuthJwksUrl || !env.jwtIssuer || !env.jwtAudience)) {
    missing.push('BETTER_AUTH_URL');
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

    assertValidHttpUrl(origin, 'CLIENT_URL');
  }

  assertValidHttpUrl(env.betterAuthJwksUrl, 'BETTER_AUTH_JWKS_URL');

  if (!env.jwtIssuer) {
    throw new Error('Missing required environment variables: JWT_ISSUER');
  }

  if (!env.jwtAudience) {
    throw new Error('Missing required environment variables: JWT_AUDIENCE');
  }

  if (!Number.isInteger(env.stripePremiumPriceCents) || env.stripePremiumPriceCents <= 0) {
    throw new Error('Invalid STRIPE_PREMIUM_PRICE_CENTS: must be a positive integer in cents');
  }

  if (!/^[a-z]{3}$/.test(env.stripeCurrency)) {
    throw new Error('Invalid STRIPE_CURRENCY: must be a 3-letter ISO currency code');
  }
}
