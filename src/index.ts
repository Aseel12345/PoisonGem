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

const PORT = process.env.PORT ?? 3000;

// ─── Firebase Admin Init ──────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' })); // Tighten in production
app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

// ── Auth Endpoint — called after Firebase Phone OTP verified on client ────────
// Registers new user or returns existing user profile
app.post('/auth/verify', async (req, res) => {
  try {
    const { idToken } = req.body as { idToken: string };
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    // Verify token with Firebase Admin
    const decoded = await admin.auth().verifyIdToken(idToken);
    const { uid, phone_number: phone } = decoded;

    if (!phone) return res.status(400).json({ error: 'No phone number in token' });

    const existing = await User.findById(uid);
    if (existing) {
      return res.json({ user: existing, isNewUser: false });
    }

    // New user — return flag so app shows username setup screen
    return res.json({ user: null, isNewUser: true, uid, phone });
  } catch (err) {
    console.error('[/auth/verify]', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// ── Register Username ─────────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  try {
    const { idToken, username } = req.body as { idToken: string; username: string };

    const decoded = await admin.auth().verifyIdToken(idToken);
    const { uid, phone_number: phone } = decoded;

    if (!phone) return res.status(400).json({ error: 'No phone in token' });

    // Validate username
    if (!username || username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3–20 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username: letters, numbers, underscores only' });
    }

    // Check uniqueness
    const taken = await User.findOne({ username });
    if (taken) return res.status(409).json({ error: 'Username already taken' });

    const user = new User({ _id: uid, phone, username });
    await user.save();

    return res.status(201).json({ user });
  } catch (err: any) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error('[/auth/register]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── HTTP + Socket.IO ─────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 20000,
  pingInterval: 10000,
});

// ─── Redis ────────────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
redis.on('error', err => console.error('[Redis]', err));

// ─── Socket.IO Middleware — Auth Guard ───────────────────────────────────────
// Every socket connection must carry a valid Firebase ID token
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token as string;
    if (!token) return next(new Error('AUTH_REQUIRED'));
    await admin.auth().verifyIdToken(token);
    next();
  } catch {
    next(new Error('AUTH_FAILED'));
  }
});

// ─── Socket.IO Connection ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);
  registerRoomHandlers(io, socket, redis as RedisClientType);
  registerGameHandlers(io, socket, redis as RedisClientType);
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
