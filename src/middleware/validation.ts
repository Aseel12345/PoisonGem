import { Request, Response, NextFunction } from 'express';

// ─── Username Validator ───────────────────────────────────────────────────────

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const FORBIDDEN_USERNAMES = [
  'admin', 'root', 'system', 'poisongem', 'moderator',
  'mod', 'staff', 'support', 'official', 'bot',
];

export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string') return 'Username must be a string';
  if (!USERNAME_REGEX.test(username)) return 'Username must be 3–20 chars, letters/numbers/underscores only';
  if (FORBIDDEN_USERNAMES.includes(username.toLowerCase())) return 'Username is reserved';
  return null; // null = valid
}

// ─── Phone Number Validator ───────────────────────────────────────────────────

export function validatePhone(phone: unknown): string | null {
  if (typeof phone !== 'string') return 'Phone must be a string';
  // E.164 format: +[country code][number], 8–15 digits total
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return 'Invalid phone number format';
  return null;
}

// ─── Room Code Validator ──────────────────────────────────────────────────────

export function validateRoomCode(code: unknown): string | null {
  if (typeof code !== 'string') return 'Room code must be a string';
  if (!/^[A-Z2-9]{6}$/.test(code)) return 'Invalid room code format';
  return null;
}

// ─── Gem Index Validator ──────────────────────────────────────────────────────

export function validateGemIndex(index: unknown, maxGems: number): string | null {
  if (typeof index !== 'number') return 'Gem index must be a number';
  if (!Number.isInteger(index)) return 'Gem index must be an integer';
  if (index < 0 || index >= maxGems) return `Gem index out of range (0–${maxGems - 1})`;
  return null;
}

// ─── ID Token Validator ───────────────────────────────────────────────────────

export function validateIdToken(token: unknown): string | null {
  if (typeof token !== 'string') return 'Token must be a string';
  if (token.length < 100) return 'Token too short to be valid';
  if (token.length > 4096) return 'Token too long';
  return null;
}

// ─── Express Middleware — Sanitize Request Body ───────────────────────────────
// Strips unknown fields, trims strings, prevents prototype pollution

export function sanitizeBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  next();
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Block prototype pollution keys
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }

    if (typeof value === 'string') {
      clean[key] = value.trim().slice(0, 10000); // Trim + cap length
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
    } else if (value === null) {
      clean[key] = null;
    }
    // Drop arrays, nested objects, functions from body for security
  }

  return clean;
}

// ─── Socket Payload Validator ─────────────────────────────────────────────────
// Call these inside socket handlers before processing

export function validateSocketPayload(
  payload: unknown,
  requiredFields: string[]
): { valid: boolean; error?: string } {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Invalid payload' };
  }

  const obj = payload as Record<string, unknown>;

  for (const field of requiredFields) {
    if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Check for suspiciously large payloads
  const payloadSize = JSON.stringify(payload).length;
  if (payloadSize > 5000) {
    return { valid: false, error: 'Payload too large' };
  }

  return { valid: true };
}

// ─── UID Ownership Check ──────────────────────────────────────────────────────
// Verifies the UID in the payload matches the authenticated socket's UID
// Prevents players from acting as other players

export function validateUidOwnership(
  payloadUid: unknown,
  authenticatedUid: string
): boolean {
  return typeof payloadUid === 'string' && payloadUid === authenticatedUid;
}
