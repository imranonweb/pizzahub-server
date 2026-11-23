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
import { createMenuRouter } from '../src/routes/menu.routes.js';
import { createVendorMenuRouter } from '../src/routes/vendor-menu.routes.js';

const TEST_ISSUER = 'http://localhost:3000';
const TEST_AUDIENCE = 'http://localhost:3000';

let jwksServer;
let jwksUrl;
let apiServer;
let apiBaseUrl;

let keyPair;
let publicJwk;
let dbMode = 'normal';
let userDocs = [];
let menuDocs = [];
let orderDocs = [];

const freeVendorId = new ObjectId('676000000000000000000001');
const premiumVendorId = new ObjectId('676000000000000000000002');
const blockedVendorId = new ObjectId('676000000000000000000003');
const customerId = new ObjectId('676000000000000000000004');
const adminId = new ObjectId('676000000000000000000005');

const missingMenuId = new ObjectId('676100000000000000000099');

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

    if (key === '$and') {
      if (!Array.isArray(condition) || !condition.every((clause) => matchesFilter(doc, clause))) {
        return false;
      }
      continue;
    }

    const docVal = doc[key];
    if (condition instanceof ObjectId) {
      if (!(docVal instanceof ObjectId) || !docVal.equals(condition)) {
        return false;
      }
    } else if (condition && typeof condition === 'object' && '$in' in condition) {
      const matched = condition.$in.some((candidate) => {
        if (candidate instanceof ObjectId && docVal instanceof ObjectId) {
          return candidate.equals(docVal);
        }
        return candidate === docVal;
      });
      if (!matched) {
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
      const source =
        name === 'menuItems'
          ? menuDocs
          : name === 'users'
            ? userDocs
            : name === 'orders'
              ? orderDocs
              : [];
      return {
        async findOne(filter, options = {}) {
          if (dbMode === 'error') {
            throw new Error(
              `MongoNetworkError: ${['mongodb+srv', '://admin:VendorDbSecret@mock.example.invalid/pizzahub'].join('')} failed`,
            );
          }
          const match = source.find((doc) => matchesFilter(doc, filter));
          return match ? applyProjection(match, options.projection) : null;
        },

        find(filter = {}, options = {}) {
          let results = source.filter((doc) => matchesFilter(doc, filter));
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
            async toArray() {
              if (dbMode === 'error') {
                throw new Error(
                  `MongoNetworkError: ${['mongodb+srv', '://admin:VendorDbSecret@mock.example.invalid/pizzahub'].join('')} failed`,
                );
              }
              return results.map((doc) => applyProjection(doc, options.projection));
            },
          };
          return cursor;
        },

        async countDocuments(filter = {}) {
          if (dbMode === 'error') {
            throw new Error('MongoNetworkError');
          }
          return source.filter((doc) => matchesFilter(doc, filter)).length;
        },

        async insertOne(doc) {
          if (dbMode === 'error') {
            throw new Error('MongoNetworkError');
          }
          const insertedId = doc._id ?? new ObjectId();
          source.push({ ...doc, _id: insertedId });
          return { acknowledged: true, insertedId };
        },

        async findOneAndUpdate(filter, update, options = {}) {
          if (dbMode === 'error') {
            throw new Error('MongoNetworkError');
          }
          const match = source.find((doc) => matchesFilter(doc, filter));
          if (!match) {
            return null;
          }
          if (update?.$set) {
            Object.assign(match, update.$set);
          }
          if (update?.$unset) {
            for (const key of Object.keys(update.$unset)) {
              delete match[key];
            }
          }
          return applyProjection(match, options.projection);
        },

        async deleteOne(filter) {
          if (dbMode === 'error') {
            throw new Error('MongoNetworkError');
          }
          const index = source.findIndex((doc) => matchesFilter(doc, filter));
          if (index === -1) {
            return { acknowledged: true, deletedCount: 0 };
          }
          source.splice(index, 1);
          return { acknowledged: true, deletedCount: 1 };
        },
      };
    },
  };
}

async function signUserToken(userId, email) {
  return new SignJWT({ sub: userId, email })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'vendor-api-key' })
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

function makeMenuItemDoc({
  id = new ObjectId(),
  vendorId,
  itemName = 'Classic Margherita',
  category = 'Classic Pizzas',
  description = 'Fresh mozzarella, San Marzano tomato sauce, and basil.',
  price = 12.5,
  location = 'Banani, Dhaka',
  images = ['https://i.ibb.co/example/pizza.jpg'],
  status = 'pending',
  rejectionReason,
  createdAt = new Date('2026-11-10T10:00:00.000Z'),
}) {
  return {
    _id: id,
    vendorId,
    itemName,
    category,
    description,
    price,
    location,
    images,
    status,
    ...(rejectionReason ? { rejectionReason } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

before(async () => {
  keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: 'vendor-api-key',
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
  testApp.use('/api/menu', createMenuRouter({ getDatabase: getMockDatabase }));
  testApp.use(
    '/api/vendor/menu',
    createVendorMenuRouter({ authMiddleware, getDatabase: getMockDatabase }),
  );
  testApp.use(notFoundMiddleware);
  testApp.use(errorMiddleware);

  apiServer = http.createServer(testApp);
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
});

beforeEach(() => {
  resetJwksCache();
  dbMode = 'normal';

  userDocs = [
    {
      _id: freeVendorId,
      name: 'Free Vendor',
      email: 'free.vendor@pizzahub.test',
      role: 'vendor',
      isBlocked: false,
      businessName: 'Banani Slice',
      subscriptionPlan: 'free',
      subscriptionExpiresAt: null,
    },
    {
      _id: premiumVendorId,
      name: 'Premium Vendor',
      email: 'premium.vendor@pizzahub.test',
      role: 'vendor',
      isBlocked: false,
      businessName: 'Napoli Crown',
      subscriptionPlan: 'premium',
      subscriptionExpiresAt: new Date('2027-06-01T00:00:00.000Z'),
    },
    {
      _id: blockedVendorId,
      name: 'Blocked Vendor',
      email: 'blocked.vendor@pizzahub.test',
      role: 'vendor',
      isBlocked: true,
      businessName: 'Blocked Kitchen',
      subscriptionPlan: 'free',
      subscriptionExpiresAt: null,
    },
    {
      _id: customerId,
      name: 'Customer User',
      email: 'customer@pizzahub.test',
      role: 'customer',
      isBlocked: false,
      subscriptionPlan: 'free',
    },
    {
      _id: adminId,
      name: 'Admin User',
      email: 'admin@pizzahub.test',
      role: 'admin',
      isBlocked: false,
      subscriptionPlan: 'free',
    },
  ];

  menuDocs = [];
  orderDocs = [];
});

after(async () => {
  resetJwksCache();
  await Promise.all([
    apiServer ? new Promise((resolve) => apiServer.close(resolve)) : Promise.resolve(),
    jwksServer ? new Promise((resolve) => jwksServer.close(resolve)) : Promise.resolve(),
  ]);
});

describe('Vendor Menu Management APIs (/api/vendor/menu)', () => {
  it('lists only the authenticated vendor items with accurate stats', async () => {
    const freeToken = await signUserToken(freeVendorId.toHexString(), 'free.vendor@pizzahub.test');
    menuDocs.push(
      makeMenuItemDoc({ vendorId: freeVendorId, itemName: 'Free Active 1', status: 'approved' }),
      makeMenuItemDoc({ vendorId: freeVendorId, itemName: 'Free Pending 1', status: 'pending' }),
      makeMenuItemDoc({
        vendorId: freeVendorId,
        itemName: 'Free Rejected 1',
        status: 'rejected',
        rejectionReason: 'Blurry photo',
      }),
      makeMenuItemDoc({ vendorId: freeVendorId, itemName: 'Free Inactive 1', status: 'inactive' }),
      makeMenuItemDoc({
        vendorId: premiumVendorId,
        itemName: 'Other Vendor Item',
        status: 'approved',
      }),
    );

    const res = await callApi('/api/vendor/menu', { token: freeToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.items.length, 4);
    assert.deepEqual(res.body.stats, {
      total: 4,
      active: 1,
      pending: 1,
      rejected: 1,
      inactive: 1,
    });
    assert.deepEqual(res.body.pagination, {
      page: 1,
      limit: 50,
      total: 4,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    });
    assert.equal(
      res.body.items.some((item) => item.itemName === 'Other Vendor Item'),
      false,
    );

    const filteredRes = await callApi('/api/vendor/menu?status=rejected&page=1&limit=2', {
      token: freeToken,
    });
    assert.equal(filteredRes.status, 200);
    assert.equal(filteredRes.body.items.length, 1);
    assert.equal(filteredRes.body.items[0].itemName, 'Free Rejected 1');
    assert.equal(filteredRes.body.stats.total, 4);
  });

  it('creates a new menu item with server-derived vendorId and pending status', async () => {
    const token = await signUserToken(freeVendorId.toHexString(), 'free.vendor@pizzahub.test');

    const res = await callApi('/api/vendor/menu', {
      method: 'POST',
      token,
      body: {
        itemName: 'Smoked Pepperoni Deluxe',
        category: 'Meat Lovers',
        description: 'Wood-fired crust topped with double beef pepperoni and mozzarella.',
        price: 16.5,
        location: 'Banani, Dhaka',
        images: ['https://i.ibb.co/example/pepperoni.jpg'],
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.item.vendorId, freeVendorId.toHexString());
    assert.equal(res.body.item.status, 'pending');
    assert.equal(res.body.item.price, 16.5);
    assert.equal(menuDocs.length, 1);
    assert.equal(menuDocs[0].status, 'pending');

    // Public menu must NOT expose newly created pending item
    const publicRes = await callApi('/api/menu');
    assert.equal(publicRes.status, 200);
    assert.equal(publicRes.body.items.length, 0);
  });

  it('rejects protected fields on create and update (403) and validates input fields (400)', async () => {
    const token = await signUserToken(freeVendorId.toHexString(), 'free.vendor@pizzahub.test');
    const itemId = new ObjectId();
    menuDocs.push(makeMenuItemDoc({ id: itemId, vendorId: freeVendorId, status: 'pending' }));

    const createWithStatus = await callApi('/api/vendor/menu', {
      method: 'POST',
      token,
      body: {
        itemName: 'Attempt Auto Approve',
        category: 'Classic Pizzas',
        description: 'Trying to bypass admin moderation with status field.',
        price: 14,
        location: 'Banani, Dhaka',
        images: ['https://i.ibb.co/example/pie.jpg'],
        status: 'approved',
      },
    });
    assert.equal(createWithStatus.status, 403);

    const createWithVendorId = await callApi('/api/vendor/menu', {
      method: 'POST',
      token,
      body: {
        itemName: 'Spoof Vendor',
        category: 'Classic Pizzas',
        description: 'Trying to assign another vendorId on create.',
        price: 14,
        location: 'Banani, Dhaka',
        images: ['https://i.ibb.co/example/pie.jpg'],
        vendorId: premiumVendorId.toHexString(),
      },
    });
    assert.equal(createWithVendorId.status, 403);

    const updateWithStatus = await callApi(`/api/vendor/menu/${itemId.toHexString()}`, {
      method: 'PATCH',
      token,
      body: { itemName: 'Updated Name', status: 'approved' },
    });
    assert.equal(updateWithStatus.status, 403);

    const invalidCreate = await callApi('/api/vendor/menu', {
      method: 'POST',
      token,
      body: {
        itemName: 'A',
        category: 'Invalid Category',
        description: 'Too short',
        price: -5,
        location: 'X',
        images: ['http://insecure.example.com/pizza.jpg'],
      },
    });
    assert.equal(invalidCreate.status, 400);
    assert.equal(typeof invalidCreate.body.errors?.category, 'string');
    assert.equal(typeof invalidCreate.body.errors?.price, 'string');
  });

  it('retrieves, updates, and deletes owned items while blocking cross-vendor access (403)', async () => {
    const freeToken = await signUserToken(freeVendorId.toHexString(), 'free.vendor@pizzahub.test');
    const otherItemId = new ObjectId();
    const ownItemId = new ObjectId();

    menuDocs.push(
      makeMenuItemDoc({ id: ownItemId, vendorId: freeVendorId, itemName: 'Old Pie', price: 10 }),
      makeMenuItemDoc({
        id: otherItemId,
        vendorId: premiumVendorId,
        itemName: 'Premium Secret Pie',
        status: 'approved',
      }),
    );

    const getOwn = await callApi(`/api/vendor/menu/${ownItemId.toHexString()}`, { token: freeToken });
    assert.equal(getOwn.status, 200);
    assert.equal(getOwn.body.item.itemName, 'Old Pie');

    const updateOwn = await callApi(`/api/vendor/menu/${ownItemId.toHexString()}`, {
      method: 'PATCH',
      token: freeToken,
      body: { itemName: 'Updated Artisan Pie', price: 14.25 },
    });
    assert.equal(updateOwn.status, 200);
    assert.equal(updateOwn.body.item.itemName, 'Updated Artisan Pie');
    assert.equal(updateOwn.body.item.price, 14.25);

    // Cross-vendor isolation across GET / PATCH / PATCH status / DELETE (returns 404)
    for (const reqOpts of [
      { method: 'GET' },
      { method: 'PATCH', body: { itemName: 'Hijacked' } },
      { method: 'PATCH', pathSuffix: '/status', body: { status: 'inactive' } },
      { method: 'DELETE' },
    ]) {
      const crossRes = await callApi(
        `/api/vendor/menu/${otherItemId.toHexString()}${reqOpts.pathSuffix ?? ''}`,
        { method: reqOpts.method, token: freeToken, body: reqOpts.body },
      );
      assert.equal(crossRes.status, 404);
    }

    // Editing an approved or rejected item resets it to pending for re-moderation
    const approvedEditId = new ObjectId();
    menuDocs.push(
      makeMenuItemDoc({
        id: approvedEditId,
        vendorId: freeVendorId,
        status: 'rejected',
        rejectionReason: 'Fix description',
      }),
    );
    const reModRes = await callApi(`/api/vendor/menu/${approvedEditId.toHexString()}`, {
      method: 'PATCH',
      token: freeToken,
      body: { description: 'Updated full wood-fired description for admin review.' },
    });
    assert.equal(reModRes.status, 200);
    assert.equal(reModRes.body.item.status, 'pending');
    assert.equal(reModRes.body.item.rejectionReason, null);

    // Deleting an item with existing order history is blocked (409)
    const orderedItemId = new ObjectId();
    menuDocs.push(makeMenuItemDoc({ id: orderedItemId, vendorId: freeVendorId, status: 'approved' }));
    orderDocs.push({ _id: new ObjectId(), itemId: orderedItemId, vendorId: freeVendorId });

    const delOrderedRes = await callApi(`/api/vendor/menu/${orderedItemId.toHexString()}`, {
      method: 'DELETE',
      token: freeToken,
    });
    assert.equal(delOrderedRes.status, 409);

    const delOwn = await callApi(`/api/vendor/menu/${ownItemId.toHexString()}`, {
      method: 'DELETE',
      token: freeToken,
    });
    assert.equal(delOwn.status, 200);
    assert.equal(menuDocs.some((d) => d._id.equals(ownItemId)), false);
  });

  it('activates and deactivates approved/inactive items and blocks activating pending/rejected items', async () => {
    const token = await signUserToken(freeVendorId.toHexString(), 'free.vendor@pizzahub.test');
    const approvedId = new ObjectId();
    const pendingId = new ObjectId();
    const rejectedId = new ObjectId();

    menuDocs.push(
      makeMenuItemDoc({ id: approvedId, vendorId: freeVendorId, status: 'approved' }),
      makeMenuItemDoc({ id: pendingId, vendorId: freeVendorId, status: 'pending' }),
      makeMenuItemDoc({ id: rejectedId, vendorId: freeVendorId, status: 'rejected' }),
    );

    // Deactivate approved -> inactive
    const deactivateRes = await callApi(`/api/vendor/menu/${approvedId.toHexString()}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'inactive' },
    });
    assert.equal(deactivateRes.status, 200);
    assert.equal(deactivateRes.body.item.status, 'inactive');

    // Reactivate inactive -> approved
    const reactivateRes = await callApi(`/api/vendor/menu/${approvedId.toHexString()}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'approved' },
    });
    assert.equal(reactivateRes.status, 200);
    assert.equal(reactivateRes.body.item.status, 'approved');

    // Pending & rejected items cannot be self-activated
    const pendingRes = await callApi(`/api/vendor/menu/${pendingId.toHexString()}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'approved' },
    });
    assert.equal(pendingRes.status, 400);

    const rejectedRes = await callApi(`/api/vendor/menu/${rejectedId.toHexString()}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'approved' },
    });
    assert.equal(rejectedRes.status, 400);
  });

  it('enforces the free plan 3-active-item limit (including concurrency) while allowing unlimited for premium', async () => {
    const freeToken = await signUserToken(freeVendorId.toHexString(), 'free.vendor@pizzahub.test');
    const premiumToken = await signUserToken(
      premiumVendorId.toHexString(),
      'premium.vendor@pizzahub.test',
    );

    const freeInactiveA = new ObjectId();
    const freeInactiveB = new ObjectId();
    menuDocs.push(
      makeMenuItemDoc({ vendorId: freeVendorId, status: 'approved' }),
      makeMenuItemDoc({ vendorId: freeVendorId, status: 'approved' }),
      makeMenuItemDoc({ id: freeInactiveA, vendorId: freeVendorId, status: 'inactive' }),
      makeMenuItemDoc({ id: freeInactiveB, vendorId: freeVendorId, status: 'inactive' }),
    );

    // Concurrent activation of 2 inactive items when 2 are already active:
    // Only 1 may succeed (200), the 2nd must fail (409).
    const [concurrent1, concurrent2] = await Promise.all([
      callApi(`/api/vendor/menu/${freeInactiveA.toHexString()}/status`, {
        method: 'PATCH',
        token: freeToken,
        body: { status: 'approved' },
      }),
      callApi(`/api/vendor/menu/${freeInactiveB.toHexString()}/status`, {
        method: 'PATCH',
        token: freeToken,
        body: { status: 'approved' },
      }),
    ]);

    const statuses = [concurrent1.status, concurrent2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);

    const freeActiveCount = menuDocs.filter(
      (d) => d.vendorId.equals(freeVendorId) && d.status === 'approved',
    ).length;
    assert.equal(freeActiveCount, 3);

    // Premium vendor can activate 4+ items without hitting a limit
    const premInactive = new ObjectId();
    menuDocs.push(
      makeMenuItemDoc({ vendorId: premiumVendorId, status: 'approved' }),
      makeMenuItemDoc({ vendorId: premiumVendorId, status: 'approved' }),
      makeMenuItemDoc({ vendorId: premiumVendorId, status: 'approved' }),
      makeMenuItemDoc({ id: premInactive, vendorId: premiumVendorId, status: 'inactive' }),
    );

    const premRes = await callApi(`/api/vendor/menu/${premInactive.toHexString()}/status`, {
      method: 'PATCH',
      token: premiumToken,
      body: { status: 'approved' },
    });
    assert.equal(premRes.status, 200);
    assert.equal(premRes.body.item.status, 'approved');

    // Expired premium subscription falls back to Free plan 3-active-item limit
    const expiredPremVendor = userDocs.find((u) => u._id.equals(premiumVendorId));
    expiredPremVendor.subscriptionExpiresAt = new Date('2020-01-01T00:00:00.000Z');
    const expiredInactive = new ObjectId();
    menuDocs.push(
      makeMenuItemDoc({ id: expiredInactive, vendorId: premiumVendorId, status: 'inactive' }),
    );
    const expiredRes = await callApi(`/api/vendor/menu/${expiredInactive.toHexString()}/status`, {
      method: 'PATCH',
      token: premiumToken,
      body: { status: 'approved' },
    });
    assert.equal(expiredRes.status, 409);
  });

  it('rejects blocked vendors, non-vendor roles, unauthenticated callers, invalid IDs, missing items, and DB errors', async () => {
    const blockedToken = await signUserToken(
      blockedVendorId.toHexString(),
      'blocked.vendor@pizzahub.test',
    );
    const customerToken = await signUserToken(customerId.toHexString(), 'customer@pizzahub.test');
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');
    const vendorToken = await signUserToken(freeVendorId.toHexString(), 'free.vendor@pizzahub.test');

    assert.equal((await callApi('/api/vendor/menu')).status, 401);
    assert.equal((await callApi('/api/vendor/menu', { token: blockedToken })).status, 403);
    assert.equal((await callApi('/api/vendor/menu', { token: customerToken })).status, 403);
    assert.equal((await callApi('/api/vendor/menu', { token: adminToken })).status, 403);

    assert.equal(
      (await callApi('/api/vendor/menu/not-a-valid-id', { token: vendorToken })).status,
      400,
    );
    assert.equal(
      (await callApi(`/api/vendor/menu/${missingMenuId.toHexString()}`, { token: vendorToken }))
        .status,
      404,
    );

    // Database error during vendor query does not leak credentials
    dbMode = 'error';
    const dbErrRes = await callApi('/api/vendor/menu', { token: vendorToken });
    assert.equal(dbErrRes.status, 503);
    assert.equal(JSON.stringify(dbErrRes.body).includes('VendorDbSecret'), false);
  });

  it('wires /api/vendor/menu cleanly on src/app.js without breaking public menu or 404', async () => {
    const mainServer = http.createServer(app);
    await new Promise((resolve) => mainServer.listen(0, '127.0.0.1', resolve));

    try {
      const base = `http://127.0.0.1:${mainServer.address().port}`;
      assert.equal((await fetch(`${base}/api/vendor/menu`)).status, 401);
      assert.equal((await fetch(`${base}/api/menu/invalid-id`)).status, 400);
      assert.equal((await fetch(`${base}/api/unknown-path`)).status, 404);
    } finally {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });
});
