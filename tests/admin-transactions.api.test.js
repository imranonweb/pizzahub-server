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
import { createAdminTransactionsRouter } from '../src/routes/admin-transactions.routes.js';

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
let transactionDocs = [];

const adminId = new ObjectId('67a000000000000000000001');
const blockedAdminId = new ObjectId('67a000000000000000000002');
const vendorOneId = new ObjectId('67a000000000000000000003');
const vendorTwoId = new ObjectId('67a000000000000000000004');
const customerId = new ObjectId('67a000000000000000000005');

const txPaidId = new ObjectId('67a100000000000000000001');
const txFailedId = new ObjectId('67a100000000000000000002');
const txCancelledId = new ObjectId('67a100000000000000000003');
const missingTxId = new ObjectId('67a100000000000000000099');

function valuesEqual(a, b) {
  if (a instanceof ObjectId && b instanceof ObjectId) {
    return a.equals(b);
  }
  return a === b;
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

    const docVal = doc[key];
    if (condition instanceof ObjectId) {
      if (!(docVal instanceof ObjectId) || !docVal.equals(condition)) {
        return false;
      }
    } else if (condition && typeof condition === 'object' && '$in' in condition) {
      if (!condition.$in.some((candidate) => valuesEqual(docVal, candidate))) {
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
      const source = name === 'transactions' ? transactionDocs : name === 'users' ? userDocs : [];
      return {
        async findOne(filter, options = {}) {
          if (dbMode === 'error') {
            throw new Error(
              'MongoNetworkError: mongodb+srv://admin:TxSecret@cluster.mongodb.net/pizzahub failed',
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
                  'MongoNetworkError: mongodb+srv://admin:TxSecret@cluster.mongodb.net/pizzahub failed',
                );
              }
              return results.map((doc) => applyProjection(doc, options.projection));
            },
          };
          return cursor;
        },
      };
    },
  };
}

async function signUserToken(sub, email) {
  return new SignJWT({ sub, email })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'admin-tx-key-1' })
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

  const res = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  publicJwk = await exportJWK(keyPair.publicKey);
  publicJwk.kid = 'admin-tx-key-1';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';

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

  resetJwksCache();
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
  testApp.use(cors());
  testApp.use(express.json());
  testApp.use(
    '/api/admin/transactions',
    createAdminTransactionsRouter({ authMiddleware, getDatabase: getMockDatabase }),
  );
  testApp.use(notFoundMiddleware);
  testApp.use(errorMiddleware);

  apiServer = http.createServer(testApp);
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
});

beforeEach(() => {
  dbMode = 'normal';
  userDocs = [
    {
      _id: adminId,
      name: 'Platform Admin',
      email: 'admin@pizzahub.test',
      role: 'admin',
      isBlocked: false,
      passwordHash: 'secret-admin-hash',
    },
    {
      _id: blockedAdminId,
      name: 'Suspended Admin',
      email: 'blocked.admin@pizzahub.test',
      role: 'admin',
      isBlocked: true,
    },
    {
      _id: vendorOneId,
      name: 'Marco Rossi',
      email: 'marco@pizzahub.test',
      businessName: 'Napoli Fire Oven',
      role: 'vendor',
      isBlocked: false,
      subscriptionPlan: 'premium',
      subscriptionStatus: 'active',
      passwordHash: 'secret-vendor-hash',
    },
    {
      _id: vendorTwoId,
      name: 'Sara Khan',
      email: 'sara@pizzahub.test',
      businessName: 'Dhaka Gourmet Slice',
      role: 'vendor',
      isBlocked: false,
      subscriptionPlan: 'free',
      subscriptionStatus: 'past_due',
    },
    {
      _id: customerId,
      name: 'Ayesha Customer',
      email: 'ayesha@pizzahub.test',
      role: 'customer',
      isBlocked: false,
    },
  ];

  transactionDocs = [
    {
      _id: txPaidId,
      vendorId: vendorOneId,
      plan: 'premium',
      amount: 2900,
      currency: 'usd',
      stripeSessionId: 'cs_test_paid_1',
      stripeSubscriptionId: 'sub_test_1',
      stripeEventId: 'evt_paid_1',
      eventType: 'checkout.session.completed',
      status: 'paid',
      createdAt: new Date('2026-11-20T10:00:00.000Z'),
    },
    {
      _id: txFailedId,
      vendorId: vendorTwoId,
      plan: 'premium',
      amount: 2900,
      currency: 'usd',
      stripeSessionId: null,
      stripeSubscriptionId: 'sub_test_2',
      stripeInvoiceId: 'in_fail_2',
      stripeEventId: 'evt_fail_2',
      eventType: 'invoice.payment_failed',
      status: 'failed',
      createdAt: new Date('2026-11-21T10:00:00.000Z'),
    },
    {
      _id: txCancelledId,
      vendorId: vendorTwoId,
      plan: 'free',
      amount: 0,
      currency: 'usd',
      stripeSessionId: null,
      stripeSubscriptionId: 'sub_test_2',
      stripeEventId: 'evt_del_3',
      eventType: 'customer.subscription.deleted',
      status: 'cancelled',
      createdAt: new Date('2026-11-22T10:00:00.000Z'),
    },
  ];
});

after(async () => {
  await Promise.all([
    apiServer ? new Promise((resolve) => apiServer.close(resolve)) : Promise.resolve(),
    jwksServer ? new Promise((resolve) => jwksServer.close(resolve)) : Promise.resolve(),
  ]);
});

describe('Admin Transactions APIs (/api/admin/transactions)', () => {
  it('restricts access to active admin users only (401/403)', async () => {
    const vendorToken = await signUserToken(vendorOneId.toHexString(), 'marco@pizzahub.test');
    const customerToken = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');
    const blockedAdminToken = await signUserToken(
      blockedAdminId.toHexString(),
      'blocked.admin@pizzahub.test',
    );

    assert.equal((await callApi('/api/admin/transactions')).status, 401);
    assert.equal((await callApi('/api/admin/transactions', { token: vendorToken })).status, 403);
    assert.equal((await callApi('/api/admin/transactions', { token: customerToken })).status, 403);
    assert.equal(
      (await callApi('/api/admin/transactions', { token: blockedAdminToken })).status,
      403,
    );
  });

  it('lists platform transactions with safe vendor info, counts, search, filters, sorting, and pagination', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');

    const res = await callApi('/api/admin/transactions', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.transactions.length, 3);
    assert.deepEqual(res.body.counts, {
      total: 3,
      paid: 1,
      failed: 1,
      pending: 0,
      cancelled: 1,
      totalRevenueCents: 2900,
    });
    assert.equal(res.body.transactions[0].id, txCancelledId.toHexString());
    assert.equal(res.body.transactions[2].vendor.businessName, 'Napoli Fire Oven');
    assert.equal(res.body.transactions[2].amountFormatted, 29);
    assert.equal('passwordHash' in res.body.transactions[2].vendor, false);

    // Filter by status=failed
    const failedRes = await callApi('/api/admin/transactions?status=failed', { token: adminToken });
    assert.equal(failedRes.status, 200);
    assert.equal(failedRes.body.transactions.length, 1);
    assert.equal(failedRes.body.transactions[0].id, txFailedId.toHexString());

    // Search by vendor business name
    const searchRes = await callApi('/api/admin/transactions?search=Napoli', { token: adminToken });
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.transactions.length, 1);
    assert.equal(searchRes.body.transactions[0].id, txPaidId.toHexString());

    // Filter by vendorId & sort amount-desc & paginate
    const pagedRes = await callApi(
      `/api/admin/transactions?vendorId=${vendorTwoId.toHexString()}&sort=amount-desc&page=1&limit=1`,
      { token: adminToken },
    );
    assert.equal(pagedRes.status, 200);
    assert.equal(pagedRes.body.transactions.length, 1);
    assert.equal(pagedRes.body.transactions[0].amount, 2900);
    assert.equal(pagedRes.body.pagination.total, 2);
    assert.equal(pagedRes.body.pagination.hasNextPage, true);

    // Validation rejects invalid query params
    assert.equal(
      (await callApi('/api/admin/transactions?status=forged', { token: adminToken })).status,
      400,
    );
    assert.equal(
      (await callApi('/api/admin/transactions?vendorId=bad-id', { token: adminToken })).status,
      400,
    );
  });

  it('retrieves a single transaction by ID and enforces strict immutability (403 on mutations)', async () => {
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');

    const detailRes = await callApi(`/api/admin/transactions/${txFailedId.toHexString()}`, {
      token: adminToken,
    });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.transaction.status, 'failed');
    assert.equal(detailRes.body.transaction.vendor.businessName, 'Dhaka Gourmet Slice');

    assert.equal(
      (await callApi(`/api/admin/transactions/${missingTxId.toHexString()}`, { token: adminToken }))
        .status,
      404,
    );
    assert.equal(
      (await callApi('/api/admin/transactions/not-an-id', { token: adminToken })).status,
      400,
    );

    // Admin must NOT be able to edit, create, or delete payment records
    for (const attempt of [
      { method: 'POST', path: '/api/admin/transactions', body: { status: 'paid', amount: 2900 } },
      {
        method: 'PATCH',
        path: `/api/admin/transactions/${txFailedId.toHexString()}`,
        body: { status: 'paid' },
      },
      {
        method: 'PUT',
        path: `/api/admin/transactions/${txFailedId.toHexString()}`,
        body: { status: 'paid' },
      },
      {
        method: 'DELETE',
        path: `/api/admin/transactions/${txFailedId.toHexString()}`,
      },
    ]) {
      const mutRes = await callApi(attempt.path, {
        method: attempt.method,
        token: adminToken,
        body: attempt.body,
      });
      assert.equal(mutRes.status, 403);
    }

    // Confirm failed transaction was not altered
    assert.equal(transactionDocs.find((t) => t._id.equals(txFailedId)).status, 'failed');
  });

  it('wires /api/admin/transactions cleanly on src/app.js', async () => {
    const mainServer = http.createServer(app);
    await new Promise((resolve) => mainServer.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${mainServer.address().port}`;
      assert.equal((await fetch(`${base}/api/admin/transactions`)).status, 401);
    } finally {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });
});
