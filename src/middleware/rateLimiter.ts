import { Request, Response, NextFunction } from 'express';
import { RedisClientType } from 'redis';

// ─── Generic Redis-backed Rate Limiter ────────────────────────────────────────
// Uses a sliding window counter stored in Redis.
// Key format: ratelimit:{action}:{identifier}

interface RateLimitOptions {
  windowSeconds: number;   // Time window in seconds
  maxRequests: number;     // Max requests allowed in window
  keyPrefix: string;       // e.g. "otp", "auth", "register"
}

export function createRateLimiter(redis: RedisClientType, opts: RateLimitOptions) {
  return async (identifier: string): Promise<{ allowed: boolean; retryAfter: number }> => {
    const key = `ratelimit:${opts.keyPrefix}:${identifier}`;

    const count = await redis.incr(key);

    if (count === 1) {
      // First request — set expiry
      await redis.expire(key, opts.windowSeconds);
    }

    if (count > opts.maxRequests) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retryAfter: ttl };
    }

    return { allowed: true, retryAfter: 0 };
  };
}

// ─── Preconfigured Limiters ────────────────────────────────────────────────────

// OTP requests — max 3 per phone number per 10 minutes
// Prevents SMS bombing abuse
export function otpLimiter(redis: RedisClientType) {
  return createRateLimiter(redis, {
    windowSeconds: 600,   // 10 minutes
    maxRequests: 3,
    keyPrefix: 'otp',
  });
}

// Auth verify — max 10 per IP per minute
// Prevents token stuffing attacks
export function authLimiter(redis: RedisClientType) {
  return createRateLimiter(redis, {
    windowSeconds: 60,
    maxRequests: 10,
    keyPrefix: 'auth',
  });
}

// Username registration — max 5 per IP per hour
// Prevents username enumeration spam
export function registerLimiter(redis: RedisClientType) {
  return createRateLimiter(redis, {
    windowSeconds: 3600,
    maxRequests: 5,
    keyPrefix: 'register',
  });
}

// ─── Express Middleware Factory ───────────────────────────────────────────────
// Wraps the limiter into Express middleware using IP as identifier

export function expressRateLimit(
  redis: RedisClientType,
  opts: RateLimitOptions
) {
  const limiter = createRateLimiter(redis, opts);

  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const result = await limiter(ip);

    if (!result.allowed) {
      res.status(429).json({
        error: 'Too many requests',
        retryAfter: result.retryAfter,
      });
      return;
    }

    next();
  };
}

// ─── Socket Action Limiter ────────────────────────────────────────────────────
// Used inside socket handlers to rate limit game actions per UID

// Gem picks — max 1 per second per user (prevents spam clicking)
export function gemPickLimiter(redis: RedisClientType) {
  return createRateLimiter(redis, {
    windowSeconds: 1,
    maxRequests: 1,
    keyPrefix: 'gempick',
  });
}

// Room joins — max 10 per user per minute
export function roomJoinLimiter(redis: RedisClientType) {
  return createRateLimiter(redis, {
    windowSeconds: 60,
    maxRequests: 10,
    keyPrefix: 'roomjoin',
  });
}

// Room creates — max 5 per user per minute
export function roomCreateLimiter(redis: RedisClientType) {
  return createRateLimiter(redis, {
    windowSeconds: 60,
    maxRequests: 5,
    keyPrefix: 'roomcreate',
  });
}

// Poison commits — max 2 per user per round (1 real + 1 retry tolerance)
export function poisonCommitLimiter(redis: RedisClientType) {
  return createRateLimiter(redis, {
    windowSeconds: 300,
    maxRequests: 2,
    keyPrefix: 'poisoncommit',
  });
}
