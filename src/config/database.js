import { MongoClient } from 'mongodb';
import { env, validateEnv } from './env.js';

let client = null;
let db = null;
let connectPromise = null;

function sanitizeErrorMessage(error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return rawMessage.replace(/(mongodb(?:\+srv)?:\/\/)([^@\s]+@)/gi, '$1***:***@');
}

export async function connectDB() {
  validateEnv();

  if (db) {
    return db;
  }

  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = (async () => {
    const mongoClient = new MongoClient(env.mongodbUri, {
      serverSelectionTimeoutMS: 5000,
    });

    try {
      await mongoClient.connect();
      const database = mongoClient.db(env.dbName);
      const pingResult = await database.command({ ping: 1 });

      if (pingResult?.ok !== 1) {
        throw new Error('Database ping verification failed');
      }

      await ensureUserIndexes(database);

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
    usersCollection.createIndex({ role: 1, isBlocked: 1, createdAt: -1 }),
    usersCollection.createIndex({ createdAt: -1 }),
    usersCollection.createIndex({ name: 1 }),
  ]);
}

export function getDB() {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB() before calling getDB().');
  }

  return db;
}

export async function pingDB() {
  if (!db) {
    throw new Error('Database connection is not initialized');
  }

  try {
    const result = await db.command({ ping: 1 }, { signal: AbortSignal.timeout(3000) });

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

  try {
    await activeClient.close();
    console.log('MongoDB connection closed.');
  } catch (error) {
    const safeMessage = sanitizeErrorMessage(error);
    console.error('Error closing MongoDB connection:', safeMessage);
    throw new Error(`Failed to close MongoDB connection: ${safeMessage}`, { cause: error });
  }
}
