/**
 * Cached MongoDB connection.
 *
 * Next.js re-evaluates modules on hot reload, so the connection (and its
 * promise) is stashed on `globalThis` to avoid leaking connections.
 */

import mongoose from 'mongoose';

import { createLogger, describeError } from '@/lib/logging/logger';
import { requireMongoEnv } from '@/lib/validation/env';

const logger = createLogger('mongodb');

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupMongoose: MongooseCache | undefined;
}

const cached: MongooseCache = globalThis.__wireupMongoose ?? { conn: null, promise: null };
globalThis.__wireupMongoose = cached;

export async function connectMongo(): Promise<typeof mongoose> {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    const { uri, dbName } = requireMongoEnv();
    logger.info('connecting', { dbName, host: safeHost(uri) });

    cached.promise = mongoose
      .connect(uri, {
        dbName,
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 10,
        // Keep warm sockets ready so a request never pays TCP+TLS+auth to
        // Atlas again after an idle spell (the usual cause of a slow first
        // page load once the dev server has been sitting untouched).
        minPoolSize: 1,
        maxIdleTimeMS: 0,
        // Skip the ~1 RTT legacy handshake probe on connect.
        serverApi: { version: '1' as const, strict: false, deprecationErrors: false },
        // Fail fast instead of hanging a page render on a dead network path.
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
        compressors: ['zlib'],
      })
      .then((instance) => {
        logger.info('connected', { dbName });
        return instance;
      })
      .catch((error: unknown) => {
        cached.promise = null;
        const described = describeError(error);
        logger.error('connection failed', { error: described.message });
        throw new MongoConnectionError(described.message);
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

export class MongoConnectionError extends Error {
  constructor(message: string) {
    super(`MongoDB connection failed: ${message}`);
    this.name = 'MongoConnectionError';
  }
}

export async function disconnectMongo(): Promise<void> {
  if (cached.conn) {
    await cached.conn.disconnect();
    cached.conn = null;
    cached.promise = null;
  }
}

/** Never log credentials embedded in a connection string. */
function safeHost(uri: string): string {
  try {
    const withoutCredentials = uri.replace(/\/\/([^@/]+)@/, '//***@');
    const url = new URL(withoutCredentials);
    return url.host;
  } catch {
    return 'unknown';
  }
}
