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

const AFK_TIMEOUT_MS = 15_000; // 15 seconds per turn

export function registerGameHandlers(
  io: Server,
  socket: Socket,
  redis: RedisClientType
) {
  // ── Commit Poison ────────────────────────────────────────────────────────────
  // Each player secretly selects a gem to poison.
  // Client sends both the hash AND the actual gemIndex.
  // Server stores gemIndex privately, broadcasts only that a commitment was made.
  socket.on('game:commit_poison', async (payload: CommitPoisonPayload) => {
    try {
      const { uid, roomCode, commitHash, gemIndex, salt } = payload;
      const room = await getRoom(redis, roomCode);

      if (!room || room.status !== 'poisoning') {
        socket.emit('error', { code: 'INVALID_STATE', message: 'Not in poisoning phase' });
        return;
      }

      const player = room.players.find(p => p.uid === uid);
      if (!player || !player.isAlive) return;

      // Prevent double-commit
      if (room.poisonCommitments.find(c => c.uid === uid)) {
        socket.emit('error', { code: 'ALREADY_COMMITTED', message: 'Already committed poison' });
        return;
      }

      // Validate gem index is within bounds and not already eliminated
      if (gemIndex < 0 || gemIndex >= room.gems.length) {
        socket.emit('error', { code: 'INVALID_GEM', message: 'Invalid gem index' });
        return;
      }

      // Verify the hash matches (client built the hash, server double-checks)
      if (!verifyCommitment(gemIndex, salt, commitHash)) {
        socket.emit('error', { code: 'HASH_MISMATCH', message: 'Commitment hash mismatch — possible tampering' });
        return;
      }

      room.poisonCommitments.push({ uid, commitHash, salt, gemIndex });
      await saveRoom(redis, room);

      // Tell all players how many commitments have been made (not who/which gem)
      io.to(roomCode).emit('game:commitment_made', {
        commitmentCount: room.poisonCommitments.length,
        totalPlayers: room.players.filter(p => p.isAlive).length,
      });

      // Confirm to the committing player
      socket.emit('game:poison_committed', { success: true });

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
      const { uid, roomCode, gemIndex } = payload;
      const room = await getRoom(redis, roomCode);

      if (!room || room.status !== 'playing') {
        socket.emit('error', { code: 'INVALID_STATE', message: 'Game not in progress' });
        return;
      }

      // Validate it's this player's turn
      if (room.currentTurnUid !== uid) {
        socket.emit('error', { code: 'NOT_YOUR_TURN', message: 'Not your turn' });
        return;
      }

      const player = room.players.find(p => p.uid === uid);
      if (!player || !player.isAlive) {
        socket.emit('error', { code: 'NOT_ALIVE', message: 'You are not alive' });
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
        eliminatedUid = uid;

        // Update stats in MongoDB (fire-and-forget, don't block game)
        updatePoisonStats(poisonedBy!.uid, uid).catch(console.error);

        const alivePlayers = room.players.filter(p => p.isAlive);

        if (alivePlayers.length === 1) {
          // Game over — last player alive wins
          room.status = 'finished';
          room.winnerUid = alivePlayers[0].uid;
          room.currentTurnUid = null;
          await saveRoom(redis, room);

          const eventPayload: GemPickedPayload = {
            pickerUid: uid,
            gemIndex,
            wasPoison: true,
            poisonedByUid: poisonedBy!.uid,
            eliminatedUid: uid,
            nextTurnUid: null,
          };
          io.to(roomCode).emit('game:gem_picked', eventPayload);

          // Small delay so clients can animate death before seeing game over
          setTimeout(async () => {
            const winner = alivePlayers[0];
            const gameOverPayload: GameOverPayload = {
              winnerUid: winner.uid,
              winnerUsername: winner.username,
              poisonReveals: room.poisonCommitments.map(c => ({
                uid: c.uid,
                username: room.players.find(p => p.uid === c.uid)?.username ?? '',
                gemIndex: c.gemIndex,
                salt: c.salt,
                commitHash: c.commitHash,
              })),
            };
            io.to(roomCode).emit('game:over', gameOverPayload);
            updateWinStats(winner.uid).catch(console.error);
          }, 2000);

          return;

        } else if (alivePlayers.length === 0) {
          // Shouldn't happen but handle gracefully
          room.status = 'finished';
          room.winnerUid = null;
          await saveRoom(redis, room);
          io.to(roomCode).emit('game:over', { winnerUid: null, winnerUsername: null, poisonReveals: [] });
          return;
        }

        // More than 1 alive — game continues without the dead player
        nextTurnUid = getNextTurn(room.turnOrder, uid, alivePlayers.map(p => p.uid));

      } else {
        // Safe pick — advance turn normally
        const alivePlayers = room.players.filter(p => p.isAlive);
        nextTurnUid = getNextTurn(room.turnOrder, uid, alivePlayers.map(p => p.uid));
      }

      room.currentTurnUid = nextTurnUid;
      room.afkTimerStart = Date.now();
      await saveRoom(redis, room);

      const eventPayload: GemPickedPayload = {
        pickerUid: uid,
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

      // Emit as if the player picked it — reuse pick logic via internal emit
      // We emit directly to the server's own socket handler by emitting a fake event
      // Actually cleaner to duplicate the pick logic here:
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
  await User.updateOne({ _id: winnerUid }, { $inc: { 'stats.wins': 1 } });
}
