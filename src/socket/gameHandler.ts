import { Server, Socket } from 'socket.io';
import { RedisClientType } from 'redis';
import {
  CommitPoisonPayload,
  PickGemPayload,
  GemPickedPayload,
  GameOverPayload,
} from '../types/game';
import { verifyCommitment } from '../utils/crypto';
import { getRoom, saveRoom, toPublic, getNextTurn } from './roomHandler';
import {
  gemPickLimiter,
  poisonCommitLimiter,
} from '../middleware/rateLimiter';
import {
  validateSocketPayload,
  validateUidOwnership,
  validateGemIndex,
} from '../middleware/validation';
import { logAction, detectSuspiciousActivity } from '../utils/actionLogger';

const AFK_TIMEOUT_MS = 15_000; // 15 seconds per turn

export function registerGameHandlers(
  io: Server,
  socket: Socket,
  redis: RedisClientType,
  authenticatedUid: string
) {
  const pickLimiter = gemPickLimiter(redis);
  const commitLimiter = poisonCommitLimiter(redis);

  // ── Commit Poison ────────────────────────────────────────────────────────────
  // Each player secretly selects a gem to poison.
  // Client sends both the hash AND the actual gemIndex.
  // Server stores gemIndex privately, broadcasts only that a commitment was made.
  socket.on('game:commit_poison', async (payload: CommitPoisonPayload) => {
    try {
      const { valid, error } = validateSocketPayload(payload,
        ['uid', 'roomCode', 'commitHash', 'gemIndex', 'salt']);
      if (!valid) {
        socket.emit('error', { code: 'INVALID_PAYLOAD', message: error });
        return;
      }

      // ── Phase 2: UID ownership check ───────────────────────────────────────
      if (!validateUidOwnership(payload.uid, authenticatedUid)) {
        socket.emit('error', { code: 'UID_MISMATCH', message: 'UID mismatch' });
        return;
      }

      // Rate limit commits
      const rateResult = await commitLimiter(authenticatedUid);
      if (!rateResult.allowed) {
        socket.emit('error', { code: 'RATE_LIMITED', message: 'Too many commit attempts' });
        return;
      }

      const { roomCode, commitHash, gemIndex, salt } = payload;
      const room = await getRoom(redis, roomCode);

      if (!room || room.status !== 'poisoning') {
        socket.emit('error', { code: 'INVALID_STATE', message: 'Not in poisoning phase' });
        return;
      }

      const player = room.players.find(p => p.uid === authenticatedUid);
      if (!player || !player.isAlive) return;

      // Prevent double-commit
      if (room.poisonCommitments.find(c => c.uid === authenticatedUid)) {
        socket.emit('error', { code: 'ALREADY_COMMITTED', message: 'Already committed poison' });
        return;
      }

      // ── Phase 2: Validate gem index range ─────────────────────────────────
      const gemError = validateGemIndex(gemIndex, room.gems.length);
      if (gemError) {
        socket.emit('error', { code: 'INVALID_GEM', message: gemError });
        return;
      }

      // ── Phase 2: Validate hash matches on server too ──────────────────────
      if (typeof commitHash !== 'string' || commitHash.length !== 64) {
        socket.emit('error', { code: 'INVALID_HASH', message: 'Invalid commitment hash' });
        return;
      }
      if (typeof salt !== 'string' || salt.length !== 32) {
        socket.emit('error', { code: 'INVALID_SALT', message: 'Invalid salt' });
        return;
      }

      // Verify the hash matches (client built the hash, server double-checks)
      if (!verifyCommitment(gemIndex, salt, commitHash)) {
        socket.emit('error', { code: 'HASH_MISMATCH', message: 'Commitment hash mismatch — possible tampering' });
        // Log this — it's a strong signal of tampering
        console.warn(`[AntiCheat] Hash mismatch from uid ${authenticatedUid} in room ${roomCode}`);
        return;
      }

      room.poisonCommitments.push({ uid: authenticatedUid, commitHash, salt, gemIndex });
      await saveRoom(redis, room);

      // Tell all players how many commitments have been made (not who/which gem)
      io.to(roomCode).emit('game:commitment_made', {
        commitmentCount: room.poisonCommitments.length,
        totalPlayers: room.players.filter(p => p.isAlive).length,
      });

      // Confirm to the committing player
      socket.emit('game:poison_committed', { success: true });

      await logAction(redis, {
        actionType: 'game:commit_poison',
        uid: authenticatedUid,
        roomCode,
        data: { gemIndex, commitHash },
        timestamp: Date.now(),
      });

      // All alive players committed → start the game
      const alivePlayers = room.players.filter(p => p.isAlive);
      if (room.poisonCommitments.length === alivePlayers.length) {
        room.status = 'playing';
        room.currentTurnUid = room.turnOrder.find(uid =>
          alivePlayers.some(p => p.uid === uid)
        ) ?? alivePlayers[0].uid;
        room.afkTimerStart = Date.now();
        await saveRoom(redis, room);

        io.to(roomCode).emit('game:started', { room: toPublic(room) });
        console.log(`[Game] ${roomCode} — all poisons committed, game started`);

        // Start AFK watchdog for first turn
        scheduleAfkCheck(io, redis, roomCode, room.currentTurnUid);
      }
    } catch (err) {
      console.error('[game:commit_poison]', err);
    }
  });

  // ── Pick Gem ─────────────────────────────────────────────────────────────────
  // Server-side authoritative pick — client sends intent, server validates everything.
  socket.on('game:pick_gem', async (payload: PickGemPayload) => {
    try {
      const { valid, error } = validateSocketPayload(payload, ['uid', 'roomCode', 'gemIndex']);
      if (!valid) {
        socket.emit('error', { code: 'INVALID_PAYLOAD', message: error });
        return;
      }

      // ── Phase 2: UID ownership check ───────────────────────────────────────
      if (!validateUidOwnership(payload.uid, authenticatedUid)) {
        socket.emit('error', { code: 'UID_MISMATCH', message: 'UID mismatch' });
        return;
      }

      // ── Phase 2: Rate limit picks — 1 per second ──────────────────────────
      const rateResult = await pickLimiter(authenticatedUid);
      if (!rateResult.allowed) {
        socket.emit('error', { code: 'RATE_LIMITED', message: 'Picking too fast' });
        return;
      }

      const { roomCode, gemIndex } = payload;
      const room = await getRoom(redis, roomCode);

      if (!room || room.status !== 'playing') {
        socket.emit('error', { code: 'INVALID_STATE', message: 'Game not in progress' });
        return;
      }

      // ── Phase 2: Server-side turn validation ──────────────────────────────
      if (room.currentTurnUid !== authenticatedUid) {
        socket.emit('error', { code: 'NOT_YOUR_TURN', message: 'Not your turn' });
        return;
      }

      const player = room.players.find(p => p.uid === authenticatedUid);
      if (!player || !player.isAlive) {
        socket.emit('error', { code: 'NOT_ALIVE', message: 'You are not alive' });
        return;
      }

      // ── Phase 2: Validate gem index range ─────────────────────────────────
      const gemError = validateGemIndex(gemIndex, room.gems.length);
      if (gemError) {
        socket.emit('error', { code: 'INVALID_GEM', message: gemError });
        return;
      }

      // Validate gem
      const gem = room.gems[gemIndex];
      if (!gem || gem.isEliminated) {
        socket.emit('error', { code: 'INVALID_GEM', message: 'Gem already eliminated or invalid' });
        return;
      }

      // Eliminate the gem
      gem.isEliminated = true;

      // Check if this gem was poisoned by ANY player
      const poisonedBy = room.poisonCommitments.find(c => c.gemIndex === gemIndex);
      const wasPoison = !!poisonedBy;

      let eliminatedUid: string | null = null;
      let nextTurnUid: string | null = null;

      if (wasPoison) {
        // Picker dies
        player.isAlive = false;
        eliminatedUid = authenticatedUid;

        // Update stats in MongoDB (fire-and-forget, don't block game)
        updatePoisonStats(poisonedBy!.uid, authenticatedUid).catch(console.error);
      }

      const alivePlayers = room.players.filter(p => p.isAlive);

      await logAction(redis, {
        actionType: 'game:pick_gem',
        uid: authenticatedUid,
        roomCode,
        data: { gemIndex, wasPoison },
        timestamp: Date.now(),
      });

      // Suspicious activity check after each pick
      const { suspicious, reason } = await detectSuspiciousActivity(redis, authenticatedUid, roomCode);
      if (suspicious) {
        console.warn(`[AntiCheat] ${authenticatedUid} flagged: ${reason}`);
      }

      if (alivePlayers.length <= 1) {
        // Game over
        room.status = 'finished';
        room.winnerUid = alivePlayers[0]?.uid ?? null;
        room.currentTurnUid = null;
        await saveRoom(redis, room);

        const eventPayload: GemPickedPayload = {
          pickerUid: authenticatedUid,
          gemIndex,
          wasPoison,
          poisonedByUid: poisonedBy?.uid ?? null,
          eliminatedUid,
          nextTurnUid: null,
        };
        io.to(roomCode).emit('game:gem_picked', eventPayload);

        // Small delay so clients can animate death before seeing game over
        setTimeout(async () => {
          const winner = alivePlayers[0];
          const gameOverPayload: GameOverPayload = {
            winnerUid: winner?.uid ?? null,
            winnerUsername: winner?.username ?? null,
            poisonReveals: room.poisonCommitments.map(c => ({
              uid: c.uid,
              username: room.players.find(p => p.uid === c.uid)?.username ?? '',
              gemIndex: c.gemIndex,
              salt: c.salt,
              commitHash: c.commitHash,
            })),
          };
          io.to(roomCode).emit('game:over', gameOverPayload);

          await logAction(redis, {
            actionType: 'game:over',
            uid: winner?.uid ?? 'none',
            roomCode,
            data: { winnerUid: winner?.uid },
            timestamp: Date.now(),
          });

          if (winner) updateWinStats(winner.uid).catch(console.error);
        }, 2000);

        return;
      }

      // Safe pick or poison pick (with more players alive) — advance turn normally
      nextTurnUid = getNextTurn(room.turnOrder, authenticatedUid, alivePlayers.map(p => p.uid));

      room.currentTurnUid = nextTurnUid;
      room.afkTimerStart = Date.now();
      await saveRoom(redis, room);

      const eventPayload: GemPickedPayload = {
        pickerUid: authenticatedUid,
        gemIndex,
        wasPoison,
        poisonedByUid: poisonedBy?.uid ?? null,
        eliminatedUid,
        nextTurnUid,
      };
      io.to(roomCode).emit('game:gem_picked', eventPayload);

      // Schedule AFK check for next player
      if (nextTurnUid) {
        scheduleAfkCheck(io, redis, roomCode, nextTurnUid);
      }

    } catch (err) {
      console.error('[game:pick_gem]', err);
    }
  });
}

// ─── AFK Timer ────────────────────────────────────────────────────────────────
// If a player doesn't pick within 15 seconds, server auto-picks a random gem.

function scheduleAfkCheck(
  io: Server,
  redis: RedisClientType,
  roomCode: string,
  expectedUid: string
) {
  setTimeout(async () => {
    try {
      const room = await getRoom(redis, roomCode);
      if (!room || room.status !== 'playing') return;
      if (room.currentTurnUid !== expectedUid) return; // Turn already advanced

      const timeSinceTurn = Date.now() - (room.afkTimerStart ?? 0);
      if (timeSinceTurn < AFK_TIMEOUT_MS - 500) return; // Not actually AFK

      // Pick a random non-eliminated gem
      const available = room.gems.filter(g => !g.isEliminated);
      if (available.length === 0) return;

      const randomGem = available[Math.floor(Math.random() * available.length)];
      console.log(`[AFK] Auto-picking gem ${randomGem.index} for ${expectedUid} in room ${roomCode}`);

      await logAction(redis, {
        actionType: 'game:afk_pick',
        uid: expectedUid,
        roomCode,
        data: { gemIndex: randomGem.index },
        timestamp: Date.now(),
      });

      // Emit as if the player picked it — reuse pick logic via internal emit
      io.to(roomCode).emit('game:afk_pick', { uid: expectedUid, gemIndex: randomGem.index });

      // Process the pick server-side (inline the pick logic)
      const gem = room.gems[randomGem.index];
      gem.isEliminated = true;

      const poisonedBy = room.poisonCommitments.find(c => c.gemIndex === randomGem.index);
      const wasPoison = !!poisonedBy;

      const player = room.players.find(p => p.uid === expectedUid);
      if (!player) return;

      let eliminatedUid: string | null = null;
      let nextTurnUid: string | null = null;

      if (wasPoison) {
        player.isAlive = false;
        eliminatedUid = expectedUid;
      }

      const alivePlayers = room.players.filter(p => p.isAlive);

      if (alivePlayers.length <= 1) {
        room.status = 'finished';
        room.winnerUid = alivePlayers[0]?.uid ?? null;
        room.currentTurnUid = null;
        await saveRoom(redis, room);

        io.to(roomCode).emit('game:gem_picked', {
          pickerUid: expectedUid, gemIndex: randomGem.index,
          wasPoison, poisonedByUid: poisonedBy?.uid ?? null,
          eliminatedUid, nextTurnUid: null,
        });

        setTimeout(() => {
          io.to(roomCode).emit('game:over', {
            winnerUid: room.winnerUid,
            winnerUsername: alivePlayers[0]?.username ?? null,
            poisonReveals: room.poisonCommitments.map(c => ({
              uid: c.uid,
              username: room.players.find(p => p.uid === c.uid)?.username ?? '',
              gemIndex: c.gemIndex, salt: c.salt, commitHash: c.commitHash,
            })),
          });
        }, 2000);
        return;
      }

      nextTurnUid = getNextTurn(room.turnOrder, expectedUid, alivePlayers.map(p => p.uid));
      room.currentTurnUid = nextTurnUid;
      room.afkTimerStart = Date.now();
      await saveRoom(redis, room);

      io.to(roomCode).emit('game:gem_picked', {
        pickerUid: expectedUid, gemIndex: randomGem.index,
        wasPoison, poisonedByUid: poisonedBy?.uid ?? null,
        eliminatedUid, nextTurnUid,
      });

      if (nextTurnUid) scheduleAfkCheck(io, redis, roomCode, nextTurnUid);

    } catch (err) {
      console.error('[AFK check]', err);
    }
  }, AFK_TIMEOUT_MS);
}

// ─── Stat Updates (fire-and-forget) ──────────────────────────────────────────

async function updatePoisonStats(poisonerUid: string, victimUid: string) {
  const { User } = await import('../models/User');
  await Promise.all([
    User.updateOne({ _id: poisonerUid }, { $inc: { 'stats.eliminations': 1 } }),
    User.updateOne({ _id: victimUid }, { $inc: { 'stats.timesPoison': 1 } }),
  ]);
}

async function updateWinStats(winnerUid: string) {
  const { User } = await import('../models/User');
  await User.updateOne({ _id: winnerUid }, { $inc: { 'stats.wins': 1, 'stats.matchesPlayed': 1 } });
}
