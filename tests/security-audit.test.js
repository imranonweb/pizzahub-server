import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { ObjectId } from 'mongodb';
import { env, validateEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { errorMiddleware } from '../src/middleware/error.middleware.js';
import { createRateLimiter } from '../src/middleware/rate-limit.middleware.js';
import { resolveEffectiveSubscriptionPlan, resolveEffectiveSubscriptionState } from '../src/utils/subscription-state.js';
import { parsePositiveIntQueryParam } from '../src/utils/validation.js';
import { validatePublicMenuQuery } from '../src/validators/menu.validator.js';
import { moderateAdminMenuItem } from '../src/services/menu.service.js';
import { createVendorCheckoutSession, processStripeWebhookEvent } from '../src/services/subscription.service.js';

describe('Security, Hardening & Production Readiness Audit', () => {
  it('enforces rate limiting with standard headers and 429 Retry-After responses', async () => {
    const app = express();
    app.use(
      '/limited',
      createRateLimiter({
        windowMs: 60_000,
        max: 2,
        message: 'Rate cap reached',
      }),
    );
    app.get('/limited', (_req, res) => res.json({ ok: true }));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const r1 = await fetch(`${base}/limited`);
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get('ratelimit-limit'), '2');
      assert.equal(r1.headers.get('ratelimit-remaining'), '1');

      const r2 = await fetch(`${base}/limited`);
      assert.equal(r2.status, 200);
      assert.equal(r2.headers.get('ratelimit-remaining'), '0');

      const r3 = await fetch(`${base}/limited`);
      assert.equal(r3.status, 429);
      assert.ok(Number(r3.headers.get('retry-after')) >= 1);
      const body = await r3.json();
      assert.deepEqual(body, {
        success: false,
        message: 'Rate cap reached',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('enforces security headers, CORS rejection, payload size caps, and secret redaction', async () => {
    const app = createApp();
    const fakeStripeKey = ['sk', 'live', '51TestSecretKey999'].join('_');
    const fakeWebhookSecret = ['whsec', 'SecretSigningKey123'].join('_');
    const fakeMongoUri = ['mongodb+srv', '://user:MyPass123@mock.example.invalid/db'].join('');

    const errTestApp = express();
    errTestApp.get('/__test-secret-error', () => {
      throw new Error(
        `Stripe ${fakeStripeKey} ${fakeWebhookSecret} ${fakeMongoUri} Bearer eyJhbGciOiJFZERTQSJ9.abc.def`,
      );
    });
    errTestApp.use(errorMiddleware);

    const server = http.createServer(app);
    const errServer = http.createServer(errTestApp);
    await Promise.all([
      new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
      new Promise((resolve) => errServer.listen(0, '127.0.0.1', resolve)),
    ]);

    const capturedErrors = [];
    const origConsoleError = console.error;
    console.error = (...args) => {
      capturedErrors.push(args.join(' '));
    };

    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const errBase = `http://127.0.0.1:${errServer.address().port}`;

      // Helmet headers, query parser safety, & no X-Powered-By
      assert.equal(app.get('query parser'), 'simple');
      const healthRes = await fetch(`${base}/api/menu/invalid-id`);
      assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(healthRes.headers.get('x-powered-by'), null);

      // Untrusted Origin blocked by CORS (403)
      const corsRes = await fetch(`${base}/api/menu/invalid-id`, {
        headers: { Origin: 'https://malicious.example.com' },
      });
      assert.equal(corsRes.status, 403);

      // Oversized JSON (>100kb) returns 413 cleanly
      const oversizedBody = JSON.stringify({ data: 'x'.repeat(120 * 1024) });
      const largeRes = await fetch(`${base}/api/vendor/menu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversizedBody,
      });
      assert.equal(largeRes.status, 413);
      const largePayload = await largeRes.json();
      assert.equal(largePayload.success, false);

      // Unhandled error hides internal message and redacts secrets from logs
      const errRes = await fetch(`${errBase}/__test-secret-error`);
      assert.equal(errRes.status, 500);
      assert.deepEqual(await errRes.json(), {
        success: false,
        message: 'Internal server error',
      });
      const logged = capturedErrors.join('\n');
      assert.equal(logged.includes('MyPass123'), false);
      assert.equal(logged.includes(fakeStripeKey), false);
      assert.equal(logged.includes(fakeWebhookSecret), false);
      assert.equal(logged.includes('eyJhbGciOiJFZERTQSJ9'), false);
    } finally {
      console.error = origConsoleError;
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => errServer.close(resolve)),
      ]);
    }
  });

  it('blocks array/boolean query coercion, NoSQL operator objects, and excessive pagination skips', async () => {
    assert.throws(
      () =>
        parsePositiveIntQueryParam(['1'], {
          fieldName: 'Page',
          defaultValue: 1,
          min: 1,
          max: 10000,
        }),
      (err) => err?.statusCode === 400,
    );

    assert.throws(
      () =>
        parsePositiveIntQueryParam('10001', {
          fieldName: 'Page',
          defaultValue: 1,
          min: 1,
          max: 10000,
        }),
      (err) => err?.statusCode === 400,
    );

    assert.throws(
      () => validatePublicMenuQuery({ search: { $ne: '1' } }),
      (err) => err?.statusCode === 400,
    );

    const app = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const arrayPage = await fetch(`${base}/api/menu?page=1&page=2`);
      assert.equal(arrayPage.status, 400);

      const hugePage = await fetch(`${base}/api/menu?page=999999999`);
      assert.equal(hugePage.status, 400);

      const arraySearch = await fetch(`${base}/api/menu?search=a&search=b`);
      assert.equal(arraySearch.status, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('enforces shared subscription revocation states, prevents duplicate checkout while cancelling, blocks blocked-vendor item approval, and ignores non-subscription webhooks', async () => {
    // Expired / past_due / cancelled statuses revoke Premium consistently across modules
    const futureDate = new Date(Date.now() + 86_400_000);
    assert.equal(
      resolveEffectiveSubscriptionPlan({
        subscriptionPlan: 'premium',
        subscriptionStatus: 'past_due',
        subscriptionExpiresAt: futureDate,
      }),
      'free',
    );
    assert.equal(
      resolveEffectiveSubscriptionPlan({
        subscriptionPlan: 'premium',
        subscriptionStatus: 'cancelling',
        subscriptionExpiresAt: futureDate,
      }),
      'premium',
    );
    assert.equal(
      resolveEffectiveSubscriptionState({
        subscriptionPlan: 'premium',
        subscriptionStatus: 'active',
        subscriptionExpiresAt: new Date(Date.now() - 1000),
      }).plan,
      'free',
    );

    const vendorId = new ObjectId();
    const adminId = new ObjectId();
    const itemId = new ObjectId();

    const users = [
      {
        _id: vendorId,
        role: 'vendor',
        isBlocked: true,
        subscriptionPlan: 'premium',
        subscriptionStatus: 'cancelling',
        subscriptionExpiresAt: futureDate,
        cancelAtPeriodEnd: true,
      },
    ];
    const menuItems = [
      {
        _id: itemId,
        vendorId,
        itemName: 'Blocked Vendor Pizza',
        category: 'Classic Pizzas',
        description: 'Testing blocked vendor approval rejection.',
        price: 14,
        location: 'Dhaka',
        images: ['/images/auth-pizza-hero.jpg'],
        status: 'pending',
        createdAt: new Date(),
      },
    ];
    const transactions = [];

    const mockDb = {
      collection(name) {
        const list =
          name === 'users'
            ? users
            : name === 'menuItems'
              ? menuItems
              : name === 'transactions'
                ? transactions
                : [];
        return {
          async findOne(filter) {
            if (filter?.stripeEventId) {
              return list.find((d) => d.stripeEventId === filter.stripeEventId) ?? null;
            }
            return list[0] ?? null;
          },
          async updateOne() {
            return { modifiedCount: 0 };
          },
          async insertOne(doc) {
            list.push(doc);
            return { insertedId: new ObjectId() };
          },
        };
      },
    };

    // Cancelling Premium vendor cannot start a second parallel Stripe Checkout (409)
    await assert.rejects(
      () =>
        createVendorCheckoutSession(
          {
            vendorId: vendorId.toHexString(),
            plan: 'premium',
            successUrl: 'http://localhost:3000/payment/success',
            cancelUrl: 'http://localhost:3000/payment/cancel',
          },
          { db: mockDb, stripeClient: {} },
        ),
      (err) => err?.statusCode === 409,
    );

    // Admin cannot approve an item belonging to a blocked vendor (409)
    await assert.rejects(
      () =>
        moderateAdminMenuItem(
          {
            itemId: itemId.toHexString(),
            adminId: adminId.toHexString(),
            targetStatus: 'approved',
          },
          mockDb,
        ),
      (err) => err?.statusCode === 409,
    );

    // Non-subscription checkout.session.completed is safely ignored
    const webhookRes = await processStripeWebhookEvent(
      {
        id: 'evt_one_time_payment',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: 'cs_one_time',
            mode: 'payment',
            client_reference_id: vendorId.toHexString(),
          },
        },
      },
      { db: mockDb },
    );
    assert.equal(webhookRes.received, true);
    assert.equal(webhookRes.ignored, true);
  });

  it('validates production environment requirements strictly', () => {
    const saved = { ...env };
    try {
      env.isProduction = true;
      env.allowedOrigins = ['*'];
      env.mongodbUri = 'mongodb://127.0.0.1:27017';
      env.dbName = 'pizzahub';
      env.betterAuthJwksUrl = 'https://app.pizzahub.com/api/auth/jwks';
      env.jwtIssuer = 'https://app.pizzahub.com';
      env.jwtAudience = 'https://app.pizzahub.com';

      assert.throws(() => validateEnv(), /wildcard/i);

      env.allowedOrigins = [];
      assert.throws(() => validateEnv(), /CLIENT_URL/i);
    } finally {
      Object.assign(env, saved);
    }
  });
});
