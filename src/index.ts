import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { createClient, RedisClientType } from 'redis';
import admin from 'firebase-admin';
import { registerRoomHandlers } from './socket/roomHandler';
import { registerGameHandlers } from './socket/gameHandler';
import { User } from './models/User';
import {
  expressRateLimit,
  otpLimiter,
  authLimiter,
  registerLimiter,
} from './middleware/rateLimiter';
import {
  sanitizeBody,
  validateUsername,
  validateIdToken,
  validateSocketPayload,
} from './middleware/validation';
import { logAction, isBanned } from './utils/actionLogger';

const PORT = process.env.PORT ?? 3000;

// ─── Firebase Admin Init ──────────────────────────────────────────────────────
try {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '')
    : undefined;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
  });
  console.log('[Firebase] Admin SDK Initialized');
} catch (err) {
  console.error('[Firebase] Initialization Error:', err);
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' })); // Hard cap on request body size
app.use(sanitizeBody);                     // Strip prototype pollution, trim strings

// ─── Redis ────────────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
redis.on('error', err => console.error('[Redis]', err));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

// ─── Auth: Verify Token ───────────────────────────────────────────────────────
app.post('/auth/verify',
  expressRateLimit(redis as RedisClientType, {
    windowSeconds: 60,
    maxRequests: 10,
    keyPrefix: 'auth_verify',
  }),
  async (req, res) => {
    try {
      const { idToken } = req.body as { idToken: string };

      // Validate token shape before hitting Firebase
      const tokenError = validateIdToken(idToken);
      if (tokenError) {
        return res.status(400).json({ error: tokenError });
      }

      const decoded = await admin.auth().verifyIdToken(idToken);
      const { uid, phone_number: phone } = decoded;

      if (!phone) {
        console.warn(`[/auth/verify] No phone number for UID: ${uid}`);
        return res.status(400).json({ error: 'No phone number in token' });
      }

      // ── Ban check ──────────────────────────────────────────────────────────
      if (await isBanned(redis as RedisClientType, uid)) {
        return res.status(403).json({ error: 'Account suspended' });
      }

      await logAction(redis as RedisClientType, {
        actionType: 'auth:verify',
        uid,
        ip: req.ip,
        timestamp: Date.now(),
      });

      const existing = await User.findById(uid);
      if (existing) {
        return res.json({ user: existing, isNewUser: false });
      }

      return res.json({ user: null, isNewUser: true, uid, phone });
    } catch (err: any) {
      // CRITICAL: Log the actual error to see why verification failed
      console.error('[/auth/verify] Verification Failed:', err.message || err);
      return res.status(401).json({ error: 'Invalid token', details: err.message });
    }
  }
);

// ─── Auth: Register Username ──────────────────────────────────────────────────
app.post('/auth/register',
  expressRateLimit(redis as RedisClientType, {
    windowSeconds: 3600,
    maxRequests: 5,
    keyPrefix: 'register',
  }),
  async (req, res) => {
    try {
      const { idToken, username } = req.body as { idToken: string; username: string };

      // Validate inputs
      const tokenError = validateIdToken(idToken);
      if (tokenError) {
        return res.status(400).json({ error: tokenError });
      }

      const usernameError = validateUsername(username);
      if (usernameError) {
        return res.status(400).json({ error: usernameError });
      }

      const decoded = await admin.auth().verifyIdToken(idToken);
      const { uid, phone_number: phone } = decoded;

      if (!phone) {
        console.warn(`[/auth/register] No phone number for UID: ${uid}`);
        return res.status(400).json({ error: 'No phone in token' });
      }

      // Ban check
      if (await isBanned(redis as RedisClientType, uid)) {
        return res.status(403).json({ error: 'Account suspended' });
      }

      // Check uniqueness
      const taken = await User.findOne({ username });
      if (taken) {
        return res.status(409).json({ error: 'Username already taken' });
      }

      const user = new User({ _id: uid, phone, username });
      await user.save();

      await logAction(redis as RedisClientType, {
        actionType: 'auth:register',
        uid,
        data: { username },
        ip: req.ip,
        timestamp: Date.now(),
      });

      return res.status(201).json({ user });
    } catch (err: any) {
      console.error('[/auth/register] Error:', err.message || err);
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Username already taken' });
      }
      return res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── HTTP + Socket.IO ─────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 20000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e5, // 100KB max socket message size (anti-flood)
});

// ─── Socket.IO Middleware — Auth + Ban Guard ──────────────────────────────────
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token as string;
    if (!token) return next(new Error('AUTH_REQUIRED'));

    const tokenError = validateIdToken(token);
    if (tokenError) return next(new Error('AUTH_INVALID'));

    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    // Ban check on connect
    if (await isBanned(redis as RedisClientType, uid)) {
      return next(new Error('BANNED'));
    }

    // Attach uid to socket for use in handlers — no need to trust client-sent uid
    (socket as any).authenticatedUid = uid;

    next();
  } catch (err: any) {
    console.error('[Socket Auth] Failed:', err.message);
    next(new Error('AUTH_FAILED'));
  }
});

// ─── Socket.IO Connection ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const uid = (socket as any).authenticatedUid as string;
  console.log(`[Socket] Connected: ${socket.id} (uid: ${uid})`);

  registerRoomHandlers(io, socket, redis as RedisClientType, uid);
  registerGameHandlers(io, socket, redis as RedisClientType, uid);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await mongoose.connect(process.env.MONGO_URI ?? 'mongodb://localhost:27017/poisongem');
    console.log('[MongoDB] Connected');

    await redis.connect();
    console.log('[Redis] Connected');

    httpServer.listen(PORT, () => {
      console.log(`[Server] Poison Gem server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[Boot] Failed to start:', err);
    process.exit(1);
  }
}

boot();
