import { Server, Socket } from 'socket.io';
import { RedisClientType } from 'redis';
import {
  Room, RoomPublic, Player,
  CreateRoomPayload, JoinRoomPayload, ReadyUpPayload,
  RematchVotePayload
} from '../types/game';
import { generateRoomCode, shuffleTurnOrder } from '../utils/crypto';
import {
  roomCreateLimiter,
  roomJoinLimiter,
} from '../middleware/rateLimiter';
import {
  validateSocketPayload,
  validateUidOwnership,
  validateRoomCode,
} from '../middleware/validation';
import { logAction, detectSuspiciousActivity } from '../utils/actionLogger';

const ROOM_TTL_SECONDS = 60 * 60; // 1 hour — rooms expire from Redis after 1h of inactivity
const MIN_PLAYERS = 2;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function saveRoom(redis: RedisClientType, room: Room): Promise<void> {
  await redis.setEx(`room:${room.roomCode}`, ROOM_TTL_SECONDS, JSON.stringify(room));
}

export async function getRoom(redis: RedisClientType, roomCode: string): Promise<Room | null> {
  const raw = await redis.get(`room:${roomCode}`);
  if (!raw) return null;
  return JSON.parse(raw) as Room;
}

export async function deleteRoom(redis: RedisClientType, roomCode: string): Promise<void> {
  await redis.del(`room:${roomCode}`);
}

export function toPublic(room: Room): RoomPublic {
  return {
    roomCode: room.roomCode,
    hostUid: room.hostUid,
    players: room.players.map(p => ({
      uid: p.uid,
      username: p.username,
      isAlive: p.isAlive,
      isReady: p.isReady,
      isConnected: p.isConnected,
    })),
    maxPlayers: room.maxPlayers,
    status: room.status,
    isPrivate: room.isPrivate,
    currentTurnUid: room.currentTurnUid,
    gems: room.gems,
    commitmentCount: room.poisonCommitments.length,
    winnerUid: room.winnerUid,
    roundNumber: room.roundNumber,
  };
}

// Build initial gem array
function buildGems(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    isEliminated: false,
  }));
}

// Gem count = players * 2 (gives meaningful choices without dragging too long)
function gemCountForPlayers(playerCount: number): number {
  return Math.max(playerCount * 2, 6);
}

export function getNextTurn(turnOrder: string[], currentUid: string, aliveUids: string[]): string {
  const idx = turnOrder.indexOf(currentUid);
  for (let i = 1; i <= turnOrder.length; i++) {
    const next = turnOrder[(idx + i) % turnOrder.length];
    if (aliveUids.includes(next)) return next;
  }
  return aliveUids[0];
}

// ─── Room Handlers ────────────────────────────────────────────────────────────

export function registerRoomHandlers(
  io: Server,
  socket: Socket,
  redis: RedisClientType,
  authenticatedUid: string
) {
  const createLimiter = roomCreateLimiter(redis);
  const joinLimiter = roomJoinLimiter(redis);

  // ── Create Room ──────────────────────────────────────────────────────────────
  socket.on('room:create', async (payload: CreateRoomPayload) => {
    try {
      // Validate payload structure
      const { valid, error } = validateSocketPayload(payload, ['uid', 'username', 'isPrivate', 'maxPlayers']);
      if (!valid) {
        socket.emit('error', { code: 'INVALID_PAYLOAD', message: error });
        return;
      }

      // UID ownership check — client cannot spoof another player's uid
      if (!validateUidOwnership(payload.uid, authenticatedUid)) {
        socket.emit('error', { code: 'UID_MISMATCH', message: 'UID does not match authenticated user' });
        return;
      }

      // Rate limit
      const rateResult = await createLimiter(authenticatedUid);
      if (!rateResult.allowed) {
        socket.emit('error', { code: 'RATE_LIMITED', message: `Too many rooms. Retry in ${rateResult.retryAfter}s` });
        return;
      }

      const { username, isPrivate, maxPlayers } = payload;

      if (maxPlayers < MIN_PLAYERS || maxPlayers > 10) {
        socket.emit('error', { code: 'INVALID_MAX_PLAYERS', message: 'Max players must be 2–10' });
        return;
      }

      // Username length cap (extra safety)
      if (typeof username !== 'string' || username.length > 20) {
        socket.emit('error', { code: 'INVALID_USERNAME', message: 'Invalid username' });
        return;
      }

      const roomCode = generateRoomCode();
      const host: Player = {
        uid: authenticatedUid, username, socketId: socket.id,
        isAlive: true, isReady: false, isConnected: true,
      };

      const room: Room = {
        roomCode,
        hostUid: authenticatedUid,
        players: [host],
        maxPlayers,
        status: 'waiting',
        isPrivate,
        currentTurnUid: null,
        turnOrder: [],
        gems: [],
        poisonCommitments: [],
        afkTimerStart: null,
        winnerUid: null,
        roundNumber: 0,
        createdAt: Date.now(),
      };

      await saveRoom(redis, room);
      await socket.join(roomCode);

      // Track socket→room mapping for disconnect handling
      await redis.setEx(`socket:${socket.id}`, ROOM_TTL_SECONDS, JSON.stringify({
        uid: authenticatedUid, roomCode
      }));

      socket.emit('room:created', { room: toPublic(room) });

      await logAction(redis, { actionType: 'room:create', uid: authenticatedUid, roomCode, timestamp: Date.now() });
      console.log(`[Room] ${username} created room ${roomCode}`);
    } catch (err) {
      console.error('[room:create]', err);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to create room' });
    }
  });

  // ── Join Room ────────────────────────────────────────────────────────────────
  socket.on('room:join', async (payload: JoinRoomPayload) => {
    try {
      const { valid, error } = validateSocketPayload(payload, ['uid', 'username', 'roomCode']);
      if (!valid) {
        socket.emit('error', { code: 'INVALID_PAYLOAD', message: error });
        return;
      }

      if (!validateUidOwnership(payload.uid, authenticatedUid)) {
        socket.emit('error', { code: 'UID_MISMATCH', message: 'UID mismatch' });
        return;
      }

      // Rate limit joins
      const rateResult = await joinLimiter(authenticatedUid);
      if (!rateResult.allowed) {
        socket.emit('error', { code: 'RATE_LIMITED', message: `Too many joins. Retry in ${rateResult.retryAfter}s` });
        return;
      }

      // Validate room code format
      const codeError = validateRoomCode(payload.roomCode);
      if (codeError) {
        socket.emit('error', { code: 'INVALID_ROOM_CODE', message: codeError });
        return;
      }

      const { username, roomCode } = payload;
      const room = await getRoom(redis, roomCode);

      if (!room) {
        socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Room not found' });
        return;
      }

      // Block mid-game joins
      if (room.status !== 'waiting') {
        socket.emit('error', { code: 'GAME_IN_PROGRESS', message: 'Game already in progress' });
        return;
      }

      if (room.players.length >= room.maxPlayers) {
        socket.emit('error', { code: 'ROOM_FULL', message: 'Room is full' });
        return;
      }

      // Prevent same UID joining twice under different usernames
      const existingIdx = room.players.findIndex(p => p.uid === authenticatedUid);
      if (existingIdx !== -1) {
        // Rejoin — update socket only
        room.players[existingIdx].socketId = socket.id;
        room.players[existingIdx].isConnected = true;
      } else {
        room.players.push({
          uid: authenticatedUid, username, socketId: socket.id,
          isAlive: true, isReady: false, isConnected: true,
        });
      }

      await saveRoom(redis, room);
      await socket.join(roomCode);
      await redis.setEx(`socket:${socket.id}`, ROOM_TTL_SECONDS, JSON.stringify({
        uid: authenticatedUid, roomCode
      }));

      socket.emit('room:joined', { room: toPublic(room) });
      socket.to(roomCode).emit('room:updated', { room: toPublic(room) });

      await logAction(redis, { actionType: 'room:join', uid: authenticatedUid, roomCode, timestamp: Date.now() });

      // Suspicious activity check on join
      const { suspicious, reason } = await detectSuspiciousActivity(redis, authenticatedUid, roomCode);
      if (suspicious) {
        console.warn(`[AntiCheat] Suspicious join: ${authenticatedUid} — ${reason}`);
      }

    } catch (err) {
      console.error('[room:join]', err);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to join room' });
    }
  });

  // ── Ready Up ─────────────────────────────────────────────────────────────────
  socket.on('room:ready', async (payload: ReadyUpPayload) => {
    try {
      const { valid, error } = validateSocketPayload(payload, ['uid', 'roomCode']);
      if (!valid) {
        socket.emit('error', { code: 'INVALID_PAYLOAD', message: error });
        return;
      }

      if (!validateUidOwnership(payload.uid, authenticatedUid)) {
        socket.emit('error', { code: 'UID_MISMATCH', message: 'UID mismatch' });
        return;
      }

      const { roomCode } = payload;
      const room = await getRoom(redis, roomCode);
      if (!room || room.status !== 'waiting') return;

      const player = room.players.find(p => p.uid === authenticatedUid);
      if (!player) return;

      player.isReady = true;
      await saveRoom(redis, room);
      io.to(roomCode).emit('room:updated', { room: toPublic(room) });

      await logAction(redis, { actionType: 'room:ready', uid: authenticatedUid, roomCode, timestamp: Date.now() });

      const allReady = room.players.length >= MIN_PLAYERS && room.players.every(p => p.isReady);
      if (allReady) {
        room.status = 'poisoning';
        room.roundNumber += 1;
        room.gems = buildGems(gemCountForPlayers(room.players.length));
        room.turnOrder = shuffleTurnOrder(room.players.map(p => p.uid));
        room.poisonCommitments = [];
        await saveRoom(redis, room);
        io.to(roomCode).emit('game:poisoning_phase', { room: toPublic(room) });
      }
    } catch (err) {
      console.error('[room:ready]', err);
    }
  });

  // ── Leave Room ────────────────────────────────────────────────────────────────
  socket.on('room:leave', async ({ uid, roomCode }: { uid: string; roomCode: string }) => {
    if (!validateUidOwnership(uid, authenticatedUid)) return;
    await handlePlayerLeave(io, socket, redis, authenticatedUid, roomCode, false);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const mapping = await redis.get(`socket:${socket.id}`).catch(() => null);
    if (!mapping) return;
    const { uid, roomCode } = JSON.parse(mapping) as { uid: string; roomCode: string };
    await handlePlayerLeave(io, socket, redis, uid, roomCode, true);
    await redis.del(`socket:${socket.id}`);
  });

  // ── Rematch Vote ──────────────────────────────────────────────────────────────
  socket.on('room:rematch_vote', async (payload: RematchVotePayload) => {
    try {
      if (!validateUidOwnership(payload.uid, authenticatedUid)) return;

      const { roomCode } = payload;
      const room = await getRoom(redis, roomCode);
      if (!room || room.status !== 'finished') return;

      await redis.sAdd(`rematch:${roomCode}`, authenticatedUid);
      const votes = await redis.sCard(`rematch:${roomCode}`);
      const totalConnected = room.players.filter(p => p.isConnected).length;

      io.to(roomCode).emit('room:rematch_votes', { votes, total: totalConnected });

      if (votes >= Math.ceil(totalConnected / 2)) {
        await redis.del(`rematch:${roomCode}`);
        room.status = 'waiting';
        room.players = room.players.map(p => ({ ...p, isAlive: true, isReady: false }));
        room.gems = [];
        room.poisonCommitments = [];
        room.currentTurnUid = null;
        room.turnOrder = [];
        room.winnerUid = null;
        room.afkTimerStart = null;
        await saveRoom(redis, room);
        io.to(roomCode).emit('room:rematch_start', { room: toPublic(room) });
      }
    } catch (err) {
      console.error('[room:rematch_vote]', err);
    }
  });
}

// ─── Shared Leave Logic ───────────────────────────────────────────────────────

async function handlePlayerLeave(
  io: Server,
  socket: Socket,
  redis: RedisClientType,
  uid: string,
  roomCode: string,
  isDisconnect: boolean
) {
  const room = await getRoom(redis, roomCode);
  if (!room) return;

  const playerIdx = room.players.findIndex(p => p.uid === uid);
  if (playerIdx === -1) return;

  const player = room.players[playerIdx];

  await logAction(redis, { actionType: 'room:leave', uid, roomCode, timestamp: Date.now() });

  if (room.status === 'waiting') {
    room.players.splice(playerIdx, 1);
    if (room.players.length === 0) {
      await deleteRoom(redis, roomCode);
      return;
    }
    if (room.hostUid === uid && room.players.length > 0) {
      room.hostUid = room.players[0].uid;
    }
    await saveRoom(redis, room);
    io.to(roomCode).emit('room:updated', { room: toPublic(room) });
  } else if (room.status === 'playing' || room.status === 'poisoning') {
    player.isAlive = false;
    player.isConnected = false;

    io.to(roomCode).emit('game:player_disconnected', { uid, username: player.username });

    const alivePlayers = room.players.filter(p => p.isAlive);
    if (alivePlayers.length === 1) {
      room.status = 'finished';
      room.winnerUid = alivePlayers[0].uid;
      await saveRoom(redis, room);
      io.to(roomCode).emit('game:over', {
        winnerUid: room.winnerUid,
        winnerUsername: alivePlayers[0].username,
        poisonReveals: room.poisonCommitments.map(c => ({
          uid: c.uid,
          gemIndex: c.gemIndex,
          salt: c.salt,
          commitHash: c.commitHash,
          username: room.players.find(p => p.uid === c.uid)?.username ?? '',
        })),
      });
    } else if (alivePlayers.length === 0) {
      room.status = 'finished';
      room.winnerUid = null;
      await saveRoom(redis, room);
      io.to(roomCode).emit('game:over', { winnerUid: null, winnerUsername: null, poisonReveals: [] });
    } else {
      if (room.currentTurnUid === uid) {
        const aliveUids = alivePlayers.map(p => p.uid);
        room.currentTurnUid = getNextTurn(room.turnOrder, uid, aliveUids);
        room.afkTimerStart = Date.now();
      }
      await saveRoom(redis, room);
      io.to(roomCode).emit('room:updated', { room: toPublic(room) });
    }
  }

  socket.leave(roomCode);
}
