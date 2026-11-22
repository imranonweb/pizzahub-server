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
import { createOrdersRouter } from '../src/routes/orders.routes.js';
import { createVendorOrdersRouter } from '../src/routes/vendor-orders.routes.js';

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

const customerOneId = new ObjectId('678000000000000000000001');
const customerTwoId = new ObjectId('678000000000000000000002');
const blockedCustomerId = new ObjectId('678000000000000000000003');
const vendorOneId = new ObjectId('678000000000000000000004');
const vendorTwoId = new ObjectId('678000000000000000000005');
const blockedVendorId = new ObjectId('678000000000000000000006');
const adminId = new ObjectId('678000000000000000000007');

const vendorOnePizzaId = new ObjectId('678100000000000000000001');
const vendorOneDrinkId = new ObjectId('678100000000000000000002');
const vendorTwoPizzaId = new ObjectId('678100000000000000000003');
const pendingItemId = new ObjectId('678100000000000000000004');
const rejectedItemId = new ObjectId('678100000000000000000005');
const inactiveItemId = new ObjectId('678100000000000000000006');
const blockedVendorItemId = new ObjectId('678100000000000000000007');
const ownVendorItemId = new ObjectId('678100000000000000000008');
const missingOrderId = new ObjectId('678200000000000000000099');

function getNestedValue(doc, path) {
  const parts = path.split('.');
  let current = doc;
  for (const part of parts) {
    if (Array.isArray(current)) {
      return current.map((el) => (el && typeof el === 'object' ? el[part] : undefined));
    }
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function valuesEqual(a, b) {
  if (a instanceof ObjectId && b instanceof ObjectId) {
    return a.equals(b);
  }
  return a === b;
}

function matchesCondition(docVal, condition) {
  if (Array.isArray(docVal)) {
    return docVal.some((entry) => matchesCondition(entry, condition));
  }
  if (condition instanceof ObjectId) {
    return docVal instanceof ObjectId && docVal.equals(condition);
  }
  if (condition && typeof condition === 'object' && '$in' in condition) {
    return condition.$in.some((candidate) => valuesEqual(docVal, candidate));
  }
  return docVal === condition;
}

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

    const docVal = key.includes('.') ? getNestedValue(doc, key) : doc[key];
    if (!matchesCondition(docVal, condition)) {
      return false;
    }
  }

  return true;
}

function applyProjection(doc, projection) {
  if (!projection) {
    return structuredClone(doc);
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
        name === 'orders'
          ? orderDocs
          : name === 'menuItems'
            ? menuDocs
            : name === 'users'
              ? userDocs
              : [];

      return {
        async findOne(filter, options = {}) {
          if (dbMode === 'error') {
            throw new Error(
              'MongoNetworkError: mongodb+srv://admin:OrderDbSecret@cluster.mongodb.net/pizzahub failed',
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
                  'MongoNetworkError: mongodb+srv://admin:OrderDbSecret@cluster.mongodb.net/pizzahub failed',
                );
              }
              return results.map((doc) => applyProjection(doc, options.projection));
            },
          };
          return cursor;
        },

        async insertOne(doc) {
          if (dbMode === 'error') {
            throw new Error('MongoNetworkError');
          }
          const insertedId = doc._id ?? new ObjectId();
          source.push({ ...doc, _id: insertedId });
          return { acknowledged: true, insertedId };
        },

        async insertMany(docs) {
          if (dbMode === 'error') {
            throw new Error('MongoNetworkError');
          }
          const insertedIds = {};
          docs.forEach((doc, idx) => {
            const id = doc._id ?? new ObjectId();
            source.push({ ...doc, _id: id });
            insertedIds[idx] = id;
          });
          return { acknowledged: true, insertedIds };
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
          if (update?.$push) {
            for (const [field, entry] of Object.entries(update.$push)) {
              if (!Array.isArray(match[field])) {
                match[field] = [];
              }
              match[field].push(entry);
            }
          }
          return applyProjection(match, options.projection);
        },
      };
    },
  };
}

async function signUserToken(userId, email) {
  return new SignJWT({ sub: userId, email })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'order-api-key' })
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

before(async () => {
  keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: 'order-api-key',
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
  testApp.use('/api/orders', createOrdersRouter({ authMiddleware, getDatabase: getMockDatabase }));
  testApp.use(
    '/api/vendor/orders',
    createVendorOrdersRouter({ authMiddleware, getDatabase: getMockDatabase }),
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
      _id: customerOneId,
      name: 'Ayesha Customer',
      email: 'ayesha@pizzahub.test',
      role: 'customer',
      isBlocked: false,
      passwordHash: 'cust1-hash',
      sessions: ['s-cust-1'],
    },
    {
      _id: customerTwoId,
      name: 'Tariq Customer',
      email: 'tariq@pizzahub.test',
      role: 'customer',
      isBlocked: false,
    },
    {
      _id: blockedCustomerId,
      name: 'Blocked Customer',
      email: 'blocked.customer@pizzahub.test',
      role: 'customer',
      isBlocked: true,
    },
    {
      _id: vendorOneId,
      name: 'Marco Rossi',
      email: 'marco@pizzahub.test',
      role: 'vendor',
      isBlocked: false,
      businessName: 'Napoli Fire Oven',
      subscriptionPlan: 'premium',
      passwordHash: 'v1-hash',
    },
    {
      _id: vendorTwoId,
      name: 'Sara Khan',
      email: 'sara@pizzahub.test',
      role: 'vendor',
      isBlocked: false,
      businessName: 'Dhaka Slice House',
      subscriptionPlan: 'free',
    },
    {
      _id: blockedVendorId,
      name: 'Blocked Vendor',
      email: 'blocked.vendor@pizzahub.test',
      role: 'vendor',
      isBlocked: true,
      businessName: 'Locked Crust',
    },
    {
      _id: adminId,
      name: 'Nadia Admin',
      email: 'admin@pizzahub.test',
      role: 'admin',
      isBlocked: false,
    },
  ];

  menuDocs = [
    {
      _id: vendorOnePizzaId,
      vendorId: vendorOneId,
      itemName: 'Margherita Classica',
      price: 12.5,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/margherita.jpg'],
      status: 'approved',
    },
    {
      _id: vendorOneDrinkId,
      vendorId: vendorOneId,
      itemName: 'Sparkling Blood Orange',
      price: 4.25,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/drink.jpg'],
      status: 'approved',
    },
    {
      _id: vendorTwoPizzaId,
      vendorId: vendorTwoId,
      itemName: 'Smoked Pepperoni Feast',
      price: 16.0,
      location: 'Gulshan, Dhaka',
      images: ['https://i.ibb.co/example/pepperoni.jpg'],
      status: 'approved',
    },
    {
      _id: pendingItemId,
      vendorId: vendorOneId,
      itemName: 'Pending Pie',
      price: 10.0,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/pending.jpg'],
      status: 'pending',
    },
    {
      _id: rejectedItemId,
      vendorId: vendorOneId,
      itemName: 'Rejected Pie',
      price: 10.0,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/rejected.jpg'],
      status: 'rejected',
    },
    {
      _id: inactiveItemId,
      vendorId: vendorOneId,
      itemName: 'Inactive Pie',
      price: 10.0,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/inactive.jpg'],
      status: 'inactive',
    },
    {
      _id: blockedVendorItemId,
      vendorId: blockedVendorId,
      itemName: 'Blocked Vendor Pie',
      price: 14.0,
      location: 'Uttara, Dhaka',
      images: ['https://i.ibb.co/example/blocked.jpg'],
      status: 'approved',
    },
    {
      _id: ownVendorItemId,
      vendorId: customerOneId,
      itemName: 'Own Vendor Pie',
      price: 13.0,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/own.jpg'],
      status: 'approved',
    },
  ];

  orderDocs = [];
});

after(async () => {
  resetJwksCache();
  await Promise.all([
    apiServer ? new Promise((resolve) => apiServer.close(resolve)) : Promise.resolve(),
    jwksServer ? new Promise((resolve) => jwksServer.close(resolve)) : Promise.resolve(),
  ]);
});

describe('Customer Order APIs (/api/orders)', () => {
  it('enforces customer-only non-blocked authentication on order creation and listing', async () => {
    const vendorToken = await signUserToken(vendorOneId.toHexString(), 'marco@pizzahub.test');
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');
    const blockedToken = await signUserToken(
      blockedCustomerId.toHexString(),
      'blocked.customer@pizzahub.test',
    );

    const validOrderBody = {
      items: [{ menuItemId: vendorOnePizzaId.toHexString(), quantity: 1 }],
      deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
      contactPhone: '+8801711000001',
    };

    assert.equal(
      (await callApi('/api/orders', { method: 'POST', body: validOrderBody })).status,
      401,
    );
    assert.equal(
      (
        await callApi('/api/orders', {
          method: 'POST',
          token: vendorToken,
          body: validOrderBody,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await callApi('/api/orders', {
          method: 'POST',
          token: adminToken,
          body: validOrderBody,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await callApi('/api/orders', {
          method: 'POST',
          token: blockedToken,
          body: validOrderBody,
        })
      ).status,
      403,
    );
  });

  it('creates server-priced order snapshots, sets Pending status, and records initial timeline', async () => {
    const token = await signUserToken(customerOneId.toHexString(), 'ayesha@pizzahub.test');

    const res = await callApi('/api/orders', {
      method: 'POST',
      token,
      body: {
        items: [
          { menuItemId: vendorOnePizzaId.toHexString(), quantity: 2 },
          { menuItemId: vendorOneDrinkId.toHexString(), quantity: 3 },
        ],
        deliveryAddress: 'Apartment 4B, Road 11, Banani, Dhaka',
        contactPhone: '+880 1711-000001',
        orderNotes: 'Extra chili flakes please',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.order.customerId, customerOneId.toHexString());
    assert.equal(res.body.order.vendorId, vendorOneId.toHexString());
    assert.equal(res.body.order.vendorName, 'Napoli Fire Oven');
    assert.equal(res.body.order.status, 'pending');
    // 2 * 12.5 + 3 * 4.25 = 25 + 12.75 = 37.75
    assert.equal(res.body.order.subtotal, 37.75);
    assert.equal(res.body.order.total, 37.75);
    assert.equal(res.body.order.items.length, 2);
    assert.equal(res.body.order.statusHistory.length, 1);
    assert.equal(res.body.order.statusHistory[0].status, 'pending');
    assert.equal(res.body.order.statusHistory[0].actorRole, 'customer');

    // Mutate menu item price afterwards; historical order snapshot must stay 37.75
    menuDocs[0].price = 99.99;
    menuDocs[0].itemName = 'Changed Pizza Name';

    const detailRes = await callApi(`/api/orders/${res.body.order.id}`, { token });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.order.total, 37.75);
    assert.equal(detailRes.body.order.items[0].itemName, 'Margherita Classica');
    assert.equal(detailRes.body.order.items[0].unitPrice, 12.5);
  });

  it('rejects invalid items, non-approved items, blocked vendor items, own items, and forged totals/statuses', async () => {
    const token = await signUserToken(customerOneId.toHexString(), 'ayesha@pizzahub.test');
    const baseDelivery = {
      deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
      contactPhone: '+8801711000001',
    };

    // Invalid item ID & bad quantities
    assert.equal(
      (
        await callApi('/api/orders', {
          method: 'POST',
          token,
          body: { ...baseDelivery, items: [{ menuItemId: 'bad-id', quantity: 1 }] },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await callApi('/api/orders', {
          method: 'POST',
          token,
          body: {
            ...baseDelivery,
            items: [{ menuItemId: vendorOnePizzaId.toHexString(), quantity: 0 }],
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await callApi('/api/orders', {
          method: 'POST',
          token,
          body: {
            ...baseDelivery,
            items: [{ menuItemId: vendorOnePizzaId.toHexString(), quantity: -2 }],
          },
        })
      ).status,
      400,
    );

    // Pending, rejected, inactive, and blocked-vendor items
    for (const badItemId of [pendingItemId, rejectedItemId, inactiveItemId, blockedVendorItemId]) {
      const badRes = await callApi('/api/orders', {
        method: 'POST',
        token,
        body: {
          ...baseDelivery,
          items: [{ menuItemId: badItemId.toHexString(), quantity: 1 }],
        },
      });
      assert.equal(badRes.status, 400);
    }

    // Own vendor item rejected (403)
    const ownRes = await callApi('/api/orders', {
      method: 'POST',
      token,
      body: {
        ...baseDelivery,
        items: [{ menuItemId: ownVendorItemId.toHexString(), quantity: 1 }],
      },
    });
    assert.equal(ownRes.status, 403);

    // Forged prices, totals, customerId, status rejected (403)
    for (const forged of [
      { total: 0.01 },
      { subtotal: 1 },
      { status: 'accepted' },
      { customerId: customerTwoId.toHexString() },
    ]) {
      const forgedRes = await callApi('/api/orders', {
        method: 'POST',
        token,
        body: {
          ...baseDelivery,
          items: [{ menuItemId: vendorOnePizzaId.toHexString(), quantity: 1 }],
          ...forged,
        },
      });
      assert.equal(forgedRes.status, 403);
    }

    const forgedItemPrice = await callApi('/api/orders', {
      method: 'POST',
      token,
      body: {
        ...baseDelivery,
        items: [{ menuItemId: vendorOnePizzaId.toHexString(), quantity: 1, unitPrice: 0.01 }],
      },
    });
    assert.equal(forgedItemPrice.status, 403);
  });

  it('prevents duplicate active orders for the same item and deliveryDate, and enforces customer ownership & cancellation rules', async () => {
    const cust1Token = await signUserToken(customerOneId.toHexString(), 'ayesha@pizzahub.test');
    const cust2Token = await signUserToken(customerTwoId.toHexString(), 'tariq@pizzahub.test');

    const createRes = await callApi('/api/orders', {
      method: 'POST',
      token: cust1Token,
      body: {
        items: [{ menuItemId: vendorOnePizzaId.toHexString(), quantity: 1 }],
        deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
        contactPhone: '+8801711000001',
        deliveryDate: '2026-12-01',
      },
    });
    assert.equal(createRes.status, 201);
    const orderId = createRes.body.order.id;

    // Duplicate active order on same deliveryDate -> 409
    const dupRes = await callApi('/api/orders', {
      method: 'POST',
      token: cust1Token,
      body: {
        items: [{ menuItemId: vendorOnePizzaId.toHexString(), quantity: 1 }],
        deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
        contactPhone: '+8801711000001',
        deliveryDate: '2026-12-01',
      },
    });
    assert.equal(dupRes.status, 409);

    // Customer 2 cannot read or cancel Customer 1's order (404)
    assert.equal((await callApi(`/api/orders/${orderId}`, { token: cust2Token })).status, 404);
    assert.equal(
      (
        await callApi(`/api/orders/${orderId}/cancel`, {
          method: 'PATCH',
          token: cust2Token,
        })
      ).status,
      404,
    );

    // Customer 1 lists via both /api/orders and /api/orders/my
    const list1 = await callApi('/api/orders', { token: cust1Token });
    const listMy = await callApi('/api/orders/my', { token: cust1Token });
    assert.equal(list1.status, 200);
    assert.equal(list1.body.orders.length, 1);
    assert.equal(listMy.status, 200);
    assert.equal(listMy.body.orders.length, 1);

    // Customer 1 cancels pending order
    const cancelRes = await callApi(`/api/orders/${orderId}/cancel`, {
      method: 'PATCH',
      token: cust1Token,
      body: { reason: 'Changed dinner plans' },
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.order.status, 'cancelled');
    assert.equal(cancelRes.body.order.statusHistory.length, 2);
    assert.equal(cancelRes.body.order.statusHistory[1].previousStatus, 'pending');
    assert.equal(cancelRes.body.order.statusHistory[1].status, 'cancelled');

    // Second cancellation or cancelling an accepted order is rejected (400)
    const repeatCancel = await callApi(`/api/orders/${orderId}/cancel`, {
      method: 'PATCH',
      token: cust1Token,
    });
    assert.equal(repeatCancel.status, 400);

    // Accepted order cannot be cancelled by customer
    const order2 = await callApi('/api/orders', {
      method: 'POST',
      token: cust1Token,
      body: {
        items: [{ menuItemId: vendorOnePizzaId.toHexString(), quantity: 1 }],
        deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
        contactPhone: '+8801711000001',
      },
    });
    const vendorToken = await signUserToken(vendorOneId.toHexString(), 'marco@pizzahub.test');
    await callApi(`/api/vendor/orders/${order2.body.order.id}/status`, {
      method: 'PATCH',
      token: vendorToken,
      body: { status: 'accepted' },
    });
    const cancelAccepted = await callApi(`/api/orders/${order2.body.order.id}/cancel`, {
      method: 'PATCH',
      token: cust1Token,
    });
    assert.equal(cancelAccepted.status, 400);
  });
});

describe('Vendor Order Management APIs (/api/vendor/orders)', () => {
  it('enforces vendor-only authentication and isolates multi-vendor orders', async () => {
    const customerToken = await signUserToken(customerOneId.toHexString(), 'ayesha@pizzahub.test');
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');
    const blockedVendorToken = await signUserToken(
      blockedVendorId.toHexString(),
      'blocked.vendor@pizzahub.test',
    );
    const vendor1Token = await signUserToken(vendorOneId.toHexString(), 'marco@pizzahub.test');
    const vendor2Token = await signUserToken(vendorTwoId.toHexString(), 'sara@pizzahub.test');

    assert.equal((await callApi('/api/vendor/orders')).status, 401);
    assert.equal((await callApi('/api/vendor/orders', { token: customerToken })).status, 403);
    assert.equal((await callApi('/api/vendor/orders', { token: adminToken })).status, 403);
    assert.equal((await callApi('/api/vendor/orders', { token: blockedVendorToken })).status, 403);

    // Customer places one checkout containing items from BOTH vendor 1 and vendor 2
    const checkoutRes = await callApi('/api/orders', {
      method: 'POST',
      token: customerToken,
      body: {
        items: [
          { menuItemId: vendorOnePizzaId.toHexString(), quantity: 1 },
          { menuItemId: vendorTwoPizzaId.toHexString(), quantity: 2 },
        ],
        deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
        contactPhone: '+8801711000001',
      },
    });
    assert.equal(checkoutRes.status, 201);
    assert.equal(checkoutRes.body.orders.length, 2);

    const v1List = await callApi('/api/vendor/orders', { token: vendor1Token });
    const v2List = await callApi('/api/vendor/orders', { token: vendor2Token });
    assert.equal(v1List.status, 200);
    assert.equal(v1List.body.orders.length, 1);
    assert.equal(v1List.body.orders[0].total, 12.5);
    assert.equal(v1List.body.orders[0].customer.name, 'Ayesha Customer');
    assert.equal('passwordHash' in v1List.body.orders[0].customer, false);

    assert.equal(v2List.status, 200);
    assert.equal(v2List.body.orders.length, 1);
    assert.equal(v2List.body.orders[0].total, 32.0);

    // Vendor 1 cannot access Vendor 2's order (404)
    const v2OrderId = v2List.body.orders[0].id;
    assert.equal(
      (await callApi(`/api/vendor/orders/${v2OrderId}`, { token: vendor1Token })).status,
      404,
    );
    assert.equal(
      (
        await callApi(`/api/vendor/orders/${v2OrderId}/status`, {
          method: 'PATCH',
          token: vendor1Token,
          body: { status: 'accepted' },
        })
      ).status,
      404,
    );
  });

  it('enforces order lifecycle transitions, prevents direct delivered marking, and records timeline', async () => {
    const customerToken = await signUserToken(customerOneId.toHexString(), 'ayesha@pizzahub.test');
    const vendor1Token = await signUserToken(vendorOneId.toHexString(), 'marco@pizzahub.test');

    const orderA = (
      await callApi('/api/orders', {
        method: 'POST',
        token: customerToken,
        body: {
          items: [{ menuItemId: vendorOnePizzaId.toHexString(), quantity: 1 }],
          deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
          contactPhone: '+8801711000001',
        },
      })
    ).body.order;

    // Pending cannot skip straight to preparing or delivered
    assert.equal(
      (
        await callApi(`/api/vendor/orders/${orderA.id}/status`, {
          method: 'PATCH',
          token: vendor1Token,
          body: { status: 'preparing' },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await callApi(`/api/vendor/orders/${orderA.id}/status`, {
          method: 'PATCH',
          token: vendor1Token,
          body: { status: 'delivered' },
        })
      ).status,
      403,
    );

    // Pending -> Accepted -> Preparing -> Ready
    const accepted = await callApi(`/api/vendor/orders/${orderA.id}/status`, {
      method: 'PATCH',
      token: vendor1Token,
      body: { status: 'accepted', note: 'Oven firing up' },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.order.status, 'accepted');

    // Accepted cannot be rejected
    assert.equal(
      (
        await callApi(`/api/vendor/orders/${orderA.id}/status`, {
          method: 'PATCH',
          token: vendor1Token,
          body: { status: 'rejected' },
        })
      ).status,
      400,
    );

    const preparing = await callApi(`/api/vendor/orders/${orderA.id}/status`, {
      method: 'PATCH',
      token: vendor1Token,
      body: { status: 'preparing' },
    });
    assert.equal(preparing.status, 200);
    assert.equal(preparing.body.order.status, 'preparing');

    const ready = await callApi(`/api/vendor/orders/${orderA.id}/status`, {
      method: 'PATCH',
      token: vendor1Token,
      body: { status: 'ready' },
    });
    assert.equal(ready.status, 200);
    assert.equal(ready.body.order.status, 'ready');
    assert.equal(ready.body.order.statusHistory.length, 4);
    assert.deepEqual(
      ready.body.order.statusHistory.map((h) => h.status),
      ['pending', 'accepted', 'preparing', 'ready'],
    );

    // Vendor still cannot mark Ready order directly as Delivered (403)
    assert.equal(
      (
        await callApi(`/api/vendor/orders/${orderA.id}/status`, {
          method: 'PATCH',
          token: vendor1Token,
          body: { status: 'delivered' },
        })
      ).status,
      403,
    );

    // Rejected and cancelled orders cannot be accepted later
    const orderB = (
      await callApi('/api/orders', {
        method: 'POST',
        token: customerToken,
        body: {
          items: [{ menuItemId: vendorOneDrinkId.toHexString(), quantity: 1 }],
          deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
          contactPhone: '+8801711000001',
        },
      })
    ).body.order;
    await callApi(`/api/vendor/orders/${orderB.id}/status`, {
      method: 'PATCH',
      token: vendor1Token,
      body: { status: 'rejected' },
    });
    assert.equal(
      (
        await callApi(`/api/vendor/orders/${orderB.id}/status`, {
          method: 'PATCH',
          token: vendor1Token,
          body: { status: 'accepted' },
        })
      ).status,
      400,
    );
  });

  it('supports filtering, sorting, pagination, invalid IDs, and safe DB failure handling', async () => {
    const customerToken = await signUserToken(customerOneId.toHexString(), 'ayesha@pizzahub.test');
    const vendor1Token = await signUserToken(vendorOneId.toHexString(), 'marco@pizzahub.test');

    for (const qty of [1, 2, 3]) {
      await callApi('/api/orders', {
        method: 'POST',
        token: customerToken,
        body: {
          items: [{ menuItemId: vendorOneDrinkId.toHexString(), quantity: qty }],
          deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
          contactPhone: '+8801711000001',
        },
      });
    }

    const paged = await callApi('/api/vendor/orders?sort=total-asc&page=1&limit=2', {
      token: vendor1Token,
    });
    assert.equal(paged.status, 200);
    assert.equal(paged.body.orders.length, 2);
    assert.deepEqual(
      paged.body.orders.map((o) => o.total),
      [4.25, 8.5],
    );
    assert.deepEqual(paged.body.pagination, {
      page: 1,
      limit: 2,
      total: 3,
      totalPages: 2,
      hasNextPage: true,
      hasPrevPage: false,
    });

    assert.equal(
      (await callApi('/api/vendor/orders/invalid-id', { token: vendor1Token })).status,
      400,
    );
    assert.equal(
      (await callApi(`/api/vendor/orders/${missingOrderId.toHexString()}`, { token: vendor1Token }))
        .status,
      404,
    );

    dbMode = 'error';
    const dbErr = await callApi('/api/orders', { token: customerToken });
    assert.equal(dbErr.status, 503);
    assert.equal(JSON.stringify(dbErr.body).includes('OrderDbSecret'), false);
  });

  it('wires /api/orders and /api/vendor/orders on src/app.js cleanly', async () => {
    const mainServer = http.createServer(app);
    await new Promise((resolve) => mainServer.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${mainServer.address().port}`;
      assert.equal((await fetch(`${base}/api/orders`)).status, 401);
      assert.equal((await fetch(`${base}/api/orders/my`)).status, 401);
      assert.equal((await fetch(`${base}/api/vendor/orders`)).status, 401);
      assert.equal((await fetch(`${base}/api/menu/invalid-id`)).status, 400);
      assert.equal((await fetch(`${base}/api/unknown-order-route`)).status, 404);
    } finally {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });
});
