// ─── Player ───────────────────────────────────────────────────────────────────

export interface Player {
  uid: string;           // Firebase UID
  username: string;
  socketId: string;
  isAlive: boolean;
  isReady: boolean;
  isConnected: boolean;
}

// ─── Gem ──────────────────────────────────────────────────────────────────────

export interface Gem {
  index: number;         // Position in the pattern
  isEliminated: boolean; // Has been picked and removed from board
  // poisonedBy is intentionally NOT stored here — lives server-side only
}

// ─── Poison Commitment (Anti-Cheat) ───────────────────────────────────────────

// When a player poisons a gem, they send this hash.
// Actual gemIndex is stored separately on the server, never sent to clients.
export interface PoisonCommitment {
  uid: string;
  commitHash: string;    // SHA256(gemIndex + ":" + salt)
  salt: string;          // Revealed only after round ends for verification
  gemIndex: number;      // Hidden until reveal — never broadcast during game
}

// ─── Room ─────────────────────────────────────────────────────────────────────

export type RoomStatus = 'waiting' | 'poisoning' | 'playing' | 'finished';

export interface Room {
  roomCode: string;          // 6-digit alphanumeric
  hostUid: string;
  players: Player[];
  maxPlayers: number;        // 2–10
  status: RoomStatus;
  isPrivate: boolean;
  currentTurnUid: string | null;
  turnOrder: string[];       // UIDs in turn order
  gems: Gem[];
  poisonCommitments: PoisonCommitment[];
  afkTimerStart: number | null;  // timestamp when turn started
  winnerUid: string | null;
  roundNumber: number;
  createdAt: number;
}

// ─── Socket Event Payloads ────────────────────────────────────────────────────

// Client → Server
export interface CreateRoomPayload {
  uid: string;
  username: string;
  isPrivate: boolean;
  maxPlayers: number;
}

export interface JoinRoomPayload {
  uid: string;
  username: string;
  roomCode: string;
}

export interface ReadyUpPayload {
  uid: string;
  roomCode: string;
}

export interface CommitPoisonPayload {
  uid: string;
  roomCode: string;
  commitHash: string;  // SHA256(gemIndex + ":" + salt) — client hashes locally
  gemIndex: number;    // Actual choice — server stores this, never broadcasts it
  salt: string;
}

export interface PickGemPayload {
  uid: string;
  roomCode: string;
  gemIndex: number;
}

export interface RematchVotePayload {
  uid: string;
  roomCode: string;
}

// Server → Client
export interface RoomUpdatePayload {
  room: RoomPublic;  // Safe public version of room state
}

export interface GameStartPayload {
  room: RoomPublic;
  yourTurn: boolean;
}

export interface GemPickedPayload {
  pickerUid: string;
  gemIndex: number;
  wasPoison: boolean;         // Did this kill the picker?
  poisonedByUid: string | null; // Who poisoned this gem (null if safe)
  eliminatedUid: string | null; // Who died (null if safe pick)
  nextTurnUid: string | null;
}

export interface GameOverPayload {
  winnerUid: string | null;   // null = draw (shouldn't happen but safety)
  winnerUsername: string | null;
  poisonReveals: PoisonReveal[];  // Full reveal for verification
}

export interface PoisonReveal {
  uid: string;
  username: string;
  gemIndex: number;
  salt: string;
  commitHash: string;
}

export interface ErrorPayload {
  message: string;
  code: string;
}

// ─── Public Room (safe to broadcast) ─────────────────────────────────────────
// Strip poison info before sending to clients

export interface RoomPublic {
  roomCode: string;
  hostUid: string;
  players: PlayerPublic[];
  maxPlayers: number;
  status: RoomStatus;
  isPrivate: boolean;
  currentTurnUid: string | null;
  gems: Gem[];
  commitmentCount: number;   // How many players have committed (not who/which gem)
  winnerUid: string | null;
  roundNumber: number;
}

export interface PlayerPublic {
  uid: string;
  username: string;
  isAlive: boolean;
  isReady: boolean;
  isConnected: boolean;
}
