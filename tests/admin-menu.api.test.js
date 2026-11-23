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
import { createMenuRouter } from '../src/routes/menu.routes.js';

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

const adminId = new ObjectId('677000000000000000000001');
const vendorOneId = new ObjectId('677000000000000000000002');
const vendorTwoId = new ObjectId('677000000000000000000003');
const customerId = new ObjectId('677000000000000000000004');
const blockedAdminId = new ObjectId('677000000000000000000005');
const missingItemId = new ObjectId('677100000000000000000099');

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
    if (condition instanceof RegExp) {
      if (typeof docVal !== 'string' || !condition.test(docVal)) {
        return false;
      }
    } else if (condition instanceof ObjectId) {
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
              `MongoServerError: ${['mongodb+srv', '://admin:AdminDbSecret@mock.example.invalid/pizzahub'].join('')} failed`,
            );
          }
          const match = source.find((doc) => matchesFilter(doc, filter));
          return match ? applyProjection(match, options.projection) : null;
        },

        find(filter = {}, options = {}) {
          return {
            async toArray() {
              if (dbMode === 'error') {
                throw new Error(
                  `MongoServerError: ${['mongodb+srv', '://admin:AdminDbSecret@mock.example.invalid/pizzahub'].join('')} failed`,
                );
              }
              return source
                .filter((doc) => matchesFilter(doc, filter))
                .map((doc) => applyProjection(doc, options.projection));
            },
          };
        },

        async countDocuments(filter = {}) {
          if (dbMode === 'error') {
            throw new Error('MongoServerError');
          }
          return source.filter((doc) => matchesFilter(doc, filter)).length;
        },

        async findOneAndUpdate(filter, update, options = {}) {
          if (dbMode === 'error') {
            throw new Error('MongoServerError');
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
            throw new Error('MongoServerError');
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
    .setProtectedHeader({ alg: 'EdDSA', kid: 'admin-menu-key' })
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

function assertSafeAdminItem(item) {
  assert.equal('_id' in item, false);
  assert.ok(item.vendor);
  for (const forbidden of [
    '_id',
    'passwordHash',
    'sessions',
    'tokens',
    'contactPhone',
    'deliveryAddress',
  ]) {
    assert.equal(forbidden in item.vendor, false, `Sensitive vendor field exposed: ${forbidden}`);
  }
}

before(async () => {
  keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: 'admin-menu-key',
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
  dbMode = 'normal';

  userDocs = [
    {
      _id: adminId,
      name: 'Nadia Admin',
      email: 'admin@pizzahub.test',
      role: 'admin',
      isBlocked: false,
      subscriptionPlan: 'free',
      passwordHash: 'admin-hash',
    },
    {
      _id: vendorOneId,
      name: 'Marco Rossi',
      email: 'marco@pizzahub.test',
      role: 'vendor',
      isBlocked: false,
      businessName: 'Napoli Fire Oven',
      subscriptionPlan: 'free',
      subscriptionExpiresAt: null,
      contactPhone: '+8801700000001',
      passwordHash: 'vendor1-hash',
      sessions: ['s1'],
    },
    {
      _id: vendorTwoId,
      name: 'Sara Khan',
      email: 'sara@pizzahub.test',
      role: 'vendor',
      isBlocked: false,
      businessName: 'Dhaka Gourmet Crust',
      subscriptionPlan: 'premium',
      subscriptionExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
      contactPhone: '+8801700000002',
      passwordHash: 'vendor2-hash',
    },
    {
      _id: customerId,
      name: 'Customer One',
      email: 'customer@pizzahub.test',
      role: 'customer',
      isBlocked: false,
      subscriptionPlan: 'free',
    },
    {
      _id: blockedAdminId,
      name: 'Blocked Admin',
      email: 'blocked.admin@pizzahub.test',
      role: 'admin',
      isBlocked: true,
      subscriptionPlan: 'free',
    },
  ];

  menuDocs = [
    {
      _id: new ObjectId('677100000000000000000001'),
      vendorId: vendorOneId,
      itemName: 'Pending Garlic Pizza',
      category: 'Classic Pizzas',
      description: 'Fresh garlic butter crust awaiting moderation review.',
      price: 11.0,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/pending.jpg'],
      status: 'pending',
      createdAt: new Date('2026-11-10T10:00:00.000Z'),
    },
    {
      _id: new ObjectId('677100000000000000000002'),
      vendorId: vendorTwoId,
      itemName: 'Approved Truffle Pie',
      category: 'Specialty / Gourmet Pizzas',
      description: 'Black truffle oil and burrata on sourdough crust.',
      price: 24.5,
      location: 'Gulshan, Dhaka',
      images: ['https://i.ibb.co/example/approved.jpg'],
      status: 'approved',
      createdAt: new Date('2026-11-09T10:00:00.000Z'),
    },
    {
      _id: new ObjectId('677100000000000000000003'),
      vendorId: vendorOneId,
      itemName: 'Rejected Mystery Dish',
      category: 'Sides & Appetizers',
      description: 'Missing detailed ingredients and allergen breakdown.',
      price: 8.5,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/rejected.jpg'],
      status: 'rejected',
      rejectionReason: 'Incomplete ingredient description',
      createdAt: new Date('2026-11-08T10:00:00.000Z'),
    },
    {
      _id: new ObjectId('677100000000000000000004'),
      vendorId: vendorTwoId,
      itemName: 'Inactive Seasonal Soda',
      category: 'Beverages & Desserts',
      description: 'Seasonal house craft soda temporarily paused.',
      price: 4.5,
      location: 'Gulshan, Dhaka',
      images: ['https://i.ibb.co/example/soda.jpg'],
      status: 'inactive',
      createdAt: new Date('2026-11-07T10:00:00.000Z'),
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

describe('Admin Menu Moderation APIs (/api/admin/menu)', () => {
  it('restricts access to active admin users only', async () => {
    const vendorToken = await signUserToken(vendorOneId.toHexString(), 'marco@pizzahub.test');
    const customerToken = await signUserToken(customerId.toHexString(), 'customer@pizzahub.test');
    const blockedAdminToken = await signUserToken(
      blockedAdminId.toHexString(),
      'blocked.admin@pizzahub.test',
    );
    const pendingId = menuDocs[0]._id.toHexString();

    assert.equal((await callApi('/api/admin/menu')).status, 401);
    assert.equal((await callApi('/api/admin/menu', { token: vendorToken })).status, 403);
    assert.equal((await callApi('/api/admin/menu', { token: customerToken })).status, 403);
    assert.equal((await callApi('/api/admin/menu', { token: blockedAdminToken })).status, 403);

    const vendorModerate = await callApi(`/api/admin/menu/${pendingId}/status`, {
      method: 'PATCH',
      token: vendorToken,
      body: { status: 'approved' },
    });
    assert.equal(vendorModerate.status, 403);
  });

  it('lists all items across vendors with search, filters, sorting, pagination, and safe vendor data', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');

    const allRes = await callApi('/api/admin/menu', { token: adminToken });
    assert.equal(allRes.status, 200);
    assert.equal(allRes.body.items.length, 4);
    assert.deepEqual(allRes.body.counts, {
      all: 4,
      pending: 1,
      approved: 1,
      rejected: 1,
      inactive: 1,
    });
    for (const item of allRes.body.items) {
      assertSafeAdminItem(item);
    }

    // Filter by status=pending & vendorId
    const pendingRes = await callApi(
      `/api/admin/menu?status=pending&vendorId=${vendorOneId.toHexString()}`,
      { token: adminToken },
    );
    assert.equal(pendingRes.status, 200);
    assert.equal(pendingRes.body.items.length, 1);
    assert.equal(pendingRes.body.items[0].itemName, 'Pending Garlic Pizza');

    // Search by vendor businessName
    const searchRes = await callApi('/api/admin/menu?search=Dhaka%20Gourmet', { token: adminToken });
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.items.length, 2);

    // Sort price-asc & paginate
    const pagedRes = await callApi('/api/admin/menu?sort=price-asc&page=1&limit=2', {
      token: adminToken,
    });
    assert.equal(pagedRes.status, 200);
    assert.deepEqual(
      pagedRes.body.items.map((i) => i.price),
      [4.5, 8.5],
    );
    assert.deepEqual(pagedRes.body.pagination, {
      page: 1,
      limit: 2,
      total: 4,
      totalPages: 2,
      hasNextPage: true,
      hasPrevPage: false,
    });

    // Invalid vendorId or sort returns 400
    assert.equal(
      (await callApi('/api/admin/menu?vendorId=bad-id', { token: adminToken })).status,
      400,
    );
    assert.equal(
      (await callApi('/api/admin/menu?sort=invalid', { token: adminToken })).status,
      400,
    );
  });

  it('retrieves single menu item details and validates ObjectIds', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');
    const targetId = menuDocs[0]._id.toHexString();

    const okRes = await callApi(`/api/admin/menu/${targetId}`, { token: adminToken });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.body.item.id, targetId);
    assertSafeAdminItem(okRes.body.item);

    assert.equal(
      (await callApi(`/api/admin/menu/${missingItemId.toHexString()}`, { token: adminToken }))
        .status,
      404,
    );
    assert.equal(
      (await callApi('/api/admin/menu/invalid-id', { token: adminToken })).status,
      400,
    );
  });

  it('approves and rejects pending items, updates public visibility, and blocks invalid transitions', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');
    const pendingId = menuDocs[0]._id.toHexString();
    const approvedId = menuDocs[1]._id.toHexString();
    const rejectedId = menuDocs[2]._id.toHexString();

    // Initially only 1 approved item is visible on public /api/menu
    const beforePublic = await callApi('/api/menu');
    assert.equal(beforePublic.status, 200);
    assert.equal(beforePublic.body.items.length, 1);

    // Approve pending item -> becomes publicly visible
    const approveRes = await callApi(`/api/admin/menu/${pendingId}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'approved' },
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.item.status, 'approved');
    assert.ok(approveRes.body.item.approvedAt);

    const afterApprovePublic = await callApi('/api/menu');
    assert.equal(afterApprovePublic.status, 200);
    assert.equal(afterApprovePublic.body.items.length, 2);

    // Reject an approved item with rejectionReason -> removed from public menu
    const rejectRes = await callApi(`/api/admin/menu/${approvedId}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'rejected', rejectionReason: 'Image quality is too low' },
    });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.item.status, 'rejected');
    assert.equal(rejectRes.body.item.rejectionReason, 'Image quality is too low');
    assert.ok(rejectRes.body.item.rejectedAt);

    const afterRejectPublic = await callApi('/api/menu');
    assert.equal(afterRejectPublic.status, 200);
    assert.equal(afterRejectPublic.body.items.length, 1);
    assert.equal(afterRejectPublic.body.items[0].id, pendingId);

    // Invalid status transitions
    assert.equal(
      (
        await callApi(`/api/admin/menu/${pendingId}/status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'approved' },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await callApi(`/api/admin/menu/${rejectedId}/status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'rejected' },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await callApi(`/api/admin/menu/${rejectedId}/status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'approved' },
        })
      ).status,
      400,
    );

    // Pending item cannot jump directly to inactive
    const newPendingId = new ObjectId();
    menuDocs.push({
      _id: newPendingId,
      vendorId: vendorOneId,
      itemName: 'Another Pending Pie',
      category: 'Classic Pizzas',
      description: 'Fresh classic pizza awaiting admin approval.',
      price: 12,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/p2.jpg'],
      status: 'pending',
      createdAt: new Date(),
    });
    assert.equal(
      (
        await callApi(`/api/admin/menu/${newPendingId.toHexString()}/status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'inactive' },
        })
      ).status,
      400,
    );
  });

  it('prevents admin self-moderation and enforces Free plan 3-active-item cap on approval', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');

    // Admin self-moderation blocked (403)
    const selfItemId = new ObjectId();
    menuDocs.push({
      _id: selfItemId,
      vendorId: adminId,
      itemName: 'Admin Own Pizza',
      category: 'Classic Pizzas',
      description: 'An admin-owned test pizza listing.',
      price: 15,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/self.jpg'],
      status: 'pending',
      createdAt: new Date(),
    });
    const selfRes = await callApi(`/api/admin/menu/${selfItemId.toHexString()}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'approved' },
    });
    assert.equal(selfRes.status, 403);

    // Free vendor already has 3 approved items -> approving a 4th fails with 409
    for (let i = 0; i < 3; i += 1) {
      menuDocs.push({
        _id: new ObjectId(),
        vendorId: vendorOneId,
        itemName: `Active Item ${i}`,
        category: 'Classic Pizzas',
        description: 'Active approved item counting toward Free plan cap.',
        price: 10 + i,
        location: 'Banani, Dhaka',
        images: ['https://i.ibb.co/example/a.jpg'],
        status: 'approved',
        createdAt: new Date(),
      });
    }

    const fourthPendingRes = await callApi(`/api/admin/menu/${menuDocs[0]._id.toHexString()}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'approved' },
    });
    assert.equal(fourthPendingRes.status, 409);
  });

  it('deletes inappropriate items while protecting items referenced by orders', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');
    const orderedItemId = menuDocs[1]._id;
    const deletableItemId = menuDocs[2]._id;

    orderDocs.push({ _id: new ObjectId(), itemId: orderedItemId });

    const blockedDel = await callApi(`/api/admin/menu/${orderedItemId.toHexString()}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(blockedDel.status, 409);

    const okDel = await callApi(`/api/admin/menu/${deletableItemId.toHexString()}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(okDel.status, 200);
    assert.equal(menuDocs.some((d) => d._id.equals(deletableItemId)), false);
  });

  it('handles database failures safely and wires /api/admin/menu on src/app.js', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');
    dbMode = 'error';

    const dbErr = await callApi('/api/admin/menu', { token: adminToken });
    assert.equal(dbErr.status, 503);
    assert.equal(JSON.stringify(dbErr.body).includes('AdminDbSecret'), false);

    const mainServer = http.createServer(app);
    await new Promise((resolve) => mainServer.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${mainServer.address().port}`;
      assert.equal((await fetch(`${base}/api/admin/menu`)).status, 401);
      assert.equal((await fetch(`${base}/api/vendor/menu`)).status, 401);
      assert.equal((await fetch(`${base}/api/menu/invalid-id`)).status, 400);
    } finally {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });
});
