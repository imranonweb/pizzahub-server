import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ObjectId } from 'mongodb';
import Stripe from 'stripe';
import app from '../src/app.js';
import { resetJwksCache, verifyAccessToken } from '../src/config/jwt.js';
import { verifyStripeWebhookSignature } from '../src/config/stripe.js';
import { createAuthMiddleware } from '../src/middleware/auth.middleware.js';
import { errorMiddleware } from '../src/middleware/error.middleware.js';
import { notFoundMiddleware } from '../src/middleware/not-found.middleware.js';
import { createVendorSubscriptionRouter } from '../src/routes/vendor-subscription.routes.js';
import { createStripeWebhookRouter } from '../src/routes/webhook.routes.js';

const TEST_ISSUER = 'http://localhost:3000';
const TEST_AUDIENCE = 'http://localhost:3000';
const TEST_WEBHOOK_SECRET = 'whsec_test_pizzahub_secret_12345';

const stripeSdk = new Stripe('sk_test_pizzahub_dummy_key');

let jwksServer;
let jwksUrl;
let apiServer;
let apiBaseUrl;

let keyPair;
let publicJwk;
let userDocs = [];
let transactionDocs = [];
let notificationDocs = [];
let stripeCustomerCalls = [];
let stripeCheckoutCalls = [];
let stripePortalCalls = [];

const vendorId = new ObjectId('679000000000000000000001');
const customerId = new ObjectId('679000000000000000000002');
const adminId = new ObjectId('679000000000000000000003');
const blockedVendorId = new ObjectId('679000000000000000000004');

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
        name === 'users'
          ? userDocs
          : name === 'transactions'
            ? transactionDocs
            : name === 'notifications'
              ? notificationDocs
              : [];

      return {
        async findOne(filter, options = {}) {
          const match = source.find((doc) => matchesFilter(doc, filter));
          return match ? applyProjection(match, options.projection) : null;
        },

        find(filter = {}, options = {}) {
          let results = source.filter((doc) => matchesFilter(doc, filter));
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
            limit(n) {
              limitCount = n;
              return cursor;
            },
            async toArray() {
              return results
                .slice(0, limitCount)
                .map((doc) => applyProjection(doc, options.projection));
            },
          };
          return cursor;
        },

        async insertOne(doc) {
          if (name === 'transactions' && doc.stripeEventId) {
            const exists = source.some((t) => t.stripeEventId === doc.stripeEventId);
            if (exists) {
              const dupErr = new Error('Duplicate stripeEventId');
              dupErr.code = 11000;
              throw dupErr;
            }
          }
          const insertedId = doc._id ?? new ObjectId();
          source.push({ ...doc, _id: insertedId });
          return { acknowledged: true, insertedId };
        },

        async updateOne(filter, update) {
          const match = source.find((doc) => matchesFilter(doc, filter));
          if (!match) {
            return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
          }
          if (update?.$set) {
            Object.assign(match, update.$set);
          }
          return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
        },

        async findOneAndUpdate(filter, update, options = {}) {
          const match = source.find((doc) => matchesFilter(doc, filter));
          if (!match) {
            return null;
          }
          if (update?.$set) {
            Object.assign(match, update.$set);
          }
          return applyProjection(match, options.projection);
        },
      };
    },
  };
}

function createMockStripeClient() {
  return {
    webhooks: stripeSdk.webhooks,
    customers: {
      async create(params) {
        stripeCustomerCalls.push(params);
        return { id: `cus_test_${stripeCustomerCalls.length}` };
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          stripeCheckoutCalls.push(params);
          return {
            id: `cs_test_${stripeCheckoutCalls.length}`,
            url: `https://checkout.stripe.com/c/pay/cs_test_${stripeCheckoutCalls.length}`,
          };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          stripePortalCalls.push(params);
          return {
            id: `bps_test_${stripePortalCalls.length}`,
            url: `https://billing.stripe.com/p/session/bps_test_${stripePortalCalls.length}`,
          };
        },
      },
    },
  };
}

async function signUserToken(userId, email) {
  return new SignJWT({ sub: userId, email })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'sub-api-key' })
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

async function sendSignedWebhook(eventPayload, { signature } = {}) {
  const rawBody = JSON.stringify(eventPayload);
  const sigHeader =
    signature ??
    stripeSdk.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: TEST_WEBHOOK_SECRET,
    });

  const response = await fetch(`${apiBaseUrl}/api/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sigHeader ? { 'Stripe-Signature': sigHeader } : {}),
    },
    body: rawBody,
  });

  const payload = await response.json();
  return { status: response.status, body: payload };
}

before(async () => {
  keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: 'sub-api-key',
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

  const mockStripe = createMockStripeClient();

  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors({ origin: 'http://localhost:3000', credentials: true }));
  testApp.use(
    '/api/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    createStripeWebhookRouter({
      getDatabase: getMockDatabase,
      stripeClient: mockStripe,
      verifyWebhook: ({ rawBody, signature, stripeClient }) =>
        verifyStripeWebhookSignature({
          rawBody,
          signature,
          stripeClient,
          webhookSecret: TEST_WEBHOOK_SECRET,
        }),
    }),
  );
  testApp.use(express.json());
  testApp.use(
    '/api/vendor/subscription',
    createVendorSubscriptionRouter({
      authMiddleware,
      getDatabase: getMockDatabase,
      stripeClient: mockStripe,
    }),
  );
  testApp.use(notFoundMiddleware);
  testApp.use(errorMiddleware);

  apiServer = http.createServer(testApp);
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
});

beforeEach(() => {
  resetJwksCache();
  stripeCustomerCalls = [];
  stripeCheckoutCalls = [];
  stripePortalCalls = [];
  transactionDocs = [];
  notificationDocs = [];

  userDocs = [
    {
      _id: vendorId,
      name: 'Marco Rossi',
      email: 'marco@pizzahub.test',
      role: 'vendor',
      isBlocked: false,
      businessName: 'Napoli Fire Oven',
      subscriptionPlan: 'free',
      subscriptionStatus: 'free',
      subscriptionExpiresAt: null,
      cancelAtPeriodEnd: false,
    },
    {
      _id: customerId,
      name: 'Ayesha Customer',
      email: 'ayesha@pizzahub.test',
      role: 'customer',
      isBlocked: false,
      subscriptionPlan: 'free',
    },
    {
      _id: adminId,
      name: 'Nadia Admin',
      email: 'admin@pizzahub.test',
      role: 'admin',
      isBlocked: false,
      subscriptionPlan: 'free',
    },
    {
      _id: blockedVendorId,
      name: 'Blocked Vendor',
      email: 'blocked@pizzahub.test',
      role: 'vendor',
      isBlocked: true,
      subscriptionPlan: 'free',
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

describe('Vendor Subscriptions & Stripe Webhooks', () => {
  it('enforces vendor-only non-blocked access on subscription endpoints', async () => {
    const customerToken = await signUserToken(customerId.toHexString(), 'ayesha@pizzahub.test');
    const adminToken = await signUserToken(adminId.toHexString(), 'admin@pizzahub.test');
    const blockedToken = await signUserToken(
      blockedVendorId.toHexString(),
      'blocked@pizzahub.test',
    );

    assert.equal((await callApi('/api/vendor/subscription')).status, 401);
    assert.equal(
      (
        await callApi('/api/vendor/subscription/checkout', {
          method: 'POST',
          token: customerToken,
          body: { plan: 'premium' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await callApi('/api/vendor/subscription/checkout', {
          method: 'POST',
          token: adminToken,
          body: { plan: 'premium' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await callApi('/api/vendor/subscription/checkout', {
          method: 'POST',
          token: blockedToken,
          body: { plan: 'premium' },
        })
      ).status,
      403,
    );
  });

  it('validates checkout inputs, prevents open redirects and forged prices, and creates Stripe Checkout Session without activating Premium', async () => {
    const vendorToken = await signUserToken(vendorId.toHexString(), 'marco@pizzahub.test');

    // Invalid plan
    assert.equal(
      (
        await callApi('/api/vendor/subscription/checkout', {
          method: 'POST',
          token: vendorToken,
          body: { plan: 'enterprise' },
        })
      ).status,
      400,
    );

    // Disallowed return URL origin (open redirect prevention)
    assert.equal(
      (
        await callApi('/api/vendor/subscription/checkout', {
          method: 'POST',
          token: vendorToken,
          body: { plan: 'premium', successUrl: 'https://evil.example.com/steal' },
        })
      ).status,
      400,
    );

    // Forged price/vendorId/subscriptionPlan rejected (403)
    for (const forged of [
      { price: 1 },
      { vendorId: customerId.toHexString() },
      { subscriptionPlan: 'premium' },
    ]) {
      assert.equal(
        (
          await callApi('/api/vendor/subscription/checkout', {
            method: 'POST',
            token: vendorToken,
            body: { plan: 'premium', ...forged },
          })
        ).status,
        403,
      );
    }

    // Valid checkout creation
    const res = await callApi('/api/vendor/subscription/checkout', {
      method: 'POST',
      token: vendorToken,
      body: { plan: 'premium' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.sessionId, 'cs_test_1');
    assert.ok(res.body.checkoutUrl.startsWith('https://checkout.stripe.com/'));
    assert.equal(stripeCustomerCalls.length, 1);
    assert.equal(stripeCheckoutCalls[0].mode, 'subscription');
    assert.equal(stripeCheckoutCalls[0].metadata.vendorId, vendorId.toHexString());

    // Checkout alone must NOT activate Premium before verified webhook
    const subRes = await callApi('/api/vendor/subscription', { token: vendorToken });
    assert.equal(subRes.status, 200);
    assert.equal(subRes.body.subscription.plan, 'free');
    assert.equal(subRes.body.plans.length, 2);

    // Portal works once stripeCustomerId is stored
    const portalRes = await callApi('/api/vendor/subscription/portal', {
      method: 'POST',
      token: vendorToken,
      body: {},
    });
    assert.equal(portalRes.status, 200);
    assert.ok(portalRes.body.url.startsWith('https://billing.stripe.com/'));
  });

  it('rejects missing or invalid Stripe webhook signatures (400)', async () => {
    const fakeEvent = {
      id: 'evt_invalid_1',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    };

    const noSig = await sendSignedWebhook(fakeEvent, { signature: '' });
    assert.equal(noSig.status, 400);

    const badSig = await sendSignedWebhook(fakeEvent, {
      signature: 't=12345,v1=deadbeefdeadbeef',
    });
    assert.equal(badSig.status, 400);
  });

  it('activates Premium on verified webhook, deduplicates duplicate events, protects role/isBlocked, and handles out-of-order events', async () => {
    const vendorToken = await signUserToken(vendorId.toHexString(), 'marco@pizzahub.test');
    const tNow = Math.floor(Date.now() / 1000);
    const futurePeriodEnd = tNow + 30 * 24 * 60 * 60;

    // 1. checkout.session.completed activates Premium + creates transaction + notification
    const checkoutEvent = {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      created: tNow,
      data: {
        object: {
          id: 'cs_live_1',
          payment_status: 'paid',
          amount_total: 2900,
          currency: 'usd',
          customer: 'cus_live_1',
          subscription: 'sub_live_1',
          client_reference_id: vendorId.toHexString(),
          metadata: { vendorId: vendorId.toHexString(), plan: 'premium' },
        },
      },
    };

    const r1 = await sendSignedWebhook(checkoutEvent);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.duplicate, false);

    const vendorDoc = userDocs.find((u) => u._id.equals(vendorId));
    assert.equal(vendorDoc.subscriptionPlan, 'premium');
    assert.equal(vendorDoc.subscriptionStatus, 'active');
    assert.equal(vendorDoc.role, 'vendor');
    assert.equal(vendorDoc.isBlocked, false);
    assert.equal(transactionDocs.length, 1);
    assert.equal(notificationDocs.length, 1);

    // 2. Duplicate delivery of same event.id is idempotent
    const rDup = await sendSignedWebhook(checkoutEvent);
    assert.equal(rDup.status, 200);
    assert.equal(rDup.body.duplicate, true);
    assert.equal(transactionDocs.length, 1);
    assert.equal(notificationDocs.length, 1);

    // 3. Active Premium vendor cannot start duplicate checkout (409)
    const dupCheckout = await callApi('/api/vendor/subscription/checkout', {
      method: 'POST',
      token: vendorToken,
      body: { plan: 'premium' },
    });
    assert.equal(dupCheckout.status, 409);

    // 4. Newer subscription.updated sets period end and schedules cancellation
    const cancelScheduleEvent = {
      id: 'evt_sub_upd_newer',
      type: 'customer.subscription.updated',
      created: tNow + 100,
      data: {
        object: {
          id: 'sub_live_1',
          object: 'subscription',
          customer: 'cus_live_1',
          status: 'active',
          cancel_at_period_end: true,
          current_period_end: futurePeriodEnd,
          metadata: { vendorId: vendorId.toHexString() },
        },
      },
    };
    const rUpd = await sendSignedWebhook(cancelScheduleEvent);
    assert.equal(rUpd.status, 200);
    assert.equal(vendorDoc.subscriptionPlan, 'premium');
    assert.equal(vendorDoc.subscriptionStatus, 'cancelling');
    assert.equal(vendorDoc.cancelAtPeriodEnd, true);

    // 5. Stale out-of-order event (older timestamp) must NOT overwrite newer cancelling state
    const staleEvent = {
      id: 'evt_sub_stale_old',
      type: 'customer.subscription.created',
      created: tNow + 20,
      data: {
        object: {
          id: 'sub_live_1',
          object: 'subscription',
          customer: 'cus_live_1',
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: futurePeriodEnd,
          metadata: { vendorId: vendorId.toHexString() },
        },
      },
    };
    const rStale = await sendSignedWebhook(staleEvent);
    assert.equal(rStale.status, 200);
    assert.equal(rStale.body.staleIgnored, true);
    assert.equal(vendorDoc.subscriptionStatus, 'cancelling');
    assert.equal(vendorDoc.cancelAtPeriodEnd, true);
  });

  it('handles invoice.payment_failed, subscription.deleted, and expired subscription reconciliation', async () => {
    const vendorToken = await signUserToken(vendorId.toHexString(), 'marco@pizzahub.test');
    const tNow = Math.floor(Date.now() / 1000);

    // Payment failure reverts to Free (past_due) and logs failed transaction + notification
    const failEvent = {
      id: 'evt_inv_fail_1',
      type: 'invoice.payment_failed',
      created: tNow + 10,
      data: {
        object: {
          id: 'in_fail_1',
          amount_due: 2900,
          currency: 'usd',
          customer: 'cus_live_2',
          subscription: 'sub_live_2',
          parent: {
            subscription_details: {
              subscription: 'sub_live_2',
              metadata: { vendorId: vendorId.toHexString() },
            },
          },
        },
      },
    };
    const rFail = await sendSignedWebhook(failEvent);
    assert.equal(rFail.status, 200);
    const vendorDoc = userDocs.find((u) => u._id.equals(vendorId));
    assert.equal(vendorDoc.subscriptionPlan, 'free');
    assert.equal(vendorDoc.subscriptionStatus, 'past_due');
    assert.equal(transactionDocs[0].status, 'failed');
    assert.equal(notificationDocs.length, 1);

    // Subscription deleted marks cancelled & free
    const delEvent = {
      id: 'evt_sub_del_1',
      type: 'customer.subscription.deleted',
      created: tNow + 20,
      data: {
        object: {
          id: 'sub_live_2',
          object: 'subscription',
          customer: 'cus_live_2',
          metadata: { vendorId: vendorId.toHexString() },
        },
      },
    };
    const rDel = await sendSignedWebhook(delEvent);
    assert.equal(rDel.status, 200);
    assert.equal(vendorDoc.subscriptionPlan, 'free');
    assert.equal(vendorDoc.subscriptionStatus, 'cancelled');

    // Simulate expired Premium subscription stored in DB -> reconciled back to Free on read
    vendorDoc.subscriptionPlan = 'premium';
    vendorDoc.subscriptionStatus = 'active';
    vendorDoc.subscriptionExpiresAt = new Date('2020-01-01T00:00:00.000Z');

    const summaryRes = await callApi('/api/vendor/subscription', { token: vendorToken });
    assert.equal(summaryRes.status, 200);
    assert.equal(summaryRes.body.subscription.plan, 'free');
    assert.equal(summaryRes.body.subscription.status, 'expired');
    assert.equal(summaryRes.body.subscription.isExpired, true);
    assert.equal(vendorDoc.subscriptionPlan, 'free');
    assert.equal(
      notificationDocs.some((n) => n.title === 'Premium Subscription Expired'),
      true,
    );
  });

  it('mounts /api/webhooks/stripe raw parser and /api/vendor/subscription on src/app.js', async () => {
    const mainServer = http.createServer(app);
    await new Promise((resolve) => mainServer.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${mainServer.address().port}`;
      assert.equal((await fetch(`${base}/api/vendor/subscription`)).status, 401);
      const webhookRes = await fetch(`${base}/api/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      // Either 400 (missing sig) or 503 (no webhook secret in env) proves route is wired before 404
      assert.ok([400, 503].includes(webhookRes.status));
    } finally {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });
});
