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
import { createAdminMenuRouter } from '../src/routes/admin-menu.routes.js';
import { createNotificationsRouter } from '../src/routes/notifications.routes.js';
import { createOrdersRouter } from '../src/routes/orders.routes.js';
import { createVendorOrdersRouter } from '../src/routes/vendor-orders.routes.js';
import { safeNotify } from '../src/services/notification.service.js';

const TEST_ISSUER = 'http://localhost:3000';
const TEST_AUDIENCE = 'http://localhost:3000';

let jwksServer;
let jwksUrl;
let apiServer;
let apiBaseUrl;

let keyPair;
let publicJwk;
let failNotificationsWrite = false;
let userDocs = [];
let menuDocs = [];
let orderDocs = [];
let notificationDocs = [];

const customerId = new ObjectId('680000000000000000000001');
const vendorId = new ObjectId('680000000000000000000002');
const adminId = new ObjectId('680000000000000000000003');
const blockedUserId = new ObjectId('680000000000000000000004');
const menuItemId = new ObjectId('680100000000000000000001');
const pendingMenuId = new ObjectId('680100000000000000000002');
const missingNotifId = new ObjectId('680200000000000000000099');

function valuesEqual(a, b) {
  if (a instanceof ObjectId && b instanceof ObjectId) {
    return a.equals(b);
  }
  return a === b;
}

function matchesCondition(docVal, condition) {
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

    if (!matchesCondition(doc[key], condition)) {
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
        name === 'notifications'
          ? notificationDocs
          : name === 'orders'
            ? orderDocs
            : name === 'menuItems'
              ? menuDocs
              : name === 'users'
                ? userDocs
                : [];

      return {
        async findOne(filter, options = {}) {
          const match = source.find((doc) => matchesFilter(doc, filter));
          return match ? applyProjection(match, options.projection) : null;
        },

        find(filter = {}, options = {}) {
          let results = source.filter((doc) => matchesFilter(doc, filter));
          let skipCount = 0;
          let limitCount = results.length;
          const cursor = {
            sort(sortSpec) {
              results = [...results].sort((a, b) => {
                for (const [field, dir] of Object.entries(sortSpec)) {
                  const aVal = a[field] instanceof Date ? a[field].getTime() : a[field];
                  const bVal = b[field] instanceof Date ? b[field].getTime() : b[field];
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
          return source.filter((doc) => matchesFilter(doc, filter)).length;
        },

        async insertOne(doc) {
          if (name === 'notifications' && failNotificationsWrite) {
            throw new Error('Simulated notifications outage');
          }
          if (name === 'notifications' && doc.eventKey) {
            const exists = source.some(
              (n) => String(n.userId) === String(doc.userId) && n.eventKey === doc.eventKey,
            );
            if (exists) {
              const dupErr = new Error('Duplicate notification eventKey');
              dupErr.code = 11000;
              throw dupErr;
            }
          }
          const insertedId = doc._id ?? new ObjectId();
          source.push({ ...doc, _id: insertedId });
          return { acknowledged: true, insertedId };
        },

        async findOneAndUpdate(filter, update, options = {}) {
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

        async updateMany(filter, update) {
          let modifiedCount = 0;
          for (const doc of source) {
            if (matchesFilter(doc, filter)) {
              if (update?.$set) {
                Object.assign(doc, update.$set);
              }
              modifiedCount += 1;
            }
          }
          return { acknowledged: true, modifiedCount };
        },
      };
    },
  };
}

async function signUserToken(userId, email) {
  return new SignJWT({ sub: userId, email })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'notif-api-key' })
    .setSubject(userId)
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(keyPair.privateKey);
}

async function callApi(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

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
    kid: 'notif-api-key',
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
  testApp.use(
    '/api/notifications',
    createNotificationsRouter({ authMiddleware, getDatabase: getMockDatabase }),
  );
  testApp.use('/api/orders', createOrdersRouter({ authMiddleware, getDatabase: getMockDatabase }));
  testApp.use(
    '/api/vendor/orders',
    createVendorOrdersRouter({ authMiddleware, getDatabase: getMockDatabase }),
  );
  testApp.use(
    '/api/admin/menu',
    createAdminMenuRouter({ authMiddleware, getDatabase: getMockDatabase }),
  );
  testApp.use(notFoundMiddleware);
  testApp.use(errorMiddleware);

  apiServer = http.createServer(testApp);
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
});

beforeEach(() => {
  resetJwksCache();
  failNotificationsWrite = false;
  notificationDocs = [];
  orderDocs = [];

  userDocs = [
    {
      _id: customerId,
      name: 'Ayesha Customer',
      email: 'ayesha@pizzahub.test',
      role: 'customer',
      isBlocked: false,
    },
    {
      _id: vendorId,
      name: 'Marco Rossi',
      email: 'marco@pizzahub.test',
      role: 'vendor',
      isBlocked: false,
      businessName: 'Napoli Fire Oven',
      subscriptionPlan: 'free',
    },
    {
      _id: adminId,
      name: 'Nadia Admin',
      email: 'admin@pizzahub.test',
      role: 'admin',
      isBlocked: false,
    },
    {
      _id: blockedUserId,
      name: 'Blocked User',
      email: 'blocked@pizzahub.test',
      role: 'customer',
      isBlocked: true,
    },
  ];

  menuDocs = [
    {
      _id: menuItemId,
      vendorId,
      itemName: 'Margherita Classica',
      category: 'Classic Pizzas',
      description: 'Fresh mozzarella and San Marzano tomato sauce.',
      price: 12.0,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/margherita.jpg'],
      status: 'approved',
      createdAt: new Date(),
    },
    {
      _id: pendingMenuId,
      vendorId,
      itemName: 'Truffle Bianco',
      category: 'Specialty / Gourmet Pizzas',
      description: 'White pizza with black truffle oil and mushrooms.',
      price: 18.0,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/truffle.jpg'],
      status: 'pending',
      createdAt: new Date(),
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

describe('Notifications APIs & Business Event Triggers (/api/notifications)', () => {
  it('enforces authentication and blocked-account rejection on all notification routes', async () => {
    const blockedToken = await signUserToken(blockedUserId.toHexString(), 'blocked@pizzahub.test');

    assert.equal((await callApi('/api/notifications')).status, 401);
    assert.equal((await callApi('/api/notifications/unread-count')).status, 401);
    assert.equal((await callApi('/api/notifications/read-all', { method: 'PATCH' })).status, 401);
    assert.equal((await callApi('/api/notifications', { token: blockedToken })).status, 403);
  });

  it('automatically generates notifications for order placement, status updates, cancellation, and menu moderation', async () => {
    const custToken = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');
    const vendToken = await signUserToken(vendorId.toHexString(), 'marco@pizzahub.test');
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');

    // 1. Customer places order -> notifies customer (order_placed) & vendor (new_order)
    const order1 = (
      await callApi('/api/orders', {
        method: 'POST',
        token: custToken,
        body: {
          items: [{ menuItemId: menuItemId.toHexString(), quantity: 1 }],
          deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
          contactPhone: '+8801711000001',
        },
      })
    ).body.order;

    // 2. Vendor accepts order -> notifies customer (order_status)
    await callApi(`/api/vendor/orders/${order1.id}/status`, {
      method: 'PATCH',
      token: vendToken,
      body: { status: 'accepted' },
    });

    // 3. Customer places second order and cancels -> notifies both customer & vendor
    const order2 = (
      await callApi('/api/orders', {
        method: 'POST',
        token: custToken,
        body: {
          items: [{ menuItemId: menuItemId.toHexString(), quantity: 2 }],
          deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
          contactPhone: '+8801711000001',
        },
      })
    ).body.order;
    await callApi(`/api/orders/${order2.id}/cancel`, {
      method: 'PATCH',
      token: custToken,
    });

    // 4. Admin approves pending menu item -> notifies vendor (menu_approved)
    await callApi(`/api/admin/menu/${pendingMenuId.toHexString()}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'approved' },
    });

    const custNotifs = await callApi('/api/notifications', { token: custToken });
    assert.equal(custNotifs.status, 200);
    assert.equal(custNotifs.body.totalCount, 4);
    assert.equal(custNotifs.body.unreadCount, 4);
    assert.deepEqual(
      custNotifs.body.notifications.map((n) => n.type).sort(),
      ['order_cancelled', 'order_placed', 'order_placed', 'order_status'],
    );

    const vendNotifs = await callApi('/api/notifications', { token: vendToken });
    assert.equal(vendNotifs.status, 200);
    assert.equal(vendNotifs.body.totalCount, 4);
    assert.deepEqual(
      vendNotifs.body.notifications.map((n) => n.type).sort(),
      ['menu_approved', 'new_order', 'new_order', 'vendor_order_cancelled'],
    );

    // Filtering by unread & type + pagination
    const filtered = await callApi('/api/notifications?unread=true&type=new_order&page=1&limit=1', {
      token: vendToken,
    });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.notifications.length, 1);
    assert.equal(filtered.body.pagination.total, 2);
    assert.equal(filtered.body.pagination.hasNextPage, true);
  });

  it('enforces notification ownership, marks single and all as read, and validates IDs', async () => {
    const custToken = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');
    const vendToken = await signUserToken(vendorId.toHexString(), 'marco@pizzahub.test');
    const mockDb = getMockDatabase();

    await safeNotify(
      {
        userId: customerId.toHexString(),
        role: 'customer',
        type: 'order_placed',
        title: 'First',
        message: 'First notification',
        eventKey: 'k1',
      },
      mockDb,
    );
    await safeNotify(
      {
        userId: customerId.toHexString(),
        role: 'customer',
        type: 'order_status',
        title: 'Second',
        message: 'Second notification',
        eventKey: 'k2',
      },
      mockDb,
    );
    const vendorNotif = await safeNotify(
      {
        userId: vendorId.toHexString(),
        role: 'vendor',
        type: 'new_order',
        title: 'Vendor One',
        message: 'Vendor notification',
        eventKey: 'k3',
      },
      mockDb,
    );

    // Duplicate eventKey is ignored cleanly
    await safeNotify(
      {
        userId: vendorId.toHexString(),
        role: 'vendor',
        type: 'new_order',
        title: 'Vendor One Duplicate',
        message: 'Should not duplicate',
        eventKey: 'k3',
      },
      mockDb,
    );
    assert.equal(notificationDocs.length, 3);

    // Unread count
    const countBefore = await callApi('/api/notifications/unread-count', { token: custToken });
    assert.equal(countBefore.status, 200);
    assert.equal(countBefore.body.unreadCount, 2);

    // Customer cannot mark vendor's notification as read (404)
    assert.equal(
      (
        await callApi(`/api/notifications/${vendorNotif.id}/read`, {
          method: 'PATCH',
          token: custToken,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await callApi(`/api/notifications/${missingNotifId.toHexString()}/read`, {
          method: 'PATCH',
          token: custToken,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await callApi('/api/notifications/bad-id/read', {
          method: 'PATCH',
          token: custToken,
        })
      ).status,
      400,
    );

    // Mark one notification read
    const firstId = notificationDocs.find((n) => n.eventKey === 'k1')._id.toHexString();
    const readOne = await callApi(`/api/notifications/${firstId}/read`, {
      method: 'PATCH',
      token: custToken,
    });
    assert.equal(readOne.status, 200);
    assert.equal(readOne.body.notification.read, true);

    const countMid = await callApi('/api/notifications/unread-count', { token: custToken });
    assert.equal(countMid.body.unreadCount, 1);

    // Mark all read via PATCH /read-all leaves vendor's notification unread
    const readAll = await callApi('/api/notifications/read-all', {
      method: 'PATCH',
      token: custToken,
    });
    assert.equal(readAll.status, 200);
    assert.equal(readAll.body.count, 1);

    const custCountAfter = await callApi('/api/notifications/unread-count', { token: custToken });
    assert.equal(custCountAfter.body.unreadCount, 0);

    const vendCountAfter = await callApi('/api/notifications/unread-count', { token: vendToken });
    assert.equal(vendCountAfter.body.unreadCount, 1);

    // Also verify POST /api/notifications/mark-all-read client alias
    const markAllAlias = await callApi('/api/notifications/mark-all-read', {
      method: 'POST',
      token: vendToken,
    });
    assert.equal(markAllAlias.status, 200);
    assert.equal(markAllAlias.body.count, 1);
  });

  it('isolates notification failures so order placement still succeeds', async () => {
    const custToken = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');
    failNotificationsWrite = true;

    const orderRes = await callApi('/api/orders', {
      method: 'POST',
      token: custToken,
      body: {
        items: [{ menuItemId: menuItemId.toHexString(), quantity: 1 }],
        deliveryAddress: 'House 12, Road 4, Banani, Dhaka',
        contactPhone: '+8801711000001',
      },
    });
    assert.equal(orderRes.status, 201);
    assert.equal(orderDocs.length, 1);
    assert.equal(notificationDocs.length, 0);
  });

  it('wires /api/notifications cleanly on src/app.js', async () => {
    const mainServer = http.createServer(app);
    await new Promise((resolve) => mainServer.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${mainServer.address().port}`;
      assert.equal((await fetch(`${base}/api/notifications`)).status, 401);
      assert.equal((await fetch(`${base}/api/notifications/unread-count`)).status, 401);
    } finally {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });
});
