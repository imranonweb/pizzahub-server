import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { ObjectId } from 'mongodb';
import app from '../src/app.js';
import { errorMiddleware } from '../src/middleware/error.middleware.js';
import { notFoundMiddleware } from '../src/middleware/not-found.middleware.js';
import { createMenuRouter } from '../src/routes/menu.routes.js';

let apiServer;
let apiBaseUrl;
let dbMode = 'normal';
let menuDocs = [];
let userDocs = [];

const premiumVendorId = new ObjectId('675000000000000000000001');
const freeVendorId = new ObjectId('675000000000000000000002');
const blockedVendorId = new ObjectId('675000000000000000000003');

const approvedItemOneId = new ObjectId('675100000000000000000001');
const approvedItemTwoId = new ObjectId('675100000000000000000002');
const approvedItemThreeId = new ObjectId('675100000000000000000003');
const pendingItemId = new ObjectId('675100000000000000000004');
const rejectedItemId = new ObjectId('675100000000000000000005');
const inactiveItemId = new ObjectId('675100000000000000000006');
const blockedVendorItemId = new ObjectId('675100000000000000000007');
const missingItemId = new ObjectId('675100000000000000000099');

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
      const source = name === 'menuItems' ? menuDocs : name === 'users' ? userDocs : [];
      return {
        async findOne(filter, options = {}) {
          if (dbMode === 'error') {
            throw new Error(
              'MongoServerError: mongodb+srv://admin:TopSecret99@cluster.mongodb.net/pizzahub failed',
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
                  'MongoServerError: mongodb+srv://admin:TopSecret99@cluster.mongodb.net/pizzahub failed',
                );
              }
              return source
                .filter((doc) => matchesFilter(doc, filter))
                .map((doc) => applyProjection(doc, options.projection));
            },
          };
        },
      };
    },
  };
}

async function fetchJson(path) {
  const response = await fetch(`${apiBaseUrl}${path}`);
  const body = await response.json();
  return { status: response.status, body };
}

function assertPublicItemSafe(item) {
  for (const forbidden of ['_id', 'rejectionReason', 'internalNotes', 'adminReviewerId']) {
    assert.equal(forbidden in item, false, `Unexpected internal menu field exposed: ${forbidden}`);
  }
  assert.ok(item.vendor);
  for (const forbiddenVendorField of [
    '_id',
    'email',
    'contactPhone',
    'deliveryAddress',
    'passwordHash',
    'isBlocked',
    'sessions',
  ]) {
    assert.equal(
      forbiddenVendorField in item.vendor,
      false,
      `Unexpected sensitive vendor field exposed: ${forbiddenVendorField}`,
    );
  }
}

before(async () => {
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors({ origin: 'http://localhost:3000', credentials: true }));
  testApp.use(express.json());
  testApp.use('/api/menu', createMenuRouter({ getDatabase: getMockDatabase }));
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
      _id: premiumVendorId,
      name: 'Marco Rossi',
      email: 'marco@secret-vendor.test',
      businessName: 'Napoli Fire Oven',
      subscriptionPlan: 'premium',
      isBlocked: false,
      contactPhone: '+8801700000001',
      passwordHash: 'hash-1',
    },
    {
      _id: freeVendorId,
      name: 'Tariq Ahmed',
      email: 'tariq@secret-vendor.test',
      businessName: 'Dhaka Slice Co',
      subscriptionPlan: 'free',
      isBlocked: false,
      contactPhone: '+8801700000002',
      passwordHash: 'hash-2',
    },
    {
      _id: blockedVendorId,
      name: 'Blocked Owner',
      email: 'blocked@secret-vendor.test',
      businessName: 'Blocked Crust',
      subscriptionPlan: 'premium',
      isBlocked: true,
    },
  ];

  menuDocs = [
    {
      _id: approvedItemOneId,
      vendorId: freeVendorId,
      itemName: 'Margherita Classica',
      category: 'Classic Pizzas',
      description: 'San Marzano tomatoes, fresh mozzarella, and sweet basil leaves.',
      price: 11.5,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/margherita.jpg'],
      status: 'approved',
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
      internalNotes: 'Should never be exposed',
    },
    {
      _id: approvedItemTwoId,
      vendorId: premiumVendorId,
      itemName: 'Truffle + Burrata Gourmet',
      category: 'Specialty / Gourmet Pizzas',
      description: 'Black truffle cream, creamy burrata, and wild arugula.',
      price: 22.0,
      location: 'Gulshan, Dhaka',
      images: ['https://i.ibb.co/example/truffle.jpg'],
      status: 'approved',
      createdAt: new Date('2026-11-02T10:00:00.000Z'),
    },
    {
      _id: approvedItemThreeId,
      vendorId: freeVendorId,
      itemName: 'Pepperoni Feast',
      category: 'Meat Lovers',
      description: 'Double beef pepperoni with aged provolone and oregano.',
      price: 15.75,
      location: 'Dhanmondi, Dhaka',
      images: ['https://i.ibb.co/example/pepperoni.jpg'],
      status: 'approved',
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
    },
    {
      _id: pendingItemId,
      vendorId: premiumVendorId,
      itemName: 'Pending Garlic Knots',
      category: 'Sides & Appetizers',
      description: 'Freshly baked garlic knots awaiting admin approval.',
      price: 6.5,
      location: 'Gulshan, Dhaka',
      images: ['https://i.ibb.co/example/knots.jpg'],
      status: 'pending',
      createdAt: new Date('2026-11-06T10:00:00.000Z'),
    },
    {
      _id: rejectedItemId,
      vendorId: freeVendorId,
      itemName: 'Rejected Mystery Pie',
      category: 'Classic Pizzas',
      description: 'Rejected item that must never appear publicly.',
      price: 9.0,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/rejected.jpg'],
      status: 'rejected',
      rejectionReason: 'Incomplete allergen info',
      createdAt: new Date('2026-11-07T10:00:00.000Z'),
    },
    {
      _id: inactiveItemId,
      vendorId: freeVendorId,
      itemName: 'Inactive Seasonal Soda',
      category: 'Beverages & Desserts',
      description: 'Deactivated seasonal beverage item.',
      price: 3.5,
      location: 'Banani, Dhaka',
      images: ['https://i.ibb.co/example/soda.jpg'],
      status: 'inactive',
      createdAt: new Date('2026-11-08T10:00:00.000Z'),
    },
    {
      _id: blockedVendorItemId,
      vendorId: blockedVendorId,
      itemName: 'Blocked Vendor Pizza',
      category: 'Classic Pizzas',
      description: 'Approved listing from a blocked vendor account.',
      price: 14.0,
      location: 'Uttara, Dhaka',
      images: ['https://i.ibb.co/example/blocked.jpg'],
      status: 'approved',
      createdAt: new Date('2026-11-09T10:00:00.000Z'),
    },
  ];
});

after(async () => {
  if (apiServer) {
    await new Promise((resolve) => apiServer.close(resolve));
  }
});

describe('Public Menu APIs (/api/menu)', () => {
  it('lists only approved items from active vendors with featured premium ordering and safe fields', async () => {
    const res = await fetchJson('/api/menu');

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.items.length, 3);
    assert.deepEqual(res.body.locations, ['Banani, Dhaka', 'Dhanmondi, Dhaka', 'Gulshan, Dhaka']);
    assert.deepEqual(res.body.pagination, {
      page: 1,
      limit: 12,
      total: 3,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    });

    // Featured sort places premium vendor item first, then newest free items
    assert.equal(res.body.items[0].id, approvedItemTwoId.toHexString());
    assert.equal(res.body.items[0].vendor.subscriptionPlan, 'premium');
    assert.equal(res.body.items[1].id, approvedItemOneId.toHexString());
    assert.equal(res.body.items[2].id, approvedItemThreeId.toHexString());

    const ids = res.body.items.map((item) => item.id);
    assert.equal(ids.includes(pendingItemId.toHexString()), false);
    assert.equal(ids.includes(rejectedItemId.toHexString()), false);
    assert.equal(ids.includes(inactiveItemId.toHexString()), false);
    assert.equal(ids.includes(blockedVendorItemId.toHexString()), false);

    for (const item of res.body.items) {
      assertPublicItemSafe(item);
    }
  });

  it('supports search (including regex characters), category, location, and sorting', async () => {
    const searchRes = await fetchJson(`/api/menu?search=${encodeURIComponent('+ Burrata')}`);
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.items.length, 1);
    assert.equal(searchRes.body.items[0].id, approvedItemTwoId.toHexString());

    const categoryRes = await fetchJson(
      `/api/menu?category=${encodeURIComponent('Meat Lovers')}`,
    );
    assert.equal(categoryRes.status, 200);
    assert.equal(categoryRes.body.items.length, 1);
    assert.equal(categoryRes.body.items[0].itemName, 'Pepperoni Feast');

    const locationRes = await fetchJson(`/api/menu?location=${encodeURIComponent('banani')}`);
    assert.equal(locationRes.status, 200);
    assert.equal(locationRes.body.items.length, 1);
    assert.equal(locationRes.body.items[0].id, approvedItemOneId.toHexString());

    const ascRes = await fetchJson('/api/menu?sort=price-asc');
    assert.equal(ascRes.status, 200);
    assert.deepEqual(
      ascRes.body.items.map((item) => item.price),
      [11.5, 15.75, 22.0],
    );

    const descRes = await fetchJson('/api/menu?sort=price-desc');
    assert.equal(descRes.status, 200);
    assert.deepEqual(
      descRes.body.items.map((item) => item.price),
      [22.0, 15.75, 11.5],
    );

    const newestRes = await fetchJson('/api/menu?sort=newest');
    assert.equal(newestRes.status, 200);
    assert.deepEqual(
      newestRes.body.items.map((item) => item.id),
      [
        approvedItemOneId.toHexString(),
        approvedItemTwoId.toHexString(),
        approvedItemThreeId.toHexString(),
      ],
    );
  });

  it('paginates results and rejects invalid query parameters (400)', async () => {
    const page1 = await fetchJson('/api/menu?sort=price-asc&page=1&limit=2');
    assert.equal(page1.status, 200);
    assert.equal(page1.body.items.length, 2);
    assert.deepEqual(page1.body.pagination, {
      page: 1,
      limit: 2,
      total: 3,
      totalPages: 2,
      hasNextPage: true,
      hasPrevPage: false,
    });

    const page2 = await fetchJson('/api/menu?sort=price-asc&page=2&limit=2');
    assert.equal(page2.status, 200);
    assert.equal(page2.body.items.length, 1);
    assert.equal(page2.body.pagination.hasNextPage, false);
    assert.equal(page2.body.pagination.hasPrevPage, true);

    const badSort = await fetchJson('/api/menu?sort=hack');
    assert.equal(badSort.status, 400);

    const badPage = await fetchJson('/api/menu?page=0');
    assert.equal(badPage.status, 400);

    const badLimit = await fetchJson('/api/menu?limit=200');
    assert.equal(badLimit.status, 400);
  });

  it('returns empty items array gracefully when no menu items match', async () => {
    const emptySearch = await fetchJson('/api/menu?search=NoSuchPizzaAnywhere');
    assert.equal(emptySearch.status, 200);
    assert.deepEqual(emptySearch.body.items, []);
    assert.equal(emptySearch.body.pagination.total, 0);
    assert.equal(emptySearch.body.pagination.totalPages, 1);

    menuDocs = [];
    const emptyCatalog = await fetchJson('/api/menu');
    assert.equal(emptyCatalog.status, 200);
    assert.deepEqual(emptyCatalog.body.items, []);
    assert.deepEqual(emptyCatalog.body.locations, []);
  });

  it('retrieves a single approved menu item and hides non-approved, blocked-vendor, missing, or invalid IDs', async () => {
    const validRes = await fetchJson(`/api/menu/${approvedItemTwoId.toHexString()}`);
    assert.equal(validRes.status, 200);
    assert.equal(validRes.body.success, true);
    assert.equal(validRes.body.item.id, approvedItemTwoId.toHexString());
    assert.equal(validRes.body.item.vendor.businessName, 'Napoli Fire Oven');
    assertPublicItemSafe(validRes.body.item);

    for (const hiddenId of [
      pendingItemId,
      rejectedItemId,
      inactiveItemId,
      blockedVendorItemId,
      missingItemId,
    ]) {
      const res = await fetchJson(`/api/menu/${hiddenId.toHexString()}`);
      assert.equal(res.status, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Menu item not found.');
    }

    const invalidIdRes = await fetchJson('/api/menu/not-a-valid-object-id');
    assert.equal(invalidIdRes.status, 400);
    assert.equal(invalidIdRes.body.success, false);
  });

  it('handles database failures safely without exposing credentials (500)', async () => {
    dbMode = 'error';

    const listErr = await fetchJson('/api/menu');
    assert.equal(listErr.status, 500);
    assert.deepEqual(listErr.body, {
      success: false,
      message: 'Internal server error',
    });
    assert.equal(JSON.stringify(listErr.body).includes('TopSecret99'), false);

    const detailErr = await fetchJson(`/api/menu/${approvedItemOneId.toHexString()}`);
    assert.equal(detailErr.status, 500);
    assert.deepEqual(detailErr.body, {
      success: false,
      message: 'Internal server error',
    });
  });

  it('wires /api/menu cleanly on src/app.js without breaking auth or 404 routes', async () => {
    const mainServer = http.createServer(app);
    await new Promise((resolve) => mainServer.listen(0, '127.0.0.1', resolve));

    try {
      const base = `http://127.0.0.1:${mainServer.address().port}`;

      const invalidMenuId = await fetch(`${base}/api/menu/invalid-id`);
      assert.equal(invalidMenuId.status, 400);

      const authCheck = await fetch(`${base}/api/profile`);
      assert.equal(authCheck.status, 401);

      const unknownCheck = await fetch(`${base}/api/unknown-route`);
      assert.equal(unknownCheck.status, 404);
    } finally {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });
});
