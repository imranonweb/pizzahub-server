import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ObjectId } from 'mongodb';
import app from '../src/app.js';
import { resetJwksCache, verifyAccessToken } from '../src/config/jwt.js';
import {
  createAuthMiddleware,
  requireAdmin,
  requireCustomer,
  requireNotBlocked,
  requireRole,
  requireVendor,
  USER_ROLES,
} from '../src/middleware/auth.middleware.js';
import { errorMiddleware } from '../src/middleware/error.middleware.js';
import { notFoundMiddleware } from '../src/middleware/not-found.middleware.js';

const TEST_ISSUER = 'http://localhost:3000';
const TEST_AUDIENCE = 'http://localhost:3000';

let jwksServer;
let jwksUrl;
let apiServer;
let apiBaseUrl;

let primaryKeyPair;
let primaryPublicJwk;
let rotatedKeyPair;
let rotatedPublicJwk;
let untrustedKeyPair;

let jwksMode = 'normal';
let jwksHitCount = 0;
let activeKeys = [];
let dbMode = 'normal';
let usersById = new Map();

const customerObjectId = new ObjectId();
const vendorObjectId = new ObjectId();
const adminObjectId = new ObjectId();
const blockedObjectId = new ObjectId();
const deletedObjectId = new ObjectId();

function matchesUserId(doc, clause) {
  if ('_id' in clause) {
    if (clause._id instanceof ObjectId && doc._id instanceof ObjectId) {
      return doc._id.equals(clause._id);
    }
    return doc._id === clause._id;
  }

  if ('id' in clause) {
    return doc.id === clause.id;
  }

  return false;
}

function projectDoc(doc, projection) {
  if (!projection) {
    return { ...doc };
  }

  const projected = {};
  for (const [key, include] of Object.entries(projection)) {
    if (include && key in doc) {
      projected[key] = doc[key];
    }
  }
  return projected;
}

function getMockDatabase() {
  return {
    collection(name) {
      assert.equal(name, 'users');
      return {
        async findOne(filter, options = {}) {
          if (dbMode === 'error') {
            throw new Error(
              'MongoNetworkError: mongodb+srv://admin:SecretPass123@cluster.mongodb.net/pizzahub failed',
            );
          }

          const clauses = Array.isArray(filter?.$or) ? filter.$or : [filter];
          for (const doc of usersById.values()) {
            if (clauses.some((clause) => matchesUserId(doc, clause))) {
              return projectDoc(doc, options.projection);
            }
          }

          return null;
        },
      };
    },
  };
}

async function signTestToken({
  sub,
  email = 'user@pizzahub.test',
  issuer = TEST_ISSUER,
  audience = TEST_AUDIENCE,
  expiresIn = '15m',
  iat = Math.floor(Date.now() / 1000),
  exp,
  kid = 'key-primary',
  privateKey = primaryKeyPair.privateKey,
  extraClaims = {},
}) {
  const builder = new SignJWT({
    ...extraClaims,
    sub,
    email,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setSubject(sub);

  if (issuer !== null) {
    builder.setIssuer(issuer);
  }
  if (audience !== null) {
    builder.setAudience(audience);
  }
  if (iat !== null) {
    builder.setIssuedAt(iat);
  }
  if (exp !== undefined) {
    builder.setExpirationTime(exp);
  } else if (expiresIn !== null) {
    builder.setExpirationTime(expiresIn);
  }

  return builder.sign(privateKey);
}

async function requestApi(path, { token, origin, method = 'GET' } = {}) {
  const headers = {};
  if (token !== undefined) {
    headers.Authorization = token;
  }
  if (origin) {
    headers.Origin = origin;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, { method, headers });
  const body = await response.json();
  return { status: response.status, headers: response.headers, body };
}

before(async () => {
  primaryKeyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  primaryPublicJwk = {
    ...(await exportJWK(primaryKeyPair.publicKey)),
    kid: 'key-primary',
    alg: 'EdDSA',
    use: 'sig',
  };

  rotatedKeyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  rotatedPublicJwk = {
    ...(await exportJWK(rotatedKeyPair.publicKey)),
    kid: 'key-rotated',
    alg: 'EdDSA',
    use: 'sig',
  };

  untrustedKeyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });

  jwksServer = http.createServer((req, res) => {
    if (req.url !== '/api/auth/jwks') {
      res.writeHead(404);
      res.end();
      return;
    }

    jwksHitCount += 1;

    if (jwksMode === 'http500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'JWKS upstream failure' }));
      return;
    }

    if (jwksMode === 'bad-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-valid-json');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: activeKeys }));
  });

  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const jwksAddr = jwksServer.address();
  jwksUrl = `http://127.0.0.1:${jwksAddr.port}/api/auth/jwks`;

  const requireTestAuth = createAuthMiddleware({
    verifyToken: (token) =>
      verifyAccessToken(token, {
        jwksUrl,
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
      }),
    getDatabase: getMockDatabase,
  });

  const testApp = express();
  testApp.use(helmet());
  testApp.use(
    cors({
      origin: 'http://localhost:3000',
      credentials: true,
    }),
  );
  testApp.use(express.json());

  testApp.get('/protected/me', requireTestAuth, requireNotBlocked, (req, res) => {
    res.status(200).json({ success: true, user: req.user, auth: req.auth });
  });

  testApp.get('/protected/customer', requireTestAuth, requireCustomer, (req, res) => {
    res.status(200).json({ success: true, role: req.user.role });
  });

  testApp.get('/protected/vendor', requireTestAuth, requireVendor, (req, res) => {
    res.status(200).json({ success: true, role: req.user.role });
  });

  testApp.get('/protected/admin', requireTestAuth, requireAdmin, (req, res) => {
    res.status(200).json({ success: true, role: req.user.role });
  });

  testApp.get(
    '/protected/vendor-or-admin',
    requireTestAuth,
    requireRole(USER_ROLES.VENDOR, USER_ROLES.ADMIN),
    (req, res) => {
      res.status(200).json({ success: true, role: req.user.role });
    },
  );

  testApp.use(notFoundMiddleware);
  testApp.use(errorMiddleware);

  apiServer = http.createServer(testApp);
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiAddr = apiServer.address();
  apiBaseUrl = `http://127.0.0.1:${apiAddr.port}`;
});

beforeEach(() => {
  resetJwksCache();
  jwksMode = 'normal';
  jwksHitCount = 0;
  activeKeys = [primaryPublicJwk];
  dbMode = 'normal';

  usersById = new Map([
    [
      customerObjectId.toHexString(),
      {
        _id: customerObjectId,
        name: 'Ayesha Customer',
        email: 'customer@pizzahub.test',
        image: 'https://img.example.com/customer.png',
        role: 'customer',
        isBlocked: false,
        businessName: '',
        subscriptionPlan: 'free',
        subscriptionExpiresAt: null,
        passwordHash: 'internal-secret-hash',
      },
    ],
    [
      vendorObjectId.toHexString(),
      {
        _id: vendorObjectId,
        name: 'Rahim Vendor',
        email: 'vendor@pizzahub.test',
        image: null,
        role: 'vendor',
        isBlocked: false,
        businessName: 'Dhaka Crust Kitchen',
        subscriptionPlan: 'premium',
        subscriptionExpiresAt: null,
        passwordHash: 'internal-secret-hash',
      },
    ],
    [
      adminObjectId.toHexString(),
      {
        _id: adminObjectId,
        name: 'Nadia Admin',
        email: 'admin@pizzahub.test',
        image: null,
        role: 'admin',
        isBlocked: false,
        businessName: '',
        subscriptionPlan: 'free',
        subscriptionExpiresAt: null,
      },
    ],
    [
      blockedObjectId.toHexString(),
      {
        _id: blockedObjectId,
        name: 'Blocked User',
        email: 'blocked@pizzahub.test',
        image: null,
        role: 'customer',
        isBlocked: true,
        businessName: '',
        subscriptionPlan: 'free',
        subscriptionExpiresAt: null,
      },
    ],
  ]);
});

after(async () => {
  resetJwksCache();
  await Promise.all([
    apiServer ? new Promise((resolve) => apiServer.close(resolve)) : Promise.resolve(),
    jwksServer ? new Promise((resolve) => jwksServer.close(resolve)) : Promise.resolve(),
  ]);
});

describe('Authentication, JWT verification, and authorization middleware', () => {
  it('rejects requests with missing Authorization header (401)', async () => {
    const res = await requestApi('/protected/me');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, {
      success: false,
      message: 'Authentication required',
    });
  });

  it('rejects malformed Authorization headers and non-compact JWTs (401)', async () => {
    const basicRes = await requestApi('/protected/me', { token: 'Basic abc123' });
    assert.equal(basicRes.status, 401);
    assert.equal(basicRes.body.message, 'Malformed authorization header');

    const emptyBearer = await requestApi('/protected/me', { token: 'Bearer   ' });
    assert.equal(emptyBearer.status, 401);
    assert.equal(emptyBearer.body.message, 'Malformed authorization header');

    const twoPartToken = await requestApi('/protected/me', { token: 'Bearer header.payload' });
    assert.equal(twoPartToken.status, 401);
    assert.equal(twoPartToken.body.message, 'Malformed authentication token');

    const corruptedJwt = await requestApi('/protected/me', {
      token: 'Bearer invalidheader.invalidpayload.invalidsignature',
    });
    assert.equal(corruptedJwt.status, 401);
    assert.equal(corruptedJwt.body.message, 'Invalid authentication token');
  });

  it('rejects JWTs signed by an untrusted key (401)', async () => {
    const token = await signTestToken({
      sub: customerObjectId.toHexString(),
      privateKey: untrustedKeyPair.privateKey,
    });

    const res = await requestApi('/protected/me', { token: `Bearer ${token}` });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid authentication token signature');
  });

  it('rejects JWTs signed with disallowed algorithms such as HS256 (401)', async () => {
    const hs256Token = await new SignJWT({ sub: customerObjectId.toHexString() })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-primary' })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('super-secret-hmac-key-for-testing-only'));

    const res = await requestApi('/protected/me', { token: `Bearer ${hs256Token}` });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid authentication token');
  });

  it('rejects expired JWTs (401)', async () => {
    const pastSeconds = Math.floor(Date.now() / 1000) - 3600;
    const token = await signTestToken({
      sub: customerObjectId.toHexString(),
      iat: pastSeconds - 900,
      exp: pastSeconds,
    });

    const res = await requestApi('/protected/me', { token: `Bearer ${token}` });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Authentication token has expired');
  });

  it('rejects JWTs with wrong issuer or wrong audience (401)', async () => {
    const wrongIssuerToken = await signTestToken({
      sub: customerObjectId.toHexString(),
      issuer: 'https://evil-issuer.example.com',
    });
    const issuerRes = await requestApi('/protected/me', { token: `Bearer ${wrongIssuerToken}` });
    assert.equal(issuerRes.status, 401);
    assert.equal(issuerRes.body.message, 'Invalid authentication token claims');

    const wrongAudienceToken = await signTestToken({
      sub: customerObjectId.toHexString(),
      audience: 'https://wrong-audience.example.com',
    });
    const audienceRes = await requestApi('/protected/me', {
      token: `Bearer ${wrongAudienceToken}`,
    });
    assert.equal(audienceRes.status, 401);
    assert.equal(audienceRes.body.message, 'Invalid authentication token claims');
  });

  it('authenticates a valid customer from MongoDB and ignores spoofed JWT role/plan claims', async () => {
    const token = await signTestToken({
      sub: customerObjectId.toHexString(),
      email: 'customer@pizzahub.test',
      extraClaims: {
        role: 'admin',
        subscriptionPlan: 'premium',
      },
    });

    const meRes = await requestApi('/protected/me', { token: `Bearer ${token}` });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.success, true);
    assert.equal(meRes.body.user.id, customerObjectId.toHexString());
    assert.equal(meRes.body.user.role, 'customer');
    assert.equal(meRes.body.user.subscriptionPlan, 'free');
    assert.equal(meRes.body.user.isBlocked, false);
    assert.equal('passwordHash' in meRes.body.user, false);

    const customerRes = await requestApi('/protected/customer', { token: `Bearer ${token}` });
    assert.equal(customerRes.status, 200);
    assert.equal(customerRes.body.role, 'customer');

    const vendorRes = await requestApi('/protected/vendor', { token: `Bearer ${token}` });
    assert.equal(vendorRes.status, 403);

    const adminRes = await requestApi('/protected/admin', { token: `Bearer ${token}` });
    assert.equal(adminRes.status, 403);
  });

  it('authenticates and authorizes a valid vendor and enforces role boundaries', async () => {
    const token = await signTestToken({
      sub: vendorObjectId.toHexString(),
      email: 'vendor@pizzahub.test',
    });

    const meRes = await requestApi('/protected/me', { token: `Bearer ${token}` });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.user.role, 'vendor');
    assert.equal(meRes.body.user.businessName, 'Dhaka Crust Kitchen');
    assert.equal(meRes.body.user.subscriptionPlan, 'premium');

    const vendorRes = await requestApi('/protected/vendor', { token: `Bearer ${token}` });
    assert.equal(vendorRes.status, 200);

    const multiRes = await requestApi('/protected/vendor-or-admin', { token: `Bearer ${token}` });
    assert.equal(multiRes.status, 200);

    const customerRes = await requestApi('/protected/customer', { token: `Bearer ${token}` });
    assert.equal(customerRes.status, 403);

    const adminRes = await requestApi('/protected/admin', { token: `Bearer ${token}` });
    assert.equal(adminRes.status, 403);
  });

  it('authenticates and authorizes a valid admin and enforces role boundaries', async () => {
    const token = await signTestToken({
      sub: adminObjectId.toHexString(),
      email: 'admin@pizzahub.test',
    });

    const adminRes = await requestApi('/protected/admin', { token: `Bearer ${token}` });
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.body.role, 'admin');

    const multiRes = await requestApi('/protected/vendor-or-admin', { token: `Bearer ${token}` });
    assert.equal(multiRes.status, 200);

    const customerRes = await requestApi('/protected/customer', { token: `Bearer ${token}` });
    assert.equal(customerRes.status, 403);

    const vendorRes = await requestApi('/protected/vendor', { token: `Bearer ${token}` });
    assert.equal(vendorRes.status, 403);
  });

  it('rejects blocked users from MongoDB (403)', async () => {
    const token = await signTestToken({
      sub: blockedObjectId.toHexString(),
      email: 'blocked@pizzahub.test',
    });

    const res = await requestApi('/protected/me', { token: `Bearer ${token}` });
    assert.equal(res.status, 403);
    assert.equal(
      res.body.message,
      'Your account has been blocked. Please contact an administrator.',
    );

    // Also verify standalone requireNotBlocked rejects a blocked req.user
    let nextErr;
    requireNotBlocked({ user: { id: '1', role: 'customer', isBlocked: true } }, {}, (err) => {
      nextErr = err;
    });
    assert.equal(nextErr?.statusCode, 403);
  });

  it('rejects deleted or missing user accounts even with a valid signed JWT (401)', async () => {
    const token = await signTestToken({
      sub: deletedObjectId.toHexString(),
      email: 'deleted@pizzahub.test',
    });

    const res = await requestApi('/protected/me', { token: `Bearer ${token}` });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Account not found or no longer active');
  });

  it('fails securely when the JWKS endpoint returns an error or is unreachable (503)', async () => {
    const token = await signTestToken({ sub: customerObjectId.toHexString() });

    jwksMode = 'http500';
    const httpErrRes = await requestApi('/protected/me', { token: `Bearer ${token}` });
    assert.equal(httpErrRes.status, 503);
    assert.deepEqual(httpErrRes.body, {
      success: false,
      message: 'Authentication service is temporarily unavailable',
    });

    // Unreachable JWKS endpoint check via verifyAccessToken
    resetJwksCache();
    await assert.rejects(
      () =>
        verifyAccessToken(token, {
          jwksUrl: 'http://127.0.0.1:1/api/auth/jwks',
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE,
        }),
      (err) => err?.statusCode === 503 && err?.isOperational === true,
    );
  });

  it('fails securely on database lookup errors without leaking credentials (503)', async () => {
    const token = await signTestToken({ sub: customerObjectId.toHexString() });
    dbMode = 'error';

    const res = await requestApi('/protected/me', { token: `Bearer ${token}` });
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, {
      success: false,
      message: 'Authentication service is temporarily unavailable',
    });
    assert.equal(JSON.stringify(res.body).includes('SecretPass123'), false);
  });

  it('caches JWKS keys across requests and supports key rotation', async () => {
    const token1 = await signTestToken({ sub: customerObjectId.toHexString() });
    const token2 = await signTestToken({ sub: vendorObjectId.toHexString() });

    const r1 = await requestApi('/protected/me', { token: `Bearer ${token1}` });
    const r2 = await requestApi('/protected/me', { token: `Bearer ${token2}` });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(jwksHitCount, 1);

    // Rotate JWKS to new key and reset cache so key refresh runs cleanly
    activeKeys = [rotatedPublicJwk];
    resetJwksCache();
    const rotatedToken = await signTestToken({
      sub: adminObjectId.toHexString(),
      kid: 'key-rotated',
      privateKey: rotatedKeyPair.privateKey,
    });
    const r3 = await requestApi('/protected/me', { token: `Bearer ${rotatedToken}` });
    assert.equal(r3.status, 200);
    assert.equal(r3.body.user.role, 'admin');
    assert.equal(jwksHitCount, 2);
  });

  it('validates requireRole helper rejects invalid configuration at setup time', () => {
    assert.throws(() => requireRole(), /requires one or more valid PizzaHub roles/);
    assert.throws(() => requireRole('superadmin'), /requires one or more valid PizzaHub roles/);
  });

  it('preserves existing app security headers, CORS, 404, and production env validation', async () => {
    const mainAppServer = http.createServer(app);
    await new Promise((resolve) => mainAppServer.listen(0, '127.0.0.1', resolve));

    try {
      const addr = mainAppServer.address();
      const base = `http://127.0.0.1:${addr.port}`;

      const notFoundRes = await fetch(`${base}/api/unknown-check`, {
        headers: { Origin: 'http://localhost:3000' },
      });
      assert.equal(notFoundRes.status, 404);
      assert.equal(notFoundRes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(notFoundRes.headers.get('access-control-allow-origin'), 'http://localhost:3000');

      const badOriginRes = await fetch(`${base}/api/unknown-check`, {
        headers: { Origin: 'https://evil.example.com' },
      });
      assert.equal(badOriginRes.status, 403);
    } finally {
      await new Promise((resolve) => mainAppServer.close(resolve));
    }

    const prodMissingAuth = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', 'import { validateEnv } from "./src/config/env.js"; validateEnv();'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          CLIENT_URL: 'https://pizzahub.example.com',
          MONGODB_URI: 'mongodb://127.0.0.1:27017',
          DB_NAME: 'pizzahub',
          BETTER_AUTH_URL: '',
          BETTER_AUTH_JWKS_URL: '',
          JWT_ISSUER: '',
          JWT_AUDIENCE: '',
        },
        encoding: 'utf8',
      },
    );

    assert.notEqual(prodMissingAuth.status, 0);
    assert.match(prodMissingAuth.stderr, /BETTER_AUTH_URL/);
  });
});
