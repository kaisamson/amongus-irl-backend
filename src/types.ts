export type Phase =
  | "LOBBY"
  | "ROLE_REVEAL"
  | "PLAYING"
  | "MEETING"
  | "VOTING"
  | "RESULT"
  | "GAME_OVER";

export type Role = "crewmate" | "impostor";

/** What a physical checkpoint is used for. */
/** `security` (cameras) and `admin` (room occupancy) are optional signs for the Skeld-style rooms. */
export type StationKind = "task" | "meeting" | "emergency" | "reactor" | "electrical" | "security" | "admin";

export type TaskType = "wiring" | "upload" | "sequence" | "delivery" | "swipe" | "shields" | "o2" | "scan" | "divert";

/** How a player proved they were at a checkpoint. */
export type CheckpointMethod = "sign" | "qr" | "gps" | "manual";

export interface Station {
  /** SFU building (e.g. "SUB") and floor id (e.g. "2000") the sign is on, from the campus map. */
  buildingId?: string;
  floorId?: string;
  id: string;
  name: string;
  kind: StationKind;
  /** Legacy: older saved maps set a task per sign. Ignored; tasks are assigned randomly at game start. */
  taskType?: TaskType;
  lat?: number;
  lng?: number;
  radiusM: number;
  /** Optional text printed on the sign; the client can OCR it as a second recognition signal. */
  signText?: string;
  /** Reference photo of the sign, served at /photos/:photoId.jpg */
  photoId?: string;
  /** Player who photographed this sign in the lobby. Player signs belong to the game, not the saved venue map. */
  addedBy?: string;
  /** Saved game (gameset) this sign was loaded from. Never written back to the venue map. */
  fromGameset?: string;
}

export interface Settings {
  impostors: number;
  minPlayers: number;
  tasksPerPlayer: number;
  killCooldownSec: number;
  roleRevealSec: number;
  gatherTimeoutSec: number;
  discussionSec: number;
  votingSec: number;
  resultSec: number;
  anonymousVotes: boolean;
  revealRoleOnEject: boolean;
  emergencyMeetingsPerPlayer: number;
  emergencyCooldownSec: number;
  /** Approximate distance (m) within which an impostor can kill. Converted to an RSSI cutoff, see rssiAt1m. */
  killDistanceM: number;
  /** Approximate distance (m) within which a living player can report a body. */
  reportDistanceM: number;
  /** Calibration: smoothed RSSI (dBm) two phones read at 1 m apart. */
  rssiAt1m: number;
  /** Path-loss exponent: ~2 in open space, 2.5–3.5 indoors with people and walls in the way. */
  pathLossExponent: number;
  /** How old a BLE sighting can be and still count. */
  proximityFreshSec: number;
  /** How long a verified checkpoint stays valid for doing tasks there. */
  checkpointTtlSec: number;
  qrFallback: boolean;
  /** Testing only: skip BLE proximity checks (simulator has no Bluetooth). */
  devSkipProximity: boolean;
  /** Testing only: allow tasks/meetings without verifying a checkpoint first. */
  devSkipCheckpoint: boolean;
  /** Demo only: allow reports and voting at parity; impostors win when no crew remain. */
  demoContinueAtParity: boolean;
  ghostTasks: boolean;
  /** Mini-games in rotation. Each sign assigned to a player gets a random one of these. */
  taskTypes: TaskType[];
  /** Testing: players who will be impostor (the rest of the impostor slots are random). Only the host sees this. */
  forcedImpostorIds: string[];
  /** Signs each (non-bot) player must add in the lobby before the game can start. 0 turns the requirement off. */
  signsPerPlayer: number;
  uploadSec: number;
  /** Submit Scan: seconds the player must stay at the scanner. */
  scanSec: number;
  sabotageCooldownSec: number;
  reactorSec: number;
  reactorWindowSec: number;
  /** Everyone sees everyone's estimated position on the map, in the lobby and in game. On by default. */
  livePositions: boolean;
  /** Play area: the SFU building and floor the game is on (campus map ids, e.g. "SUB" / "2000"). Empty = not set. */
  mapBuildingId: string;
  mapFloorId: string;
}

export const DEFAULT_SETTINGS: Settings = {
  impostors: 1,
  minPlayers: 2,
  tasksPerPlayer: 3,
  killCooldownSec: 25,
  roleRevealSec: 15,
  gatherTimeoutSec: 90,
  discussionSec: 60,
  votingSec: 45,
  resultSec: 8,
  anonymousVotes: true,
  revealRoleOnEject: true,
  emergencyMeetingsPerPlayer: 1,
  emergencyCooldownSec: 20,
  killDistanceM: 1.5,
  reportDistanceM: 3,
  rssiAt1m: -59,
  pathLossExponent: 2.2,
  proximityFreshSec: 4,
  checkpointTtlSec: 180,
  qrFallback: true,
  devSkipProximity: false,
  devSkipCheckpoint: false,
  demoContinueAtParity: false,
  ghostTasks: true,
  taskTypes: ["wiring", "upload", "sequence", "delivery", "swipe", "shields", "o2", "scan", "divert"],
  forcedImpostorIds: [],
  signsPerPlayer: 3,
  uploadSec: 8,
  scanSec: 10,
  sabotageCooldownSec: 45,
  reactorSec: 45,
  reactorWindowSec: 10,
  livePositions: true,
  mapBuildingId: "",
  mapFloorId: "",
};

export interface Task {
  id: string;
  type: TaskType;
  /** Station IDs to visit in order. Most tasks have one step; delivery and divert have two. */
  steps: string[];
  step: number;
  completed: boolean;
  /** Impostor fake tasks: accepted like real ones but never count toward progress. */
  fake: boolean;
  startedAt: number | null;
}

export interface Checkpoint {
  stationId: string;
  method: CheckpointMethod;
  at: number;
}

export const PLAYER_COLORS = [
  "red",
  "blue",
  "green",
  "pink",
  "orange",
  "yellow",
  "black",
  "white",
  "purple",
  "brown",
  "cyan",
  "lime",
  "maroon",
  "rose",
  "banana",
] as const;

export type PlayerColor = (typeof PLAYER_COLORS)[number];

export interface Player {
  id: string;
  token: string;
  name: string;
  /** Stable lobby suit color, assigned once by the authoritative server and persisted. */
  color: PlayerColor;
  /** The player's cut-out head (transparent PNG), served at /faces/:faceId.png. Null = plain crewmate. */
  faceId?: string | null;
  role: Role | null;
  alive: boolean;
  /** Whether other players have learned this player is dead (via a meeting or ejection). */
  deathKnown: boolean;
  ejected: boolean;
  body: { reported: boolean; at: number } | null;
  killedBy: string | null;
  /** Short random ID this phone advertises over BLE. Not the player ID, rotates every game. */
  bleToken: string;
  /** Payload of the player's personal QR (kill / body-report fallback). */
  qrToken: string;
  tasks: Task[];
  ackedRole: boolean;
  lastCheckpoint: Checkpoint | null;
  emergencyUsed: number;
  killCooldownUntil: number;
  vote: string | null | undefined; // undefined = not voted, null = skip
  connected: boolean;
  /** Server-run bot for testing: acknowledges its role, gathers at meetings and votes skip. */
  bot?: boolean;
}

export interface Sighting {
  rssi: number;
  at: number;
  /** The last several seconds of readings, so a single weak one doesn't drop someone out of range. */
  recent?: { rssi: number; at: number }[];
}

export type MeetingKind = "body" | "emergency";

export interface Meeting {
  kind: MeetingKind;
  calledBy: string | null;
  bodyId: string | null;
  stage: "gathering" | "discussion";
  arrived: Set<string>;
  deadline: number;
}

export interface VoteResult {
  tallies: { targetId: string | null; count: number; voterIds?: string[] }[];
  ejectedId: string | null;
  ejectedWasImpostor: boolean | null;
  tie: boolean;
  /** Impostors still in the game after this vote, shown on the ejection screen ("1 Impostor remains.").
   *  Only when roles are revealed on ejection; optional for results saved by older servers. */
  impostorsRemaining?: number | null;
}

export type Sabotage =
  | { kind: "reactor"; deadline: number; activations: Record<string, number> }
  | { kind: "lights"; deadline: null; activations: Record<string, number> };

export type Winner = "crewmates" | "impostors";

/**
 * A saved game: a named collection of already-photographed signs (and optional special stations) the
 * host can load into a lobby for a no-setup demo. Kept on the server until accounts exist.
 */
export interface Gameset {
  id: string;
  name: string;
  stations: Station[];
  createdAt: number;
  updatedAt: number;
}

export class GameError extends Error {}
