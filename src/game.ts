import { randomBytes, randomUUID } from "node:crypto";
import {
  type CheckpointMethod,
  DEFAULT_SETTINGS,
  GameError,
  type Meeting,
  type MeetingKind,
  type Phase,
  type Player,
  PLAYER_COLORS,
  type PlayerColor,
  type Sabotage,
  type Settings,
  type Sighting,
  type Station,
  type Gameset,
  type Task,
  type TaskType,
  type VoteResult,
  type Winner,
} from "./types.ts";
import { BotWalker, fusePositions, parseReport, type PlayerPosition, type PositionReport } from "./positions.ts";

export type Outbound =
  | { type: "state"; state: StateView }
  | { type: "event"; event: string; data?: unknown }
  | { type: "positions"; positions: PlayerPosition[] }
  | { type: "cam"; playerId: string; jpeg: string; at: number };

export type Send = (playerId: string, msg: Outbound) => void;

export interface GameHooks {
  /** Host edited the venue map. */
  onStationsChanged?: (stations: Station[]) => void;
  /** Durable game state changed (not fired for high-frequency BLE reports). Used to snapshot to Redis. */
  onChange?: () => void;
  onGameOver?: (summary: GameSummary) => void;
}

export interface GameSummary {
  code: string;
  mapId: string;
  startedAt: number;
  endedAt: number;
  winner: Winner;
  winReason: string;
  players: { name: string; role: Player["role"]; alive: boolean; ejected: boolean }[];
}

/** Everything needed to rebuild a live game after a server restart. BLE sightings are deliberately dropped. */
export interface GameSnapshot {
  v: 1;
  code: string;
  mapId: string;
  phase: Phase;
  hostId: string;
  settings: Settings;
  stations: Station[];
  players: Player[];
  meeting: (Omit<Meeting, "arrived"> & { arrived: string[] }) | null;
  phaseDeadline: number | null;
  result: VoteResult | null;
  sabotage: Sabotage | null;
  sabotageAvailableAt: number;
  emergencyAvailableAt: number;
  winner: Winner | null;
  winReason: string | null;
  startedAt: number;
  lastActivity: number;
  /** Optional: snapshots from before gamesets existed don't have these. */
  gameset?: { id: string; name: string } | null;
  stationsBeforeGameset?: Station[] | null;
  signsBeforeGameset?: number | null;
}

const MAX_PLAYERS = 15;
const STATION_KINDS = ["task", "meeting", "emergency", "reactor", "electrical", "security", "admin"];
/** How many of each special sign a map can have; adding another replaces the oldest. */
const SPECIAL_LIMIT: Record<string, number> = { meeting: 1, emergency: 1, reactor: 2, electrical: 1, security: 1, admin: 1 };

/** Validates and normalizes a sign/station sent by a phone (lobby or gameset editor). */
export function buildStation(s: Partial<Station>, extra: Partial<Station> = {}): Station {
  if (!s?.name || !s.kind || !STATION_KINDS.includes(s.kind)) throw new GameError("Station needs a name and kind");
  return {
    id: shortId(4),
    name: String(s.name).slice(0, 40),
    kind: s.kind,
    lat: typeof s.lat === "number" ? s.lat : undefined,
    lng: typeof s.lng === "number" ? s.lng : undefined,
    radiusM: typeof s.radiusM === "number" ? s.radiusM : 15,
    signText: typeof s.signText === "string" ? s.signText.trim().slice(0, 60) || undefined : undefined,
    photoId: typeof s.photoId === "string" ? s.photoId : undefined,
    buildingId: typeof s.buildingId === "string" && s.buildingId.trim() ? s.buildingId.trim().slice(0, 12) : undefined,
    floorId: typeof s.floorId === "string" && s.floorId.trim() ? s.floorId.trim().slice(0, 12) : undefined,
    ...extra,
  };
}

/**
 * Moves a saved sign: its map pin and campus building/floor. Everything else (photo, text, kind) stays.
 * A blank building or floor clears it (the pin is off campus or the floor is unknown).
 */
export function placeStation(station: Station, s: { lat?: unknown; lng?: unknown; buildingId?: unknown; floorId?: unknown }): Station {
  const { lat, lng } = s;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)
    || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new GameError("Pin needs a latitude and longitude");
  }
  const id = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 12) : undefined);
  return { ...station, lat, lng, buildingId: id(s.buildingId), floorId: id(s.floorId) };
}

function shortId(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TASK_TYPES: TaskType[] = ["wiring", "upload", "sequence", "delivery", "swipe", "shields", "o2", "scan", "divert"];
/** Tasks done at two different signs: pick up/drop off, divert/accept power. */
const TWO_STEP_TYPES: TaskType[] = ["delivery", "divert"];

/**
 * Log-distance path-loss model: the RSSI expected at `distanceM`, given the RSSI measured at 1 m.
 * BLE RSSI is noisy (bodies, pockets, orientation), so treat distances as approximate.
 */
export function rssiAtDistance(distanceM: number, rssiAt1m: number, pathLossExponent: number): number {
  return rssiAt1m - 10 * pathLossExponent * Math.log10(Math.max(distanceM, 0.1));
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export class Game {
  readonly code: string;
  readonly mapId: string;
  phase: Phase = "LOBBY";
  hostId: string;
  settings: Settings = { ...DEFAULT_SETTINGS };
  stations: Station[];
  players = new Map<string, Player>();
  /** observerId -> subjectId -> latest sighting */
  sightings = new Map<string, Map<string, Sighting>>();
  /** Each phone's latest position estimate (not persisted: it's stale after a restart anyway). */
  positionReports = new Map<string, PositionReport>();
  /** Security cameras: who is watching, and each phone's latest front-camera frame (JPEG, base64). Not persisted. */
  camWatchers = new Set<string>();
  private camFrames = new Map<string, { jpeg: string; at: number }>();
  private botWalker = new BotWalker();
  private positionsSentAt = 0;
  private lastPositionsSent = new Map<string, string>();
  meeting: Meeting | null = null;
  phaseDeadline: number | null = null;
  result: VoteResult | null = null;
  sabotage: Sabotage | null = null;
  sabotageAvailableAt = 0;
  emergencyAvailableAt = 0;
  winner: Winner | null = null;
  winReason: string | null = null;
  startedAt = 0;
  lastActivity: number;
  /** Saved game whose signs this lobby is using, if any. */
  gameset: { id: string; name: string } | null = null;
  private stationsBeforeGameset: Station[] | null = null;
  private signsBeforeGameset: number | null = null;

  private lastSent = new Map<string, string>();

  constructor(
    code: string,
    mapId: string,
    stations: Station[],
    private send: Send,
    private hooks: GameHooks = {},
    readonly now: () => number = Date.now,
  ) {
    this.code = code;
    this.mapId = mapId;
    this.stations = stations;
    this.hostId = "";
    this.lastActivity = now();
  }

  // ---------------------------------------------------------------- players

  /** `preferredColor`: the suit the player picked before joining; used when nobody else is wearing it. */
  addPlayer(name: string, preferredColor?: unknown): Player {
    const trimmed = name.trim().slice(0, 20);
    if (!trimmed) throw new GameError("Name required");
    if (this.phase !== "LOBBY") throw new GameError("Game already started");
    if (this.players.size >= MAX_PLAYERS) throw new GameError("Lobby is full");
    if ([...this.players.values()].some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new GameError("Name already taken");
    }
    const p: Player = {
      id: randomUUID(),
      token: shortId(16),
      name: trimmed,
      color:
        typeof preferredColor === "string" && PLAYER_COLORS.includes(preferredColor as PlayerColor)
        && ![...this.players.values()].some((o) => o.color === preferredColor)
          ? (preferredColor as PlayerColor)
          : this.nextPlayerColor(),
      role: null,
      alive: true,
      deathKnown: false,
      ejected: false,
      body: null,
      killedBy: null,
      bleToken: shortId(3),
      qrToken: shortId(8),
      tasks: [],
      ackedRole: false,
      lastCheckpoint: null,
      emergencyUsed: 0,
      killCooldownUntil: 0,
      vote: undefined,
      connected: false,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.touch();
    return p;
  }

  private nextPlayerColor(used = new Set([...this.players.values()].map((player) => player.color))): PlayerColor {
    return PLAYER_COLORS.find((color) => !used.has(color)) ?? PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
  }

  authenticate(playerId: string, token: string): Player | null {
    const p = this.players.get(playerId);
    return p && p.token === token ? p : null;
  }

  setConnected(playerId: string, connected: boolean) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = connected;
    if (connected) {
      this.lastSent.delete(playerId); // force a full snapshot on (re)connect
      this.lastPositionsSent.delete(playerId);
    }
    this.broadcast();
  }

  // ---------------------------------------------------------------- actions

  handle(playerId: string, action: string, payload: any): unknown {
    const p = this.players.get(playerId);
    if (!p) throw new GameError("Unknown player");
    this.touch();
    let result: unknown;
    switch (action) {
      case "update_settings": result = this.updateSettings(p, payload); break;
      case "add_station": result = this.addStation(p, payload); break;
      case "delete_station": result = this.deleteStation(p, payload); break;
      case "kick": result = this.kick(p, payload); break;
      case "set_color": result = this.setColor(p, payload); break;
      case "set_face": result = this.setFace(p, payload); break;
      case "add_bot": result = this.addBot(p); break;
      case "start_game": result = this.startGame(p); break;
      case "ack_role": result = this.ackRole(p); break;
      case "proximity": result = this.proximity(p, payload); break;
      case "position": result = this.reportPosition(p, payload); break;
      case "cam_watch": result = this.camWatch(p, payload); break;
      case "cam_frame": result = this.camFrame(p, payload); break;
      case "checkpoint": result = this.checkpoint(p, payload); break;
      case "task_start": result = this.taskStart(p, payload); break;
      case "task_complete": result = this.taskComplete(p, payload); break;
      case "kill": result = this.kill(p, payload); break;
      case "report_body": result = this.reportBody(p, payload); break;
      case "call_emergency": result = this.callEmergency(p); break;
      case "vote": result = this.vote(p, payload); break;
      case "sabotage": result = this.startSabotage(p, payload); break;
      case "fix_sabotage": result = this.fixSabotage(p, payload); break;
      case "host_advance": result = this.hostAdvance(p); break;
      case "restart": result = this.restart(p); break;
      default: throw new GameError(`Unknown action: ${action}`);
    }
    // Positions and camera frames only feed their own streams, never the game state.
    if (action === "position" || action === "cam_frame") return result;
    this.broadcast();
    if (action !== "proximity") this.hooks.onChange?.();
    return result;
  }

  private requireHost(p: Player) {
    if (p.id !== this.hostId) throw new GameError("Only the host can do that");
  }

  private requirePhase(...phases: Phase[]) {
    if (!phases.includes(this.phase)) throw new GameError(`Not allowed during ${this.phase}`);
  }

  /** Any player can change lobby settings, except forced impostors and demo win rules (host only). */
  private updateSettings(p: Player, patch: Partial<Settings>) {
    // Live positions is a testing switch that may be flipped mid-game; everything else is lobby-only.
    const keys = Object.keys(patch ?? {});
    if (keys.includes("forcedImpostorIds") || keys.includes("demoContinueAtParity")) this.requireHost(p);
    if (!(keys.length > 0 && keys.every((k) => k === "livePositions"))) this.requirePhase("LOBBY");
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!(k in DEFAULT_SETTINGS)) throw new GameError(`Unknown setting: ${k}`);
      if (k === "taskTypes") {
        if (!Array.isArray(v) || v.length === 0 || !v.every((t) => TASK_TYPES.includes(t as TaskType))) {
          throw new GameError("Pick at least one task type");
        }
        this.settings.taskTypes = [...new Set(v as TaskType[])];
        continue;
      }
      if (k === "forcedImpostorIds") {
        if (!Array.isArray(v) || !v.every((id) => this.players.has(id))) throw new GameError("Unknown player");
        this.settings.forcedImpostorIds = [...new Set(v as string[])];
        continue;
      }
      const expected = typeof (DEFAULT_SETTINGS as any)[k];
      if (typeof v !== expected) throw new GameError(`Setting ${k} must be ${expected}`);
      if (typeof v === "number" && !Number.isFinite(v)) throw new GameError(`Setting ${k} must be a number`);
      if (typeof v === "number" && v < 0 && k !== "rssiAt1m") throw new GameError(`Setting ${k} can't be negative`);
      if ((k === "mapBuildingId" || k === "mapFloorId") && ((v as string).length > 12 || /[^\w.-]/.test(v as string))) {
        throw new GameError("Bad building or floor id");
      }
      if (k === "signsPerPlayer" && (!Number.isInteger(v) || (v as number) > 10)) {
        throw new GameError("Signs per player must be a whole number from 0 to 10");
      }
      if ((k === "killDistanceM" || k === "reportDistanceM" || k === "pathLossExponent") && (v as number) <= 0) {
        throw new GameError(`Setting ${k} must be greater than 0`);
      }
      (this.settings as any)[k] = v;
    }
  }

  /**
   * Any player adds task signs (their required signs); special stations (meeting point, emergency button,
   * reactor, electrical) are host-only and saved with the venue map.
   */
  private addStation(p: Player, s: Partial<Station>) {
    this.requirePhase("LOBBY");
    if (!s?.name || !s.kind) throw new GameError("Station needs a name and kind");
    const station = buildStation(s, { addedBy: s.kind === "task" ? p.id : undefined });
    // Special signs (red button, sabotage, security, admin): anyone can set them; a new one replaces the oldest.
    const limit = SPECIAL_LIMIT[station.kind];
    if (limit !== undefined) {
      const same = this.stations.filter((st) => st.kind === station.kind);
      const drop = new Set(same.slice(0, Math.max(0, same.length - limit + 1)).map((st) => st.id));
      this.stations = this.stations.filter((st) => !drop.has(st.id));
    }
    this.stations.push(station);
    this.hooks.onStationsChanged?.(this.stations);
    return station;
  }

  private deleteStation(p: Player, { stationId }: { stationId: string }) {
    this.requirePhase("LOBBY");
    const station = this.stations.find((s) => s.id === stationId);
    // Anyone can remove special signs and their own task signs; only the host removes other players' signs.
    if (station?.kind === "task" && station.addedBy !== p.id) this.requireHost(p);
    this.stations = this.stations.filter((s) => s.id !== stationId);
    this.hooks.onStationsChanged?.(this.stations);
  }

  /**
   * Use a saved game's signs in this lobby (no-setup demo), or `null` to stop using it. Players' own
   * photographed signs are kept either way, and so are special signs (red button, sabotage, ...) of
   * kinds the saved game doesn't have. The per-player requirement stays: the saved game's signs count
   * toward the total and players split what's left (see `signQuotas`).
   */
  useGameset(playerId: string, gameset: Gameset | null) {
    const p = this.players.get(playerId);
    if (!p) throw new GameError("Unknown player");
    this.requirePhase("LOBBY"); // any player can pick the saved game
    const playerSigns = this.stations.filter((s) => s.addedBy);
    const baseStations = this.gameset ? (this.stationsBeforeGameset ?? []) : this.stations.filter((s) => !s.addedBy);
    if (gameset) {
      if (!this.gameset) this.stationsBeforeGameset = baseStations;
      const loaded = gameset.stations.map(({ addedBy: _owner, ...s }) => ({ ...s, fromGameset: gameset.id }));
      const loadedKinds = new Set(loaded.map((s) => s.kind));
      const keptSpecials = this.stations.filter(
        (s) => !s.addedBy && !s.fromGameset && s.kind !== "task" && !loadedKinds.has(s.kind),
      );
      this.stations = [...loaded, ...keptSpecials, ...playerSigns];
      this.gameset = { id: gameset.id, name: gameset.name };
    } else if (this.gameset) {
      // Special signs set while the saved game was in use win over the old ones of the same kind.
      const addedSince = this.stations.filter(
        (s) => !s.addedBy && !s.fromGameset && !baseStations.some((b) => b.id === s.id),
      );
      const sinceKinds = new Set(addedSince.map((s) => s.kind));
      this.stations = [...baseStations.filter((s) => !sinceKinds.has(s.kind)), ...addedSince, ...playerSigns];
      // Older lobbies turned the requirement off while a saved game was in use: put it back.
      if (this.signsBeforeGameset !== null) this.settings.signsPerPlayer = this.signsBeforeGameset;
      this.gameset = null;
      this.stationsBeforeGameset = null;
      this.signsBeforeGameset = null;
    }
    this.touch();
    this.hooks.onChange?.();
    this.broadcast();
    return this.stations.filter((s) => s.kind === "task").length;
  }

  /**
   * Signs each non-bot player still owes. The game wants `signsPerPlayer` per player in total; signs
   * that are already there (a saved game's) count toward it, and the rest is split as evenly as
   * possible, in join order. Without preset signs that's simply `signsPerPlayer` each.
   */
  signQuotas(): Record<string, number> {
    const humans = [...this.players.values()].filter((pl) => !pl.bot);
    const need = this.settings.signsPerPlayer;
    if (need <= 0 || humans.length === 0) return Object.fromEntries(humans.map((pl) => [pl.id, 0]));
    const preset = this.stations.filter((st) => st.kind === "task" && !st.addedBy).length;
    const remaining = Math.max(0, need * humans.length - preset);
    const base = Math.floor(remaining / humans.length);
    const extra = remaining % humans.length;
    return Object.fromEntries(humans.map((pl, i) => [pl.id, Math.min(need, base + (i < extra ? 1 : 0))]));
  }

  /** Non-bot players who haven't added their share of signs yet. */
  playersMissingSigns(): Player[] {
    const quotas = this.signQuotas();
    return [...this.players.values()].filter(
      (pl) => !pl.bot && this.stations.filter((st) => st.kind === "task" && st.addedBy === pl.id).length < (quotas[pl.id] ?? 0),
    );
  }

  /** Where meetings gather: the meeting point, or the red button when there's no separate one. */
  private meetingPoints(): Station[] {
    const meeting = this.stations.filter((s) => s.kind === "meeting");
    return meeting.length > 0 ? meeting : this.stations.filter((s) => s.kind === "emergency");
  }

  /** Host-only testing aid: a server-run player so a lobby can reach the minimum with fewer phones. */
  private addBot(p: Player) {
    this.requireHost(p);
    this.requirePhase("LOBBY");
    const taken = new Set([...this.players.values()].map((pl) => pl.name.toLowerCase()));
    let n = 1;
    while (taken.has(`bot ${n}`)) n++;
    const bot = this.addPlayer(`Bot ${n}`);
    bot.bot = true;
    bot.connected = true;
    return { playerId: bot.id };
  }

  /** Bots do the bare minimum so games can progress: ack roles, gather, vote skip. They never kill. */
  private runBots() {
    const bots = [...this.players.values()].filter((pl) => pl.bot);
    if (bots.length === 0) return;
    if (this.phase === "ROLE_REVEAL") {
      for (const b of bots) if (!b.ackedRole && this.phase === "ROLE_REVEAL") this.ackRole(b);
    } else if (this.phase === "MEETING" && this.meeting?.stage === "gathering") {
      for (const b of bots) if (b.alive) this.meeting.arrived.add(b.id);
      this.maybeStartDiscussion();
    } else if (this.phase === "VOTING") {
      for (const b of bots) if (b.alive && b.vote === undefined && this.phase === "VOTING") this.vote(b, { targetId: null });
    }
  }

  /** Lobby customization: pick any suit color nobody else is wearing. */
  private setColor(p: Player, { color }: { color: string }) {
    this.requirePhase("LOBBY");
    if (!PLAYER_COLORS.includes(color as PlayerColor)) throw new GameError("Unknown color");
    if ([...this.players.values()].some((o) => o.id !== p.id && o.color === color)) {
      throw new GameError("That color is taken");
    }
    p.color = color as PlayerColor;
  }

  /** Lobby customization: a head uploaded to POST /faces, or null to remove it. */
  private setFace(p: Player, { faceId }: { faceId: string | null }) {
    this.requirePhase("LOBBY");
    if (faceId !== null && (typeof faceId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(faceId))) {
      throw new GameError("Bad face id");
    }
    p.faceId = faceId;
  }

  private kick(p: Player, { playerId }: { playerId: string }) {
    this.requireHost(p);
    this.requirePhase("LOBBY");
    if (playerId === p.id) throw new GameError("Can't kick yourself");
    this.players.delete(playerId);
    this.settings.forcedImpostorIds = this.settings.forcedImpostorIds.filter((id) => id !== playerId);
    this.stations = this.stations.filter((st) => st.addedBy !== playerId);
    this.send(playerId, { type: "event", event: "KICKED" });
  }

  private startGame(p: Player) {
    this.requireHost(p);
    this.requirePhase("LOBBY");
    const players = [...this.players.values()];
    const s = this.settings;
    if (players.length < s.minPlayers) throw new GameError(`Need at least ${s.minPlayers} players`);
    const isTwoPlayerGame = players.length === 2 && s.impostors === 1;
    if (s.impostors < 1 || (!isTwoPlayerGame && s.impostors * 2 >= players.length)) {
      throw new GameError("Too many impostors for this many players");
    }
    if (!this.stations.some((st) => st.kind === "emergency")) {
      throw new GameError("Add the red button sign (emergency meeting) first");
    }
    const missing = this.playersMissingSigns();
    if (missing.length > 0) {
      throw new GameError(`Waiting for ${missing.map((pl) => pl.name).join(", ")} to add their signs`);
    }
    const taskStations = this.stations.filter((st) => st.kind === "task");

    const forced = s.forcedImpostorIds.filter((id) => this.players.has(id));
    if (forced.length > s.impostors) throw new GameError(`Only ${s.impostors} impostor(s): pick fewer forced impostors`);
    const randomPool = shuffle(players.filter((pl) => !forced.includes(pl.id)));
    const impostorIds = new Set([...forced, ...randomPool.slice(0, s.impostors - forced.length).map((pl) => pl.id)]);
    for (const pl of players) {
      pl.role = impostorIds.has(pl.id) ? "impostor" : "crewmate";
      pl.alive = true;
      pl.deathKnown = false;
      pl.ejected = false;
      pl.body = null;
      pl.killedBy = null;
      pl.bleToken = shortId(3);
      pl.qrToken = shortId(8);
      pl.ackedRole = false;
      pl.lastCheckpoint = null;
      pl.emergencyUsed = 0;
      pl.vote = undefined;
      pl.tasks = this.assignTasks(taskStations, pl.role === "impostor");
    }
    this.sightings.clear();
    this.meeting = null;
    this.result = null;
    this.sabotage = null;
    this.winner = null;
    this.winReason = null;
    this.phase = "ROLE_REVEAL";
    this.startedAt = this.now();
    this.phaseDeadline = this.now() + s.roleRevealSec * 1000;

    this.emitAll("GAME_STARTED");
    for (const pl of players) this.emit([pl.id], "ROLE_ASSIGNED", { role: pl.role });
  }

  /**
   * Signs are just places. Each player gets `tasksPerPlayer` different signs, and each of those gets a
   * random mini-game from the host's rotation. Delivery and Divert Power also need a second sign to finish at.
   */
  private assignTasks(taskStations: Station[], fake: boolean): Task[] {
    const picks = shuffle(taskStations).slice(0, this.settings.tasksPerPlayer);
    return picks.map((st) => {
      const others = taskStations.filter((o) => o.id !== st.id);
      let types = this.settings.taskTypes.filter((t) => !TWO_STEP_TYPES.includes(t) || others.length > 0);
      if (types.length === 0) types = ["wiring"];
      const type = types[Math.floor(Math.random() * types.length)];
      const steps = TWO_STEP_TYPES.includes(type) ? [st.id, shuffle(others)[0].id] : [st.id];
      return { id: shortId(4), type, steps, step: 0, completed: false, fake, startedAt: null };
    });
  }

  private get killRssi() {
    return rssiAtDistance(this.settings.killDistanceM, this.settings.rssiAt1m, this.settings.pathLossExponent);
  }

  private get reportRssi() {
    return rssiAtDistance(this.settings.reportDistanceM, this.settings.rssiAt1m, this.settings.pathLossExponent);
  }

  private ackRole(p: Player) {
    this.requirePhase("ROLE_REVEAL");
    p.ackedRole = true;
    if ([...this.players.values()].every((pl) => pl.ackedRole)) this.beginPlaying();
  }

  private beginPlaying() {
    const now = this.now();
    this.phase = "PLAYING";
    this.phaseDeadline = null;
    this.meeting = null;
    for (const pl of this.players.values()) {
      pl.vote = undefined;
      if (pl.role === "impostor") pl.killCooldownUntil = now + this.settings.killCooldownSec * 1000;
    }
    this.sabotageAvailableAt = now + this.settings.sabotageCooldownSec * 1000;
    this.emergencyAvailableAt = now + this.settings.emergencyCooldownSec * 1000;
    this.emitAll("PLAYING");
  }

  // ------------------------------------------------------------ proximity

  /** Phones report which BLE tokens they currently hear and at what RSSI. */
  private proximity(p: Player, { sightings }: { sightings: { token: string; rssi: number }[] }) {
    if (!Array.isArray(sightings)) throw new GameError("sightings required");
    const byToken = new Map([...this.players.values()].map((pl) => [pl.bleToken, pl]));
    let mine = this.sightings.get(p.id);
    if (!mine) this.sightings.set(p.id, (mine = new Map()));
    const now = this.now();
    for (const s of sightings) {
      const subject = byToken.get(s.token);
      if (subject && subject.id !== p.id && typeof s.rssi === "number") {
        const keep = Math.max(this.settings.proximityFreshSec, 1) * 1000;
        const recent = (mine.get(subject.id)?.recent ?? []).filter((r) => now - r.at <= keep);
        recent.push({ rssi: s.rssi, at: now });
        mine.set(subject.id, { rssi: s.rssi, at: now, recent });
      }
    }
  }

  /** A phone's own position estimate (see positions.ts). */
  private reportPosition(p: Player, payload: unknown) {
    this.positionReports.set(p.id, parseReport(payload, this.now()));
  }

  // ------------------------------------------------------------ security cameras

  /** Dead players can always watch during play; the living only right after scanning the Security sign. */
  canWatchCams(p: Player): boolean {
    if (this.phase !== "PLAYING") return false;
    if (!p.alive) return true;
    const cp = p.lastCheckpoint;
    const station = cp && this.stations.find((s) => s.id === cp.stationId);
    return !!cp && station?.kind === "security" && this.now() - cp.at <= this.settings.checkpointTtlSec * 1000;
  }

  private camWatch(p: Player, { on }: { on?: boolean }) {
    if (!on) {
      this.camWatchers.delete(p.id);
      return;
    }
    if (!this.canWatchCams(p)) throw new GameError("Scan the Security sign to watch the cameras");
    this.camWatchers.add(p.id);
    // Show what we already have straight away.
    for (const [playerId, frame] of this.camFrames) {
      if (playerId !== p.id) this.send(p.id, { type: "cam", playerId, ...frame });
    }
  }

  /** A phone's front-camera frame: relayed to whoever is watching (about 4 a second at most). */
  private camFrame(p: Player, { jpeg }: { jpeg?: unknown }) {
    if (this.phase !== "PLAYING") return;
    if (typeof jpeg !== "string" || jpeg.length === 0 || jpeg.length > 80_000) throw new GameError("Bad camera frame");
    const now = this.now();
    const last = this.camFrames.get(p.id);
    if (last && now - last.at < 200) return;
    const frame = { jpeg, at: now };
    this.camFrames.set(p.id, frame);
    for (const id of this.camWatchers) {
      if (id !== p.id) this.send(id, { type: "cam", playerId: p.id, ...frame });
    }
  }

  /** Drop watchers who can't watch any more (left Security, meeting called); forget frames outside play. */
  private pruneCams() {
    const before = this.camWatchers.size;
    for (const id of this.camWatchers) {
      const p = this.players.get(id);
      if (!p || !this.canWatchCams(p)) this.camWatchers.delete(id);
    }
    if (this.phase !== "PLAYING") this.camFrames.clear();
    return before !== this.camWatchers.size;
  }

  /** Everyone's fused position, or [] when live positions are off. */
  livePositions(): PlayerPosition[] {
    if (!this.settings.livePositions || this.phase === "GAME_OVER") return [];
    const players = [...this.players.values()];
    const reports = new Map(this.positionReports);
    const bots = players.filter((pl) => pl.bot);
    for (const [id, r] of this.botWalker.positions(bots, this.stations, this.now())) reports.set(id, r);
    return fusePositions({
      players,
      stations: this.stations,
      reports,
      sightings: this.sightings,
      rssiAt1m: this.settings.rssiAt1m,
      pathLossExponent: this.settings.pathLossExponent,
      freshMs: Math.max(this.settings.proximityFreshSec, 6) * 1000,
      now: this.now(),
    });
  }

  /** Once a second while live positions are on: send everyone the map dots (testing: all of them). */
  private broadcastPositions() {
    const now = this.now();
    if (now - this.positionsSentAt < 1000) return;
    this.positionsSentAt = now;
    if (!this.settings.livePositions) {
      if (this.lastPositionsSent.size > 0) {
        // Turned off: clear everyone's map once.
        for (const id of this.lastPositionsSent.keys()) this.send(id, { type: "positions", positions: [] });
        this.lastPositionsSent.clear();
      }
      return;
    }
    const positions = this.livePositions();
    const key = JSON.stringify(positions);
    for (const p of this.players.values()) {
      if (p.bot || !p.connected || this.lastPositionsSent.get(p.id) === key) continue;
      this.lastPositionsSent.set(p.id, key);
      this.send(p.id, { type: "positions", positions });
    }
  }

  /**
   * Server-side proximity check: either phone hearing the other above threshold counts. Optimistic about
   * leaving: the strongest reading of the last `proximityFreshSec` counts, so one weak reading (a body or
   * pocket in the way) doesn't drop someone out of range; walking away takes that long to register.
   * Coming into range is still immediate.
   */
  isNear(a: Player, b: Player, threshold: number): boolean {
    if (this.settings.devSkipProximity) return true;
    const fresh = this.settings.proximityFreshSec * 1000;
    const now = this.now();
    return [this.sightings.get(a.id)?.get(b.id), this.sightings.get(b.id)?.get(a.id)].some((s) => {
      if (!s) return false;
      const readings = s.recent ?? [{ rssi: s.rssi, at: s.at }];
      return readings.some((r) => now - r.at <= fresh && r.rssi >= threshold);
    });
  }

  private killTargets(p: Player): Player[] {
    if (this.phase !== "PLAYING" || p.role !== "impostor" || !p.alive) return [];
    return [...this.players.values()].filter(
      (t) => t.alive && t.role !== "impostor" && this.isNear(p, t, this.killRssi),
    );
  }

  private nearbyBodies(p: Player): Player[] {
    if (this.phase !== "PLAYING" || !p.alive) return [];
    return [...this.players.values()].filter(
      (b) => b.body && !b.body.reported && this.isNear(p, b, this.reportRssi),
    );
  }

  // ------------------------------------------------------------ checkpoints & tasks

  private checkpoint(
    p: Player,
    { stationId, method, lat, lng }: { stationId: string; method: CheckpointMethod; lat?: number; lng?: number },
  ) {
    this.requirePhase("PLAYING", "MEETING");
    const station = this.stations.find((s) => s.id === stationId);
    if (!station) throw new GameError("Unknown station");
    if (!["sign", "qr", "gps", "manual"].includes(method)) throw new GameError("Bad checkpoint method");
    if (method === "manual" && !this.settings.devSkipCheckpoint) throw new GameError("Manual check-in disabled");
    if (method === "gps") {
      if (station.lat === undefined || station.lng === undefined) throw new GameError("Station has no GPS location");
      if (typeof lat !== "number" || typeof lng !== "number") throw new GameError("lat/lng required");
      const d = haversineM(lat, lng, station.lat, station.lng);
      if (d > station.radiusM) throw new GameError(`Too far from ${station.name} (${Math.round(d)} m)`);
    }
    p.lastCheckpoint = { stationId, method, at: this.now() };

    if (this.phase === "MEETING" && this.meeting?.stage === "gathering" && this.meetingPoints().includes(station) && p.alive) {
      this.meeting.arrived.add(p.id);
      this.maybeStartDiscussion();
    }
    return { station: station.name };
  }

  private requireAtStation(p: Player, stationId: string) {
    if (this.settings.devSkipCheckpoint) return;
    const cp = p.lastCheckpoint;
    const station = this.stations.find((s) => s.id === stationId);
    if (!cp || cp.stationId !== stationId || this.now() - cp.at > this.settings.checkpointTtlSec * 1000) {
      throw new GameError(`Check in at ${station?.name ?? "the station"} first`);
    }
  }

  private findTask(p: Player, taskId: string): Task {
    const task = p.tasks.find((t) => t.id === taskId);
    if (!task) throw new GameError("Not your task");
    if (task.completed) throw new GameError("Task already completed");
    return task;
  }

  private requireCanDoTasks(p: Player) {
    this.requirePhase("PLAYING");
    if (!p.alive && !this.settings.ghostTasks) throw new GameError("Ghosts can't do tasks");
    if (p.body && !p.body.reported) throw new GameError("You're a body. Stay put until you're found");
  }

  private taskStart(p: Player, { taskId }: { taskId: string }) {
    this.requireCanDoTasks(p);
    const task = this.findTask(p, taskId);
    this.requireAtStation(p, task.steps[task.step]);
    task.startedAt = this.now();
  }

  private taskComplete(p: Player, { taskId }: { taskId: string }) {
    this.requireCanDoTasks(p);
    const task = this.findTask(p, taskId);
    this.requireAtStation(p, task.steps[task.step]);
    const timedSec = task.type === "upload" ? this.settings.uploadSec : task.type === "scan" ? this.settings.scanSec : null;
    if (timedSec !== null && task.step === 0) {
      // Upload and Submit Scan must run on-site for the full duration; small allowance for network latency.
      const needed = timedSec * 1000 - 1500;
      if (task.startedAt === null || this.now() - task.startedAt < needed) {
        throw new GameError(task.type === "scan"
          ? "Scan interrupted. Stand still at the scanner until it finishes"
          : "Upload interrupted. Stay at the station until it finishes");
      }
    }
    task.startedAt = null;
    task.step++;
    if (task.step >= task.steps.length) {
      task.completed = true;
      if (!task.fake) {
        this.emitAll("TASK_COMPLETED", { progress: this.taskProgress() });
        this.checkWin();
      }
    }
  }

  taskProgress() {
    let done = 0;
    let total = 0;
    for (const p of this.players.values()) {
      for (const t of p.tasks) {
        if (t.fake) continue;
        total++;
        if (t.completed) done++;
      }
    }
    return { done, total };
  }

  // ------------------------------------------------------------ kills & bodies

  private kill(p: Player, { targetId, method, qrToken }: { targetId?: string; method?: "ble" | "qr"; qrToken?: string }) {
    this.requirePhase("PLAYING");
    if (p.role !== "impostor") throw new GameError("Only impostors can kill");
    if (!p.alive) throw new GameError("Ghosts can't kill");
    const now = this.now();
    if (now < p.killCooldownUntil) throw new GameError("Kill on cooldown");

    let target: Player | undefined;
    if (method === "qr") {
      if (!this.settings.qrFallback) throw new GameError("QR fallback is disabled");
      target = [...this.players.values()].find((pl) => pl.qrToken === qrToken);
    } else {
      target = targetId ? this.players.get(targetId) : undefined;
      if (target && !this.isNear(p, target, this.killRssi)) {
        throw new GameError("Target not in range");
      }
    }
    if (!target) throw new GameError("Unknown target");
    if (!target.alive) throw new GameError("Target already dead");
    if (target.role === "impostor") throw new GameError("Can't kill an impostor");

    target.alive = false;
    target.body = { reported: false, at: now };
    target.killedBy = p.id;
    p.killCooldownUntil = now + this.settings.killCooldownSec * 1000;

    const impostors = [...this.players.values()].filter((pl) => pl.role === "impostor").map((pl) => pl.id);
    // The killer is named so both kill animations can show them in their own colour.
    this.emit([target.id, ...impostors], "PLAYER_KILLED", { victimId: target.id, killerId: p.id });
    this.checkWin();
  }

  private reportBody(p: Player, { bodyId, method, qrToken }: { bodyId?: string; method?: "ble" | "qr" | "self"; qrToken?: string }) {
    this.requirePhase("PLAYING");
    let body: Player | undefined;
    let reporter: Player | null = p;
    if (method === "self") {
      // REPORT pressed on the body's own phone by whoever found it. Reporter is unknown.
      body = p;
      reporter = null;
    } else {
      if (!p.alive) throw new GameError("Ghosts can't report bodies");
      if (method === "qr") {
        if (!this.settings.qrFallback) throw new GameError("QR fallback is disabled");
        body = [...this.players.values()].find((pl) => pl.qrToken === qrToken);
      } else {
        body = bodyId ? this.players.get(bodyId) : undefined;
        if (body && !this.isNear(p, body, this.reportRssi)) {
          throw new GameError("Body not in range");
        }
      }
    }
    if (!body || !body.body || body.body.reported) throw new GameError("No unreported body there");
    this.startMeeting("body", reporter, body);
  }

  private callEmergency(p: Player) {
    this.requirePhase("PLAYING");
    if (!p.alive) throw new GameError("Ghosts can't call meetings");
    if (p.emergencyUsed >= this.settings.emergencyMeetingsPerPlayer) throw new GameError("No emergency meetings left");
    if (this.sabotage) throw new GameError("Can't call a meeting during a sabotage");
    if (this.now() < this.emergencyAvailableAt) throw new GameError("Emergency button on cooldown");
    const button = this.stations.find((s) => s.kind === "emergency");
    if (!button) throw new GameError("No emergency station on this map");
    if (!this.settings.devSkipCheckpoint) {
      const cp = p.lastCheckpoint;
      const station = cp && this.stations.find((s) => s.id === cp.stationId);
      if (!cp || station?.kind !== "emergency" || this.now() - cp.at > this.settings.checkpointTtlSec * 1000) {
        throw new GameError(`Go to ${button.name} to call a meeting`);
      }
    }
    p.emergencyUsed++;
    this.startMeeting("emergency", p, null);
  }

  // ------------------------------------------------------------ meetings & voting

  private startMeeting(kind: MeetingKind, caller: Player | null, body: Player | null) {
    const now = this.now();
    // Every body still lying around is "found" once a meeting is called.
    for (const pl of this.players.values()) {
      if (!pl.alive) {
        pl.deathKnown = true;
        if (pl.body) pl.body.reported = true;
      }
      pl.vote = undefined;
    }
    if (this.sabotage) {
      this.sabotage = null;
      this.emitAll("SABOTAGE_RESOLVED", { reason: "meeting" });
    }
    this.result = null;
    this.phase = "MEETING";
    this.meeting = {
      kind,
      calledBy: caller?.id ?? null,
      bodyId: body?.id ?? null,
      stage: "gathering",
      arrived: new Set(),
      deadline: now + this.settings.gatherTimeoutSec * 1000,
    };
    this.phaseDeadline = this.meeting.deadline;
    if (kind === "body") {
      this.emitAll("BODY_REPORTED", { bodyId: body?.id, bodyName: body?.name, reporterName: caller?.name ?? null });
    } else {
      this.emitAll("EMERGENCY_MEETING", { callerName: caller?.name });
    }
    this.emitAll("MEETING_STARTED", { kind });
    // Without a meeting point (or red button) there's nothing to gather at.
    if (this.meetingPoints().length === 0) this.startDiscussion();
  }

  private maybeStartDiscussion() {
    if (!this.meeting || this.meeting.stage !== "gathering") return;
    const living = [...this.players.values()].filter((pl) => pl.alive);
    if (living.every((pl) => this.meeting!.arrived.has(pl.id))) this.startDiscussion();
  }

  private startDiscussion() {
    if (!this.meeting) return;
    this.meeting.stage = "discussion";
    this.meeting.deadline = this.now() + this.settings.discussionSec * 1000;
    this.phaseDeadline = this.meeting.deadline;
    this.emitAll("DISCUSSION_STARTED");
  }

  private startVoting() {
    this.phase = "VOTING";
    this.phaseDeadline = this.now() + this.settings.votingSec * 1000;
    this.emitAll("VOTING_STARTED");
  }

  private vote(p: Player, { targetId }: { targetId: string | null }) {
    this.requirePhase("VOTING");
    if (!p.alive) throw new GameError("Ghosts can't vote");
    if (p.vote !== undefined) throw new GameError("Already voted");
    if (targetId !== null) {
      const t = this.players.get(targetId);
      if (!t || !t.alive) throw new GameError("Can only vote for living players");
    }
    p.vote = targetId;
    this.emitAll("VOTE_CAST", { voterId: this.settings.anonymousVotes ? null : p.id });
    if ([...this.players.values()].filter((pl) => pl.alive).every((pl) => pl.vote !== undefined)) this.tally();
  }

  private tally() {
    const counts = new Map<string | null, string[]>();
    for (const pl of this.players.values()) {
      if (!pl.alive || pl.vote === undefined) continue;
      const list = counts.get(pl.vote) ?? [];
      list.push(pl.id);
      counts.set(pl.vote, list);
    }
    const tallies = [...counts.entries()]
      .map(([targetId, voters]) => ({
        targetId,
        count: voters.length,
        voterIds: this.settings.anonymousVotes ? undefined : voters,
      }))
      .sort((a, b) => b.count - a.count);

    const top = tallies[0];
    const tie = tallies.length > 1 && tallies[1].count === top?.count;
    let ejected: Player | null = null;
    if (top && !tie && top.targetId !== null) ejected = this.players.get(top.targetId) ?? null;

    if (ejected) {
      ejected.alive = false;
      ejected.ejected = true;
      ejected.deathKnown = true;
      ejected.body = null;
    }
    this.result = {
      tallies,
      ejectedId: ejected?.id ?? null,
      ejectedWasImpostor: ejected && this.settings.revealRoleOnEject ? ejected.role === "impostor" : null,
      tie,
      impostorsRemaining: this.settings.revealRoleOnEject
        ? [...this.players.values()].filter((pl) => pl.alive && pl.role === "impostor").length
        : null,
    };
    this.phase = "RESULT";
    this.phaseDeadline = this.now() + this.settings.resultSec * 1000;
    this.emitAll("VOTING_RESULT", this.result);
    if (ejected) this.emitAll("PLAYER_EJECTED", { playerId: ejected.id, name: ejected.name });
  }

  private hostAdvance(p: Player) {
    this.requireHost(p);
    this.advance();
  }

  /** Move the current timed phase forward (deadline hit or host override). */
  private advance() {
    switch (this.phase) {
      case "ROLE_REVEAL":
        this.beginPlaying();
        break;
      case "MEETING":
        if (this.meeting?.stage === "gathering") this.startDiscussion();
        else this.startVoting();
        break;
      case "VOTING":
        this.tally();
        break;
      case "RESULT":
        if (!this.checkWin()) this.beginPlaying();
        break;
      default:
        throw new GameError("Nothing to advance");
    }
  }

  // ------------------------------------------------------------ sabotage

  private startSabotage(p: Player, { kind }: { kind: "reactor" | "lights" }) {
    this.requirePhase("PLAYING");
    if (p.role !== "impostor") throw new GameError("Only impostors can sabotage");
    if (this.sabotage) throw new GameError("A sabotage is already active");
    if (this.now() < this.sabotageAvailableAt) throw new GameError("Sabotage on cooldown");
    if (kind === "reactor") {
      if (this.stations.filter((s) => s.kind === "reactor").length < 2) throw new GameError("Map needs two reactor stations");
      this.sabotage = { kind, deadline: this.now() + this.settings.reactorSec * 1000, activations: {} };
    } else if (kind === "lights") {
      if (!this.stations.some((s) => s.kind === "electrical")) throw new GameError("Map needs an electrical station");
      this.sabotage = { kind, deadline: null, activations: {} };
    } else {
      throw new GameError("Unknown sabotage");
    }
    this.emitAll("SABOTAGE_STARTED", { kind });
  }

  private fixSabotage(p: Player, { stationId }: { stationId: string }) {
    this.requirePhase("PLAYING");
    if (!this.sabotage) throw new GameError("Nothing to fix");
    if (!p.alive) throw new GameError("Ghosts can't fix sabotages");
    const station = this.stations.find((s) => s.id === stationId);
    if (!station) throw new GameError("Unknown station");
    this.requireAtStation(p, stationId);
    const now = this.now();
    if (this.sabotage.kind === "reactor") {
      if (station.kind !== "reactor") throw new GameError("That's not a reactor station");
      this.sabotage.activations[stationId] = now;
      const window = this.settings.reactorWindowSec * 1000;
      const reactors = this.stations.filter((s) => s.kind === "reactor");
      if (reactors.every((r) => now - (this.sabotage!.activations[r.id] ?? -Infinity) <= window)) this.resolveSabotage();
    } else {
      if (station.kind !== "electrical") throw new GameError("Fix the lights at Electrical");
      this.resolveSabotage();
    }
  }

  private resolveSabotage() {
    this.sabotage = null;
    this.sabotageAvailableAt = this.now() + this.settings.sabotageCooldownSec * 1000;
    this.emitAll("SABOTAGE_RESOLVED", { reason: "fixed" });
  }

  // ------------------------------------------------------------ win / restart

  /** Returns true if the game ended. */
  private checkWin(): boolean {
    if (this.phase === "GAME_OVER" || this.phase === "LOBBY") return false;
    const living = [...this.players.values()].filter((pl) => pl.alive);
    const imps = living.filter((pl) => pl.role === "impostor").length;
    const crew = living.length - imps;
    const progress = this.taskProgress();
    if (imps === 0) return this.endGame("crewmates", "All impostors were ejected");
    if (progress.total > 0 && progress.done >= progress.total) return this.endGame("crewmates", "All tasks completed");
    // A two-player game starts at 1:1, so parity only wins once someone is eliminated.
    const bothTwoPlayerParticipantsAlive = this.players.size === 2 && living.length === 2;
    const impostorWin = this.settings.demoContinueAtParity ? crew === 0 : imps >= crew;
    if (impostorWin && !bothTwoPlayerParticipantsAlive) {
      return this.endGame("impostors", this.settings.demoContinueAtParity
        ? "No living crewmates remain" : "Impostors outnumber the crew");
    }
    return false;
  }

  private endGame(winner: Winner, reason: string): boolean {
    this.phase = "GAME_OVER";
    this.phaseDeadline = null;
    this.winner = winner;
    this.winReason = reason;
    this.sabotage = null;
    this.meeting = null;
    this.emitAll(winner === "crewmates" ? "CREWMATES_WIN" : "IMPOSTORS_WIN", { reason });
    this.hooks.onGameOver?.({
      code: this.code,
      mapId: this.mapId,
      startedAt: this.startedAt,
      endedAt: this.now(),
      winner,
      winReason: reason,
      players: [...this.players.values()].map((p) => ({ name: p.name, role: p.role, alive: p.alive, ejected: p.ejected })),
    });
    return true;
  }

  private restart(p: Player) {
    this.requireHost(p);
    this.phase = "LOBBY";
    this.phaseDeadline = null;
    this.meeting = null;
    this.result = null;
    this.sabotage = null;
    this.winner = null;
    this.winReason = null;
    this.sightings.clear();
    for (const pl of this.players.values()) {
      pl.role = null;
      pl.alive = true;
      pl.deathKnown = false;
      pl.ejected = false;
      pl.body = null;
      pl.tasks = [];
      pl.vote = undefined;
      pl.lastCheckpoint = null;
    }
    this.emitAll("RESTARTED");
  }

  // ------------------------------------------------------------ timers

  /** Called periodically by the server. Handles deadlines and re-sends derived state (e.g. proximity). */
  tick() {
    const now = this.now();
    const before = this.phase + this.phaseDeadline;
    this.runBots();
    if (this.sabotage?.kind === "reactor" && now >= this.sabotage.deadline && this.phase === "PLAYING") {
      this.endGame("impostors", "Reactor meltdown");
    } else if (this.phaseDeadline !== null && now >= this.phaseDeadline) {
      this.advance();
    }
    this.pruneCams();
    this.broadcast();
    this.broadcastPositions();
    if (this.phase + this.phaseDeadline !== before) this.hooks.onChange?.();
  }

  // ------------------------------------------------------------ persistence

  toSnapshot(): GameSnapshot {
    return {
      v: 1,
      code: this.code,
      mapId: this.mapId,
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      stations: this.stations,
      players: [...this.players.values()],
      meeting: this.meeting ? { ...this.meeting, arrived: [...this.meeting.arrived] } : null,
      phaseDeadline: this.phaseDeadline,
      result: this.result,
      sabotage: this.sabotage,
      sabotageAvailableAt: this.sabotageAvailableAt,
      emergencyAvailableAt: this.emergencyAvailableAt,
      winner: this.winner,
      winReason: this.winReason,
      startedAt: this.startedAt,
      lastActivity: this.lastActivity,
      gameset: this.gameset,
      stationsBeforeGameset: this.stationsBeforeGameset,
      signsBeforeGameset: this.signsBeforeGameset,
    };
  }

  static fromSnapshot(snap: GameSnapshot, send: Send, hooks: GameHooks = {}, now: () => number = Date.now): Game {
    const g = new Game(snap.code, snap.mapId, snap.stations, send, hooks, now);
    g.phase = snap.phase;
    g.hostId = snap.hostId;
    // Snapshots from older versions: drop settings that no longer exist, default the new ones.
    const known = Object.fromEntries(Object.entries(snap.settings).filter(([k]) => k in DEFAULT_SETTINGS));
    g.settings = { ...DEFAULT_SETTINGS, ...known };
    // Nobody is connected until their phone reconnects with its stored token. Older snapshots did
    // not contain colors, so assign any missing/invalid/duplicate value before restoring the player.
    const usedColors = new Set<PlayerColor>();
    for (const p of snap.players) {
      const savedColor = (p as Player & { color?: unknown }).color;
      const color = typeof savedColor === "string"
        && PLAYER_COLORS.includes(savedColor as PlayerColor)
        && !usedColors.has(savedColor as PlayerColor)
        ? savedColor as PlayerColor
        : g.nextPlayerColor(usedColors);
      usedColors.add(color);
      g.players.set(p.id, { ...p, color, connected: !!p.bot });
    }
    g.meeting = snap.meeting ? { ...snap.meeting, arrived: new Set(snap.meeting.arrived) } : null;
    g.phaseDeadline = snap.phaseDeadline;
    g.result = snap.result;
    g.sabotage = snap.sabotage;
    g.sabotageAvailableAt = snap.sabotageAvailableAt;
    g.emergencyAvailableAt = snap.emergencyAvailableAt;
    g.winner = snap.winner;
    g.winReason = snap.winReason;
    g.startedAt = snap.startedAt;
    g.lastActivity = snap.lastActivity;
    g.gameset = snap.gameset ?? null;
    g.stationsBeforeGameset = snap.stationsBeforeGameset ?? null;
    g.signsBeforeGameset = snap.signsBeforeGameset ?? null;
    return g;
  }

  private touch() {
    this.lastActivity = this.now();
  }

  // ------------------------------------------------------------ views

  private emit(playerIds: string[], event: string, data?: unknown) {
    for (const id of new Set(playerIds)) this.send(id, { type: "event", event, data });
  }

  private emitAll(event: string, data?: unknown) {
    this.emit([...this.players.keys()], event, data);
  }

  /** Send each player their own redacted snapshot, skipping anyone whose view didn't change. */
  broadcast() {
    for (const p of this.players.values()) {
      const view = this.viewFor(p.id);
      const { serverTime: _t, ...comparable } = view;
      const key = JSON.stringify(comparable);
      if (this.lastSent.get(p.id) === key) continue;
      this.lastSent.set(p.id, key);
      this.send(p.id, { type: "state", state: view });
    }
  }

  /**
   * The only thing a client ever learns about the game. Hidden information (other roles, who is dead,
   * where bodies are, who completed what) is stripped here.
   */
  viewFor(viewerId: string): StateView {
    const me = this.players.get(viewerId)!;
    const over = this.phase === "GAME_OVER";
    const ghost = !me.alive;
    const now = this.now();

    const players: PlayerView[] = [...this.players.values()].map((pl) => {
      const self = pl.id === me.id;
      const fellowImpostor = me.role === "impostor" && pl.role === "impostor";
      const ejectReveal = pl.ejected && this.settings.revealRoleOnEject;
      // Impostors know who they killed; ghosts see all deaths; everyone else learns at meetings.
      const knowsDeath = self || over || ghost || pl.deathKnown || (me.role === "impostor" && pl.killedBy !== null);
      return {
        id: pl.id,
        name: pl.name,
        color: pl.color,
        faceId: pl.faceId ?? null,
        isHost: pl.id === this.hostId,
        isBot: !!pl.bot,
        connected: pl.connected,
        alive: knowsDeath ? pl.alive : true,
        ejected: pl.ejected,
        role: self || fellowImpostor || over || ejectReveal ? pl.role : null,
        hasVoted: this.phase === "VOTING" ? pl.vote !== undefined : false,
      };
    });

    const sab = this.sabotage;
    const fixStations = sab
      ? this.stations.filter((s) => (sab.kind === "reactor" ? s.kind === "reactor" : s.kind === "electrical"))
      : [];

    return {
      serverTime: now,
      code: this.code,
      mapId: this.mapId,
      phase: this.phase,
      phaseDeadline: this.phaseDeadline,
      hostId: this.hostId,
      settings: me.id === this.hostId ? this.settings : { ...this.settings, forcedImpostorIds: [] },
      stations: this.stations,
      players,
      taskProgress: this.taskProgress(),
      me: {
        id: me.id,
        name: me.name,
        role: me.role,
        alive: me.alive,
        isBody: !!me.body && !me.body.reported,
        ackedRole: me.ackedRole,
        bleToken: me.bleToken,
        qrToken: me.qrToken,
        tasks: me.tasks.map(({ id, type, steps, step, completed, startedAt }) => ({ id, type, steps, step, completed, startedAt })),
        lastCheckpoint: me.lastCheckpoint,
        emergencyLeft: Math.max(0, this.settings.emergencyMeetingsPerPlayer - me.emergencyUsed),
        hasVoted: me.vote !== undefined,
        voteTarget: me.vote ?? null,
        killCooldownUntil: me.role === "impostor" ? me.killCooldownUntil : null,
        killTargets: this.killTargets(me).map((t) => t.id),
        // Only about yourself: who killed you, for your kill animation after a reconnect.
        killedBy: me.killedBy,
        nearbyBodies: this.nearbyBodies(me).map((b) => b.id),
        sabotageAvailableAt: me.role === "impostor" ? this.sabotageAvailableAt : null,
        canWatchCams: this.canWatchCams(me),
        // Someone else is watching the cameras: send your front-camera frames.
        camWanted: this.phase === "PLAYING" && !me.bot && [...this.camWatchers].some((id) => id !== me.id),
      },
      emergencyAvailableAt: this.emergencyAvailableAt,
      meeting: this.meeting
        ? {
            kind: this.meeting.kind,
            calledBy: this.meeting.calledBy,
            bodyId: this.meeting.bodyId,
            stage: this.meeting.stage,
            arrived: [...this.meeting.arrived],
          }
        : null,
      result: this.result
        ? {
            ...this.result,
            ejectedRole:
              this.result.ejectedId && this.settings.revealRoleOnEject
                ? (this.players.get(this.result.ejectedId)?.role ?? null)
                : null,
          }
        : null,
      sabotage: sab
        ? {
            kind: sab.kind,
            deadline: sab.deadline,
            stations: fixStations.map((s) => ({
              stationId: s.id,
              active:
                sab.kind === "reactor" && now - (sab.activations[s.id] ?? -Infinity) <= this.settings.reactorWindowSec * 1000,
            })),
          }
        : null,
      winner: this.winner,
      winReason: this.winReason,
      gameset: this.gameset,
      signQuotas: this.phase === "LOBBY" ? this.signQuotas() : {},
    };
  }
}

export interface PlayerView {
  id: string;
  name: string;
  color: PlayerColor;
  faceId: string | null;
  isHost: boolean;
  isBot: boolean;
  connected: boolean;
  alive: boolean;
  ejected: boolean;
  role: string | null;
  hasVoted: boolean;
}

export interface StateView {
  serverTime: number;
  code: string;
  mapId: string;
  phase: Phase;
  phaseDeadline: number | null;
  hostId: string;
  settings: Settings;
  stations: Station[];
  players: PlayerView[];
  taskProgress: { done: number; total: number };
  me: {
    id: string;
    name: string;
    role: string | null;
    alive: boolean;
    isBody: boolean;
    ackedRole: boolean;
    bleToken: string;
    qrToken: string;
    tasks: Omit<Task, "fake">[];
    lastCheckpoint: Player["lastCheckpoint"];
    emergencyLeft: number;
    hasVoted: boolean;
    voteTarget: string | null;
    killCooldownUntil: number | null;
    killTargets: string[];
    killedBy: string | null;
    nearbyBodies: string[];
    sabotageAvailableAt: number | null;
    canWatchCams: boolean;
    camWanted: boolean;
  };
  emergencyAvailableAt: number;
  meeting: { kind: MeetingKind; calledBy: string | null; bodyId: string | null; stage: string; arrived: string[] } | null;
  result: (VoteResult & { ejectedRole: string | null }) | null;
  sabotage: { kind: string; deadline: number | null; stations: { stationId: string; active: boolean }[] } | null;
  winner: Winner | null;
  winReason: string | null;
  gameset: { id: string; name: string } | null;
  /** Lobby: how many signs each non-bot player must add (their share when a saved game supplies some). */
  signQuotas: Record<string, number>;
}
