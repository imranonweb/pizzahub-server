import { getDB } from '../config/database.js';
import { createAuthHttpError, extractBearerToken, verifyAccessToken } from '../config/jwt.js';
import { resolveEffectiveSubscriptionPlan } from '../utils/subscription-state.js';
import { buildObjectIdOrStringFilter } from '../utils/validation.js';

export const USER_ROLES = Object.freeze({
  CUSTOMER: 'customer',
  VENDOR: 'vendor',
  ADMIN: 'admin',
});

const VALID_ROLES = new Set(Object.values(USER_ROLES));

const USER_AUTH_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  isBlocked: 1,
  businessName: 1,
  subscriptionPlan: 1,
  subscriptionStatus: 1,
  subscriptionExpiresAt: 1,
});

function toSafeUser(userDoc) {
  const normalizedRole =
    typeof userDoc.role === 'string' ? userDoc.role.trim().toLowerCase() : '';

  if (!VALID_ROLES.has(normalizedRole)) {
    return null;
  }

  return {
    id: String(userDoc._id ?? userDoc.id),
    name: typeof userDoc.name === 'string' ? userDoc.name : '',
    email: typeof userDoc.email === 'string' ? userDoc.email : '',
    image: typeof userDoc.image === 'string' ? userDoc.image : null,
    role: normalizedRole,
    isBlocked: userDoc.isBlocked === true,
    businessName: typeof userDoc.businessName === 'string' ? userDoc.businessName : '',
    subscriptionPlan: resolveEffectiveSubscriptionPlan(userDoc),
    subscriptionExpiresAt: userDoc.subscriptionExpiresAt ?? null,
  };
}

export function createAuthMiddleware(options = {}) {
  const verifyToken = options.verifyToken ?? verifyAccessToken;
  const getDatabase = options.getDatabase ?? getDB;

  return async function authenticateRequest(req, _res, next) {
    try {
      const token = extractBearerToken(req.headers.authorization);
      const verifiedToken = await verifyToken(token);

      let userDoc;
      try {
        const db = getDatabase();
        userDoc = await db
          .collection('users')
          .findOne(buildObjectIdOrStringFilter(verifiedToken.sub), {
            projection: USER_AUTH_PROJECTION,
          });
      } catch (dbError) {
        throw createAuthHttpError(503, 'Authentication service is temporarily unavailable', {
          cause: dbError,
        });
      }

      if (!userDoc) {
        throw createAuthHttpError(401, 'Account not found or no longer active');
      }

      const safeUser = toSafeUser(userDoc);
      if (!safeUser) {
        throw createAuthHttpError(403, 'Account role is not authorized');
      }

      if (safeUser.isBlocked) {
        throw createAuthHttpError(
          403,
          'Your account has been blocked. Please contact an administrator.',
        );
      }

      req.user = safeUser;
      req.auth = {
        sub: verifiedToken.sub,
        iat: verifiedToken.iat,
        exp: verifiedToken.exp,
      };

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export const requireAuth = createAuthMiddleware();

export function requireNotBlocked(req, _res, next) {
  if (!req.user) {
    return next(createAuthHttpError(401, 'Authentication required'));
  }

  if (req.user.isBlocked === true) {
    return next(
      createAuthHttpError(403, 'Your account has been blocked. Please contact an administrator.'),
    );
  }

  return next();
}

export function requireRole(...allowedRoles) {
  const normalizedRoles = allowedRoles
    .flat()
    .map((role) => (typeof role === 'string' ? role.trim().toLowerCase() : ''));

  if (
    normalizedRoles.length === 0 ||
    normalizedRoles.some((role) => !VALID_ROLES.has(role))
  ) {
    throw new Error('requireRole requires one or more valid PizzaHub roles');
  }

  const allowedRoleSet = new Set(normalizedRoles);

  return function authorizeRole(req, _res, next) {
    if (!req.user) {
      return next(createAuthHttpError(401, 'Authentication required'));
    }

    if (req.user.isBlocked === true) {
      return next(
        createAuthHttpError(
          403,
          'Your account has been blocked. Please contact an administrator.',
        ),
      );
    }

    if (!allowedRoleSet.has(req.user.role)) {
      return next(createAuthHttpError(403, 'You do not have permission to access this resource'));
    }

    return next();
  };
}

export const requireCustomer = requireRole(USER_ROLES.CUSTOMER);
export const requireVendor = requireRole(USER_ROLES.VENDOR);
export const requireAdmin = requireRole(USER_ROLES.ADMIN);
