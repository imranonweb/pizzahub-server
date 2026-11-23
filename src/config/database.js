import { MongoClient } from 'mongodb';
import { env, validateEnv } from './env.js';

let client = null;
let db = null;
let connectPromise = null;
let indexesPromise = null;

function sanitizeErrorMessage(error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return rawMessage.replace(/(mongodb(?:\+srv)?:\/\/)([^@\s]+@)/gi, '$1***:***@');
}

async function ensureAllIndexesOnce(database) {
  if (!indexesPromise) {
    indexesPromise = Promise.all([
      ensureUserIndexes(database),
      ensureMenuItemIndexes(database),
      ensureOrderIndexes(database),
      ensureTransactionIndexes(database),
      ensureNotificationIndexes(database),
    ]).catch((error) => {
      indexesPromise = null;
      throw error;
    });
  }

  return indexesPromise;
}

export async function connectDB({ awaitIndexes = process.env.VERCEL !== '1' } = {}) {
  validateEnv();

  if (db) {
    return db;
  }

  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = (async () => {
    const mongoClient = new MongoClient(env.mongodbUri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 60000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 20000,
      serverSelectionTimeoutMS: 5000,
    });

    try {
      await mongoClient.connect();
      const database = mongoClient.db(env.dbName);

      if (awaitIndexes) {
        await ensureAllIndexesOnce(database);
      } else {
        void ensureAllIndexesOnce(database).catch((err) => {
          console.warn('Deferred index initialization warning:', sanitizeErrorMessage(err));
        });
      }

      client = mongoClient;
      db = database;
      console.log(`Connected to MongoDB database: ${env.dbName}`);
      return db;
    } catch (error) {
      await mongoClient.close().catch(() => {});
      client = null;
      db = null;
      const safeMessage = sanitizeErrorMessage(error);
      throw new Error(`MongoDB connection failed: ${safeMessage}`, { cause: error });
    }
  })();

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export async function ensureUserIndexes(database) {
  const usersCollection = database.collection('users');
  await Promise.all([
    usersCollection.createIndex({ id: 1 }, { sparse: true }),
    usersCollection.createIndex({ stripeCustomerId: 1 }, { sparse: true }),
    usersCollection.createIndex({ stripeSubscriptionId: 1 }, { sparse: true }),
    usersCollection.createIndex({ isBlocked: 1 }),
    usersCollection.createIndex({ role: 1, isBlocked: 1, createdAt: -1 }),
    usersCollection.createIndex({ createdAt: -1 }),
    usersCollection.createIndex({ name: 1 }),
  ]);
}

export async function ensureMenuItemIndexes(database) {
  const menuItemsCollection = database.collection('menuItems');
  await Promise.all([
    menuItemsCollection.createIndex({ status: 1, category: 1, location: 1, price: 1 }),
    menuItemsCollection.createIndex({ status: 1, createdAt: -1 }),
    menuItemsCollection.createIndex({ vendorId: 1, status: 1 }),
  ]);
}

export async function ensureOrderIndexes(database) {
  const ordersCollection = database.collection('orders');
  await Promise.all([
    ordersCollection.createIndex({ customerId: 1, createdAt: -1 }),
    ordersCollection.createIndex({ vendorId: 1, status: 1, createdAt: -1 }),
    ordersCollection.createIndex({ 'items.menuItemId': 1 }),
    ordersCollection.createIndex({ itemId: 1 }),
  ]);
}

export async function ensureTransactionIndexes(database) {
  const transactionsCollection = database.collection('transactions');
  await Promise.all([
    transactionsCollection.createIndex({ stripeEventId: 1 }, { unique: true, sparse: true }),
    transactionsCollection.createIndex({ vendorId: 1, createdAt: -1 }),
    transactionsCollection.createIndex({ createdAt: -1 }),
    transactionsCollection.createIndex({ status: 1, createdAt: -1 }),
  ]);
}

export async function ensureNotificationIndexes(database) {
  const notificationsCollection = database.collection('notifications');
  await Promise.all([
    notificationsCollection.createIndex({ userId: 1, createdAt: -1 }),
    notificationsCollection.createIndex({ userId: 1, read: 1, createdAt: -1 }),
    notificationsCollection.createIndex(
      { userId: 1, eventKey: 1 },
      { unique: true, sparse: true },
    ),
  ]);
}

export function getDB() {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB() before calling getDB().');
  }

  return db;
}

export async function ensureDBConnected() {
  if (db) {
    return db;
  }

  return connectDB();
}

export async function pingDB() {
  try {
    const activeDb = db ?? (await connectDB());
    const result = await activeDb.command({ ping: 1 }, { signal: AbortSignal.timeout(3000) });

    if (result?.ok !== 1) {
      throw new Error('Database ping failed');
    }

    return true;
  } catch (error) {
    throw new Error(sanitizeErrorMessage(error), { cause: error });
  }
}

export async function closeDB() {
  if (!client) {
    db = null;
    return;
  }

  const activeClient = client;
  client = null;
  db = null;
  indexesPromise = null;

  try {
    await activeClient.close();
    console.log('MongoDB connection closed.');
  } catch (error) {
    const safeMessage = sanitizeErrorMessage(error);
    console.error('Error closing MongoDB connection:', safeMessage);
    throw new Error(`Failed to close MongoDB connection: ${safeMessage}`, { cause: error });
  }
}
