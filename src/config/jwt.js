import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from './env.js';

export const ALLOWED_JWT_ALGORITHMS = Object.freeze(['EdDSA']);
export const REQUIRED_JWT_CLAIMS = Object.freeze(['sub', 'exp', 'iat']);
export const JWKS_OPTIONS = Object.freeze({
  timeoutDuration: 5000,
  cooldownDuration: 30000,
  cacheMaxAge: 600000,
});

const COMPACT_JWS_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/;

const CLIENT_TOKEN_ERROR_MAP = Object.freeze({
  ERR_JWT_EXPIRED: {
    statusCode: 401,
    message: 'Authentication token has expired',
  },
  ERR_JWT_CLAIM_VALIDATION_FAILED: {
    statusCode: 401,
    message: 'Invalid authentication token claims',
  },
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: {
    statusCode: 401,
    message: 'Invalid authentication token signature',
  },
  ERR_JWS_INVALID: {
    statusCode: 401,
    message: 'Invalid authentication token',
  },
  ERR_JWT_INVALID: {
    statusCode: 401,
    message: 'Invalid authentication token',
  },
  ERR_JOSE_ALG_NOT_ALLOWED: {
    statusCode: 401,
    message: 'Invalid authentication token',
  },
  ERR_JOSE_NOT_SUPPORTED: {
    statusCode: 401,
    message: 'Invalid authentication token',
  },
  ERR_JWKS_NO_MATCHING_KEY: {
    statusCode: 401,
    message: 'Invalid authentication token',
  },
  ERR_JWKS_MULTIPLE_MATCHING_KEYS: {
    statusCode: 401,
    message: 'Invalid authentication token',
  },
});

let cachedJwks = null;
let cachedJwksUrl = null;
let cachedJwksOptions = null;

export function createAuthHttpError(statusCode, message, options = {}) {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined);
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
}

export function getJwks(jwksUrl = env.betterAuthJwksUrl, jwksOptions = JWKS_OPTIONS) {
  if (!jwksUrl) {
    throw createAuthHttpError(503, 'Authentication service is not configured');
  }

  if (cachedJwks && cachedJwksUrl === jwksUrl && cachedJwksOptions === jwksOptions) {
    return cachedJwks;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(jwksUrl);
  } catch {
    throw createAuthHttpError(503, 'Authentication service is not configured');
  }

  cachedJwks = createRemoteJWKSet(parsedUrl, jwksOptions);
  cachedJwksUrl = jwksUrl;
  cachedJwksOptions = jwksOptions;
  return cachedJwks;
}

export function resetJwksCache() {
  cachedJwks = null;
  cachedJwksUrl = null;
  cachedJwksOptions = null;
}

export function extractBearerToken(authorizationHeader) {
  if (
    authorizationHeader === undefined ||
    authorizationHeader === null ||
    (typeof authorizationHeader === 'string' && authorizationHeader.trim() === '')
  ) {
    throw createAuthHttpError(401, 'Authentication required');
  }

  if (typeof authorizationHeader !== 'string') {
    throw createAuthHttpError(401, 'Malformed authorization header');
  }

  const match = authorizationHeader.trim().match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    throw createAuthHttpError(401, 'Malformed authorization header');
  }

  const token = match[1];
  const segments = token.split('.');
  if (
    segments.length !== 3 ||
    segments.some((segment) => !COMPACT_JWS_SEGMENT_REGEX.test(segment))
  ) {
    throw createAuthHttpError(401, 'Malformed authentication token');
  }

  return token;
}

export async function verifyAccessToken(token, options = {}) {
  const issuer = options.issuer ?? env.jwtIssuer;
  const audience = options.audience ?? env.jwtAudience;
  const algorithms = options.algorithms ?? ALLOWED_JWT_ALGORITHMS;

  if (!issuer || !audience) {
    throw createAuthHttpError(503, 'Authentication service is not configured');
  }

  const keyResolver =
    options.jwks ??
    getJwks(options.jwksUrl ?? env.betterAuthJwksUrl, options.jwksOptions ?? JWKS_OPTIONS);

  try {
    const { payload } = await jwtVerify(token, keyResolver, {
      issuer,
      audience,
      algorithms: [...algorithms],
      requiredClaims: [...REQUIRED_JWT_CLAIMS],
    });

    if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
      throw createAuthHttpError(401, 'Invalid authentication token claims');
    }

    return {
      sub: payload.sub.trim(),
      email: typeof payload.email === 'string' ? payload.email : null,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch (error) {
    if (error?.isOperational && Number.isInteger(error?.statusCode)) {
      throw error;
    }

    const mapped = typeof error?.code === 'string' ? CLIENT_TOKEN_ERROR_MAP[error.code] : null;
    if (mapped) {
      throw createAuthHttpError(mapped.statusCode, mapped.message, { cause: error });
    }

    throw createAuthHttpError(503, 'Authentication service is temporarily unavailable', {
      cause: error,
    });
  }
}
