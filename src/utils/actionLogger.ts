import { RedisClientType } from 'redis';

// ─── Action Types ─────────────────────────────────────────────────────────────

export type ActionType =
  | 'room:create'
  | 'room:join'
  | 'room:leave'
  | 'room:ready'
  | 'game:commit_poison'
  | 'game:pick_gem'
  | 'game:afk_pick'
  | 'game:over'
  | 'auth:verify'
  | 'auth:register';

export interface ActionLog {
  actionType: ActionType;
  uid: string;
  roomCode?: string;
  data?: Record<string, unknown>;
  timestamp: number;
  ip?: string;
}

// ─── Logger ───────────────────────────────────────────────────────────────────
// Stores action logs in Redis lists, one list per room.
// Lists are capped at 500 entries and expire after 24 hours.
// After game ends, full replay is available for verification.

const MAX_LOG_ENTRIES = 500;
const LOG_TTL_SECONDS = 86400; // 24 hours

export async function logAction(
  redis: RedisClientType,
  action: ActionLog
): Promise<void> {
  try {
    const key = action.roomCode
      ? `log:room:${action.roomCode}`
      : `log:auth:${action.uid}`;

    const entry = JSON.stringify({ ...action, timestamp: Date.now() });

    // Push to list and trim to max entries
    await redis.rPush(key, entry);
    await redis.lTrim(key, -MAX_LOG_ENTRIES, -1);
    await redis.expire(key, LOG_TTL_SECONDS);
  } catch (err) {
    // Logging must never crash the game
    console.error('[ActionLog] Failed to log action:', err);
  }
}

// ─── Retrieve Replay ──────────────────────────────────────────────────────────
// Called after game ends to return full action history

export async function getRoomReplay(
  redis: RedisClientType,
  roomCode: string
): Promise<ActionLog[]> {
  try {
    const key = `log:room:${roomCode}`;
    const entries = await redis.lRange(key, 0, -1);
    return entries.map(e => JSON.parse(e) as ActionLog);
  } catch {
    return [];
  }
}

// ─── Suspicious Pattern Detector ─────────────────────────────────────────────
// Runs after each game action to flag suspicious behaviour

export async function detectSuspiciousActivity(
  redis: RedisClientType,
  uid: string,
  roomCode: string
): Promise<{ suspicious: boolean; reason?: string }> {
  try {
    const replay = await getRoomReplay(redis, roomCode);
    const userActions = replay.filter(a => a.uid === uid);

    // Flag 1: More than 2 poison commits in one round (shouldn't be possible)
    const poisonCommits = userActions.filter(a => a.actionType === 'game:commit_poison');
    if (poisonCommits.length > 2) {
      return { suspicious: true, reason: 'Multiple poison commits detected' };
    }

    // Flag 2: Gem picks faster than 500ms apart (bot-like speed)
    const picks = userActions
      .filter(a => a.actionType === 'game:pick_gem')
      .sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 1; i < picks.length; i++) {
      const gap = picks[i].timestamp - picks[i - 1].timestamp;
      if (gap < 500) {
        return { suspicious: true, reason: 'Picks too fast — possible bot' };
      }
    }

    // Flag 3: Joining and leaving rooms too rapidly (room farming)
    const joins = userActions.filter(a => a.actionType === 'room:join');
    if (joins.length > 5) {
      return { suspicious: true, reason: 'Excessive room joins' };
    }

    return { suspicious: false };
  } catch {
    return { suspicious: false };
  }
}

// ─── Ban Check ────────────────────────────────────────────────────────────────

export async function isBanned(
  redis: RedisClientType,
  uid: string
): Promise<boolean> {
  const banned = await redis.get(`ban:${uid}`);
  return !!banned;
}

export async function banUser(
  redis: RedisClientType,
  uid: string,
  reason: string,
  durationSeconds: number = 86400 // 24h default
): Promise<void> {
  await redis.setEx(`ban:${uid}`, durationSeconds, reason);
  console.warn(`[Ban] User ${uid} banned for ${durationSeconds}s: ${reason}`);
}
