import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ObjectId } from 'mongodb';
import app from '../src/app.js';
import { resetJwksCache, verifyAccessToken } from '../src/config/jwt.js';
import { createAuthMiddleware } from '../src/middleware/auth.middleware.js';
import { errorMiddleware } from '../src/middleware/error.middleware.js';
import { notFoundMiddleware } from '../src/middleware/not-found.middleware.js';
import { createAdminUsersRouter } from '../src/routes/admin-users.routes.js';
import { createProfileRouter } from '../src/routes/profile.routes.js';

const TEST_ISSUER = 'http://localhost:3000';
const TEST_AUDIENCE = 'http://localhost:3000';

let jwksServer;
let jwksUrl;
let apiServer;
let apiBaseUrl;

let keyPair;
let publicJwk;
let userRecords = [];

const customerId = new ObjectId('674000000000000000000001');
const vendorId = new ObjectId('674000000000000000000002');
const adminId = new ObjectId('674000000000000000000003');
const customerTwoId = new ObjectId('674000000000000000000004');
const blockedVendorId = new ObjectId('674000000000000000000005');
const missingUserId = new ObjectId('674000000000000000000099');

function matchesFilter(doc, filter) {
  if (!filter || Object.keys(filter).length === 0) {
    return true;
  }

  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$or') {
      if (!Array.isArray(condition) || !condition.some((clause) => matchesFilter(doc, clause))) {
        return false;
      }
      continue;
    }

    const docVal = doc[key];
    if (condition instanceof RegExp) {
      if (typeof docVal !== 'string' || !condition.test(docVal)) {
        return false;
      }
    } else if (condition instanceof ObjectId) {
      if (!(docVal instanceof ObjectId) || !docVal.equals(condition)) {
        return false;
      }
    } else if (condition && typeof condition === 'object' && '$ne' in condition) {
      if (docVal === condition.$ne) {
        return false;
      }
    } else if (docVal !== condition) {
      return false;
    }
  }

  return true;
}

function applyProjection(doc, projection) {
  if (!projection) {
    return { ...doc };
  }

  const out = {};
  for (const [key, include] of Object.entries(projection)) {
    if (include && key in doc) {
      out[key] = doc[key];
    }
  }
  return out;
}

function getMockDatabase() {
  return {
    collection(name) {
      assert.equal(name, 'users');
      return {
        async findOne(filter, options = {}) {
          const match = userRecords.find((doc) => matchesFilter(doc, filter));
          return match ? applyProjection(match, options.projection) : null;
        },

        async findOneAndUpdate(filter, update, options = {}) {
          const match = userRecords.find((doc) => matchesFilter(doc, filter));
          if (!match) {
            return null;
          }

          if (update?.$set) {
            Object.assign(match, update.$set);
          }

          return applyProjection(match, options.projection);
        },

        find(filter = {}, options = {}) {
          let results = userRecords.filter((doc) => matchesFilter(doc, filter));
          let skipCount = 0;
          let limitCount = results.length;

          const cursor = {
            sort(sortSpec) {
              results = [...results].sort((a, b) => {
                for (const [field, dir] of Object.entries(sortSpec)) {
                  const aVal =
                    a[field] instanceof Date
                      ? a[field].getTime()
                      : a[field] instanceof ObjectId
                        ? a[field].toHexString()
                        : a[field];
                  const bVal =
                    b[field] instanceof Date
                      ? b[field].getTime()
                      : b[field] instanceof ObjectId
                        ? b[field].toHexString()
                        : b[field];

                  if (aVal < bVal) return dir < 0 ? 1 : -1;
                  if (aVal > bVal) return dir < 0 ? -1 : 1;
                }
                return 0;
              });
              return cursor;
            },
            skip(n) {
              skipCount = n;
              return cursor;
            },
            limit(n) {
              limitCount = n;
              return cursor;
            },
            async toArray() {
              return results
                .slice(skipCount, skipCount + limitCount)
                .map((doc) => applyProjection(doc, options.projection));
            },
          };

          return cursor;
        },

        async countDocuments(filter = {}) {
          return userRecords.filter((doc) => matchesFilter(doc, filter)).length;
        },
      };
    },
  };
}

async function signUserToken(userId, email) {
  return new SignJWT({ sub: userId, email })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'user-api-key' })
    .setSubject(userId)
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(keyPair.privateKey);
}

async function callApi(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();
  return { status: response.status, body: payload };
}

function assertNoSensitiveFields(userObj) {
  for (const forbidden of [
    '_id',
    'password',
    'passwordHash',
    'sessions',
    'accounts',
    'tokens',
    'twoFactorSecret',
  ]) {
    assert.equal(forbidden in userObj, false, `Unexpected sensitive field exposed: ${forbidden}`);
  }
}

before(async () => {
  keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: 'user-api-key',
    alg: 'EdDSA',
    use: 'sig',
  };

  jwksServer = http.createServer((req, res) => {
    if (req.url === '/api/auth/jwks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/api/auth/jwks`;

  const authMiddleware = createAuthMiddleware({
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
  testApp.use(cors({ origin: 'http://localhost:3000', credentials: true }));
  testApp.use(express.json());

  testApp.use('/api/profile', createProfileRouter({ authMiddleware, getDatabase: getMockDatabase }));
  testApp.use(
    '/api/admin/users',
    createAdminUsersRouter({ authMiddleware, getDatabase: getMockDatabase }),
  );
  testApp.use(notFoundMiddleware);
  testApp.use(errorMiddleware);

  apiServer = http.createServer(testApp);
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
});

beforeEach(() => {
  resetJwksCache();
  userRecords = [
    {
      _id: customerId,
      name: 'Ayesha Rahman',
      email: 'ayesha@pizzahub.test',
      image: 'https://cdn.pizzahub.test/ayesha.png',
      role: 'customer',
      isBlocked: false,
      businessName: '',
      contactPhone: '+8801711000001',
      deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
      subscriptionPlan: 'free',
      subscriptionExpiresAt: null,
      emailVerified: true,
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
      updatedAt: new Date('2026-11-01T10:00:00.000Z'),
      passwordHash: 'secret-bcrypt-hash',
      sessions: ['session-secret-1'],
      twoFactorSecret: 'totp-secret',
    },
    {
      _id: vendorId,
      name: 'Rahim Uddin',
      email: 'rahim.oven@pizzahub.test',
      image: null,
      role: 'vendor',
      isBlocked: false,
      businessName: 'Brick Oven Crust',
      contactPhone: '+8801711000002',
      deliveryAddress: '',
      subscriptionPlan: 'premium',
      subscriptionExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
      emailVerified: true,
      createdAt: new Date('2026-11-02T10:00:00.000Z'),
      updatedAt: new Date('2026-11-02T10:00:00.000Z'),
      passwordHash: 'secret-vendor-hash',
      tokens: ['secret-token'],
    },
    {
      _id: adminId,
      name: 'Nadia Karim',
      email: 'admin@pizzahub.test',
      image: null,
      role: 'admin',
      isBlocked: false,
      businessName: '',
      contactPhone: '',
      deliveryAddress: '',
      subscriptionPlan: 'free',
      subscriptionExpiresAt: null,
      emailVerified: true,
      createdAt: new Date('2026-11-03T10:00:00.000Z'),
      updatedAt: new Date('2026-11-03T10:00:00.000Z'),
      passwordHash: 'secret-admin-hash',
    },
    {
      _id: customerTwoId,
      name: 'Tariq+Plus Hasan',
      email: 'tariq+vip@pizzahub.test',
      image: null,
      role: 'customer',
      isBlocked: false,
      businessName: '',
      contactPhone: '',
      deliveryAddress: '',
      subscriptionPlan: 'free',
      subscriptionExpiresAt: null,
      emailVerified: false,
      createdAt: new Date('2026-11-04T10:00:00.000Z'),
      updatedAt: new Date('2026-11-04T10:00:00.000Z'),
    },
    {
      _id: blockedVendorId,
      name: 'Blocked Pizzeria',
      email: 'blocked.vendor@pizzahub.test',
      image: null,
      role: 'vendor',
      isBlocked: true,
      businessName: 'Locked Kitchen',
      contactPhone: '',
      deliveryAddress: '',
      subscriptionPlan: 'free',
      subscriptionExpiresAt: null,
      emailVerified: true,
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
      updatedAt: new Date('2026-11-05T10:00:00.000Z'),
    },
  ];
});

after(async () => {
  resetJwksCache();
  await Promise.all([
    apiServer ? new Promise((resolve) => apiServer.close(resolve)) : Promise.resolve(),
    jwksServer ? new Promise((resolve) => jwksServer.close(resolve)) : Promise.resolve(),
  ]);
});

describe('User Profile APIs (/api/profile)', () => {
  it('retrieves the authenticated user profile and excludes sensitive fields', async () => {
    const token = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');
    const res = await callApi('/api/profile', { token });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.profile.id, customerId.toHexString());
    assert.equal(res.body.profile.name, 'Ayesha Rahman');
    assert.equal(res.body.profile.contactPhone, '+8801711000001');
    assert.equal(res.body.profile.deliveryAddress, 'House 12, Road 4, Banani, Dhaka');
    assert.equal(res.body.profile.subscriptionPlan, 'free');
    assertNoSensitiveFields(res.body.profile);
  });

  it('updates allowed editable profile fields for customer and vendor accounts', async () => {
    const customerToken = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');
    const customerRes = await callApi('/api/profile', {
      method: 'PATCH',
      token: customerToken,
      body: {
        name: '  Ayesha Siddiqua  ',
        image: 'https://i.ibb.co/example/avatar.png',
        contactPhone: '+880 1811-223344',
        deliveryAddress: 'Apartment 5B, Gulshan Avenue, Dhaka',
      },
    });

    assert.equal(customerRes.status, 200);
    assert.equal(customerRes.body.success, true);
    assert.equal(customerRes.body.profile.name, 'Ayesha Siddiqua');
    assert.equal(customerRes.body.profile.image, 'https://i.ibb.co/example/avatar.png');
    assert.equal(customerRes.body.profile.contactPhone, '+880 1811-223344');
    assert.equal(
      customerRes.body.profile.deliveryAddress,
      'Apartment 5B, Gulshan Avenue, Dhaka',
    );
    assertNoSensitiveFields(customerRes.body.profile);

    // Vendor can update businessName
    const vendorToken = await signUserToken(vendorId.toHexString(), 'rahim.oven@pizzahub.test');
    const vendorRes = await callApi('/api/profile', {
      method: 'PATCH',
      token: vendorToken,
      body: {
        businessName: 'Brick Oven Crust Express',
        image: '',
      },
    });

    assert.equal(vendorRes.status, 200);
    assert.equal(vendorRes.body.profile.businessName, 'Brick Oven Crust Express');
    assert.equal(vendorRes.body.profile.image, null);

    // Customer cannot update vendor-only businessName
    const nonVendorBusinessRes = await callApi('/api/profile', {
      method: 'PATCH',
      token: customerToken,
      body: {
        businessName: 'Fake Kitchen',
      },
    });
    assert.equal(nonVendorBusinessRes.status, 403);
  });

  it('validates editable profile fields and rejects empty or invalid payloads (400)', async () => {
    const token = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');

    const emptyRes = await callApi('/api/profile', { method: 'PATCH', token, body: {} });
    assert.equal(emptyRes.status, 400);

    const badPhoneRes = await callApi('/api/profile', {
      method: 'PATCH',
      token,
      body: { contactPhone: '123', deliveryAddress: 'short' },
    });
    assert.equal(badPhoneRes.status, 400);
    assert.equal(typeof badPhoneRes.body.errors?.contactPhone, 'string');
    assert.equal(typeof badPhoneRes.body.errors?.deliveryAddress, 'string');

    const insecureAvatarRes = await callApi('/api/profile', {
      method: 'PATCH',
      token,
      body: { image: 'http://insecure.example.com/pic.png' },
    });
    assert.equal(insecureAvatarRes.status, 400);
  });

  it('rejects attempted role escalation, subscription modification, and blocked/internal field tampering (403)', async () => {
    const token = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');

    const roleAttempt = await callApi('/api/profile', {
      method: 'PATCH',
      token,
      body: { name: 'Valid Name', role: 'admin' },
    });
    assert.equal(roleAttempt.status, 403);

    const subPlanAttempt = await callApi('/api/profile', {
      method: 'PATCH',
      token,
      body: { subscriptionPlan: 'premium' },
    });
    assert.equal(subPlanAttempt.status, 403);

    const subExpiryAttempt = await callApi('/api/profile', {
      method: 'PATCH',
      token,
      body: { subscriptionExpiresAt: '2030-01-01T00:00:00.000Z' },
    });
    assert.equal(subExpiryAttempt.status, 403);

    const blockedAttempt = await callApi('/api/profile', {
      method: 'PATCH',
      token,
      body: { isBlocked: false },
    });
    assert.equal(blockedAttempt.status, 403);

    const emailAttempt = await callApi('/api/profile', {
      method: 'PATCH',
      token,
      body: { email: 'hijack@pizzahub.test' },
    });
    assert.equal(emailAttempt.status, 403);

    // Verify DB document stayed untouched
    const stored = userRecords.find((u) => u._id.equals(customerId));
    assert.equal(stored.role, 'customer');
    assert.equal(stored.subscriptionPlan, 'free');
    assert.equal(stored.email, 'ayesha@pizzahub.test');
  });

  it('rejects unauthenticated and blocked requests to profile routes', async () => {
    const unauthGet = await callApi('/api/profile');
    assert.equal(unauthGet.status, 401);

    const blockedToken = await signUserToken(
      blockedVendorId.toHexString(),
      'blocked.vendor@pizzahub.test',
    );
    const blockedGet = await callApi('/api/profile', { token: blockedToken });
    assert.equal(blockedGet.status, 403);
  });
});

describe('Admin User Management APIs (/api/admin/users)', () => {
  it('blocks customers and vendors from accessing admin user endpoints (403)', async () => {
    const customerToken = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');
    const vendorToken = await signUserToken(vendorId.toHexString(), 'rahim.oven@pizzahub.test');

    for (const token of [customerToken, vendorToken]) {
      const listRes = await callApi('/api/admin/users', { token });
      assert.equal(listRes.status, 403);

      const detailRes = await callApi(`/api/admin/users/${customerId.toHexString()}`, { token });
      assert.equal(detailRes.status, 403);

      const blockRes = await callApi(`/api/admin/users/${customerId.toHexString()}/block`, {
        method: 'PATCH',
        token,
        body: { isBlocked: true },
      });
      assert.equal(blockRes.status, 403);
    }

    const unauthRes = await callApi('/api/admin/users');
    assert.equal(unauthRes.status, 401);
  });

  it('lists users with counts, pagination, and excludes sensitive fields', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');

    const res = await callApi('/api/admin/users', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.users.length, 5);
    assert.deepEqual(res.body.counts, {
      total: 5,
      active: 4,
      blocked: 1,
      customers: 2,
      vendors: 2,
      admins: 1,
    });
    assert.deepEqual(res.body.pagination, {
      page: 1,
      limit: 20,
      total: 5,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    });
    for (const user of res.body.users) {
      assertNoSensitiveFields(user);
    }
  });

  it('supports search by name/email/businessName, role/status filters, and pagination', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');

    // Search with regex metacharacters ('+vip')
    const searchRes = await callApi(
      `/api/admin/users?search=${encodeURIComponent('+vip')}`,
      { token: adminToken },
    );
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.users.length, 1);
    assert.equal(searchRes.body.users[0].email, 'tariq+vip@pizzahub.test');

    // Filter by role=vendor & status=blocked
    const vendorBlockedRes = await callApi('/api/admin/users?role=vendor&status=blocked', {
      token: adminToken,
    });
    assert.equal(vendorBlockedRes.status, 200);
    assert.equal(vendorBlockedRes.body.users.length, 1);
    assert.equal(vendorBlockedRes.body.users[0].id, blockedVendorId.toHexString());

    // Filter by accountStatus=active & role=customer
    const activeCustomerRes = await callApi(
      '/api/admin/users?role=customer&accountStatus=active',
      { token: adminToken },
    );
    assert.equal(activeCustomerRes.status, 200);
    assert.equal(activeCustomerRes.body.users.length, 2);

    // Pagination (limit=2)
    const page1 = await callApi('/api/admin/users?page=1&limit=2', { token: adminToken });
    assert.equal(page1.status, 200);
    assert.equal(page1.body.users.length, 2);
    assert.deepEqual(page1.body.pagination, {
      page: 1,
      limit: 2,
      total: 5,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: false,
    });

    const page3 = await callApi('/api/admin/users?page=3&limit=2', { token: adminToken });
    assert.equal(page3.status, 200);
    assert.equal(page3.body.users.length, 1);
    assert.equal(page3.body.pagination.hasNextPage, false);
    assert.equal(page3.body.pagination.hasPrevPage, true);

    // Invalid query parameters
    const invalidFilter = await callApi('/api/admin/users?role=superadmin', { token: adminToken });
    assert.equal(invalidFilter.status, 400);

    const invalidLimit = await callApi('/api/admin/users?limit=500', { token: adminToken });
    assert.equal(invalidLimit.status, 400);
  });

  it('retrieves single user details and handles missing or invalid IDs', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');

    const detailRes = await callApi(`/api/admin/users/${vendorId.toHexString()}`, {
      token: adminToken,
    });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.user.id, vendorId.toHexString());
    assert.equal(detailRes.body.user.businessName, 'Brick Oven Crust');
    assertNoSensitiveFields(detailRes.body.user);

    const missingRes = await callApi(`/api/admin/users/${missingUserId.toHexString()}`, {
      token: adminToken,
    });
    assert.equal(missingRes.status, 404);

    const invalidRes = await callApi('/api/admin/users/not-a-valid-object-id', {
      token: adminToken,
    });
    assert.equal(invalidRes.status, 400);
  });

  it('blocks and unblocks target users, prevents self-blocking, and enforces live blocked status', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');
    const customerToken = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');

    // Admin cannot block own account
    const selfBlockRes = await callApi(`/api/admin/users/${adminId.toHexString()}/block`, {
      method: 'PATCH',
      token: adminToken,
      body: { isBlocked: true },
    });
    assert.equal(selfBlockRes.status, 400);
    assert.equal(selfBlockRes.body.message, 'You cannot block your own administrator account.');
    assert.equal(userRecords.find((u) => u._id.equals(adminId)).isBlocked, false);

    // Block customer
    const blockRes = await callApi(`/api/admin/users/${customerId.toHexString()}/block`, {
      method: 'PATCH',
      token: adminToken,
      body: { isBlocked: true },
    });
    assert.equal(blockRes.status, 200);
    assert.equal(blockRes.body.user.isBlocked, true);
    assertNoSensitiveFields(blockRes.body.user);

    // Blocked customer is immediately rejected by requireAuth on /api/profile
    const blockedProfileRes = await callApi('/api/profile', { token: customerToken });
    assert.equal(blockedProfileRes.status, 403);

    // Unblock customer
    const unblockRes = await callApi(`/api/admin/users/${customerId.toHexString()}/block`, {
      method: 'PATCH',
      token: adminToken,
      body: { isBlocked: false },
    });
    assert.equal(unblockRes.status, 200);
    assert.equal(unblockRes.body.user.isBlocked, false);

    // Unblocked customer can access /api/profile again
    const restoredProfileRes = await callApi('/api/profile', { token: customerToken });
    assert.equal(restoredProfileRes.status, 200);

    // Reject invalid block payloads, invalid IDs, and missing targets
    const badBody = await callApi(`/api/admin/users/${customerId.toHexString()}/block`, {
      method: 'PATCH',
      token: adminToken,
      body: { isBlocked: 'yes', role: 'admin' },
    });
    assert.equal(badBody.status, 400);

    const invalidId = await callApi('/api/admin/users/bad-id/block', {
      method: 'PATCH',
      token: adminToken,
      body: { isBlocked: true },
    });
    assert.equal(invalidId.status, 400);

    const missingTarget = await callApi(`/api/admin/users/${missingUserId.toHexString()}/block`, {
      method: 'PATCH',
      token: adminToken,
      body: { isBlocked: true },
    });
    assert.equal(missingTarget.status, 404);
  });

  it('wires /api/profile and /api/admin/users cleanly on src/app.js while keeping existing routes intact', async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const base = `http://127.0.0.1:${server.address().port}`;

      const profileNoAuth = await fetch(`${base}/api/profile`);
      assert.equal(profileNoAuth.status, 401);

      const adminUsersNoAuth = await fetch(`${base}/api/admin/users`);
      assert.equal(adminUsersNoAuth.status, 401);

      const unknownRoute = await fetch(`${base}/api/does-not-exist`);
      assert.equal(unknownRoute.status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
