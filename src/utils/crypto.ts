import crypto from 'crypto';

// ─── Commitment Scheme ────────────────────────────────────────────────────────
// When a player selects their poison gem, they commit to a hash.
// The actual gem index is stored server-side only.
// After the game ends, all salts + indices are revealed so players can verify
// that nobody cheated and the server didn't change poison positions mid-game.

export function hashCommitment(gemIndex: number, salt: string): string {
  return crypto
    .createHash('sha256')
    .update(`${gemIndex}:${salt}`)
    .digest('hex');
}

export function verifyCommitment(
  gemIndex: number,
  salt: string,
  expectedHash: string
): boolean {
  return hashCommitment(gemIndex, salt) === expectedHash;
}

// ─── Room Code Generator ──────────────────────────────────────────────────────
// 6-character alphanumeric, uppercase. e.g. "X7K2PQ"

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 to avoid confusion

export function generateRoomCode(): string {
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += CHARS[bytes[i] % CHARS.length];
  }
  return code;
}

// ─── Turn Order Shuffle ───────────────────────────────────────────────────────
// Cryptographically random shuffle using Fisher-Yates

export function shuffleTurnOrder(uids: string[]): string[] {
  const arr = [...uids];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
