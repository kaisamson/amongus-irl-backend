import { GameError, type Player, type Sighting, type Station } from "./types.ts";

/**
 * Live player positions, phones only (no beacons).
 *
 * Each phone runs its own filter (sign scans as exact fixes, steps + compass between them,
 * accuracy-weighted GPS, the floor plan) and reports an estimate with a 1-sigma radius. The server
 * adds what only it can see: which players are close to each other over BLE. A player with a poor
 * fix standing next to someone with a good one gets pulled toward them. It also treats a fresh sign
 * check-in as an exact fix, in case the phone hasn't reported since.
 */

export interface PositionReport {
  lat: number;
  lng: number;
  /** The phone's 1-sigma uncertainty radius, meters. */
  accuracyM: number;
  /** Server time the report arrived. */
  at: number;
  roomId: string | null;
  room: string | null;
  /** SFU building and floor the phone thinks it's on (campus map), when known. */
  buildingId: string | null;
  floorId: string | null;
  /** Floors up (+) or down (-) from the last sign the phone fixed on, from the barometer. */
  levelDelta: number;
  /** What fed the estimate, e.g. ["sign", "steps", "gps"]. */
  sources: string[];
}

export interface PlayerPosition {
  playerId: string;
  lat: number;
  lng: number;
  accuracyM: number;
  /** Newest input behind this estimate. */
  at: number;
  roomId: string | null;
  room: string | null;
  buildingId: string | null;
  floorId: string | null;
  levelDelta: number;
  sources: string[];
  /** No fresh input for a while: the radius has grown and the dot should look faded. */
  stale: boolean;
}

/** Walking pace used to grow uncertainty while we hear nothing. */
const WALK_MPS = 1.3;
/** A sign check-in pins the player to within a few meters of the sign. */
const SIGN_FIX_M = 4;
/** BLE neighbors further apart than this say too little to help. */
const MAX_NEIGHBOR_M = 6;
const STALE_MS = 20_000;
const DROP_MS = 180_000;
const MAX_ACCURACY_M = 250;

const M_PER_DEG = 111_320;

/** Local flat-earth offsets in meters (fine across a building). */
function toMeters(lat0: number, lng0: number, lat: number, lng: number) {
  return { x: (lng - lng0) * Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG, y: (lat - lat0) * M_PER_DEG };
}

function fromMeters(lat0: number, lng0: number, x: number, y: number) {
  return { lat: lat0 + y / M_PER_DEG, lng: lng0 + x / (Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG) };
}

export function distanceForRssi(rssi: number, rssiAt1m: number, pathLossExponent: number): number {
  return 10 ** ((rssiAt1m - rssi) / (10 * pathLossExponent));
}

/** Validates a phone's report. Throws a message on bad input. */
export function parseReport(payload: any, now: number): PositionReport {
  const { lat, lng, accuracyM } = payload ?? {};
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!finite(lat) || !finite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new GameError("lat/lng required");
  if (!finite(accuracyM) || accuracyM <= 0) throw new GameError("accuracyM required");
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return {
    lat,
    lng,
    accuracyM: Math.min(Math.max(accuracyM, 1), MAX_ACCURACY_M),
    at: now,
    roomId: text(payload.roomId, 32),
    room: text(payload.room, 60),
    buildingId: text(payload.buildingId, 12),
    floorId: text(payload.floorId, 12),
    levelDelta: finite(payload.levelDelta) ? Math.max(-9, Math.min(9, Math.round(payload.levelDelta))) : 0,
    sources: Array.isArray(payload.sources)
      ? payload.sources.filter((s: unknown) => typeof s === "string").slice(0, 8).map((s: string) => s.slice(0, 16))
      : [],
  };
}

interface Base extends PlayerPosition {
  variance: number;
}

export interface FuseInput {
  players: Player[];
  stations: Station[];
  reports: Map<string, PositionReport>;
  /** observerId -> subjectId -> latest sighting */
  sightings: Map<string, Map<string, Sighting>>;
  rssiAt1m: number;
  pathLossExponent: number;
  /** How old a BLE sighting can be and still count. */
  freshMs: number;
  now: number;
}

/** Everyone's best current estimate. Players we know nothing about are left out. */
export function fusePositions(input: FuseInput): PlayerPosition[] {
  const { players, stations, reports, sightings, now } = input;
  const bases = new Map<string, Base>();

  for (const p of players) {
    const report = reports.get(p.id);
    const cp = p.lastCheckpoint;
    const signFix = cp && cp.method !== "manual" ? stations.find((s) => s.id === cp.stationId) : undefined;
    let base: Base | null = null;

    if (report && now - report.at < DROP_MS) {
      const age = (now - report.at) / 1000;
      base = { playerId: p.id, ...report, variance: report.accuracyM ** 2 + (WALK_MPS * age) ** 2, stale: false };
    }
    // A check-in newer than the phone's last report: the phone hasn't caught up, but we know where they were.
    if (cp && signFix?.lat !== undefined && signFix.lng !== undefined && cp.at > (report?.at ?? 0) && now - cp.at < DROP_MS) {
      const age = (now - cp.at) / 1000;
      const variance = SIGN_FIX_M ** 2 + (WALK_MPS * age) ** 2;
      if (!base || variance < base.variance) {
        base = {
          playerId: p.id,
          lat: signFix.lat,
          lng: signFix.lng,
          accuracyM: Math.sqrt(variance),
          at: cp.at,
          roomId: null,
          room: null,
          buildingId: signFix.buildingId ?? null,
          floorId: signFix.floorId ?? null,
          levelDelta: 0,
          sources: ["sign"],
          variance,
          stale: false,
        };
      }
    }
    if (base) bases.set(p.id, base);
  }

  // BLE neighbors. Each player is only corrected using others' own (pre-correction) estimates,
  // so two phones can't talk each other into false confidence.
  const out: PlayerPosition[] = [];
  for (const p of players) {
    let est = bases.get(p.id) ? { ...bases.get(p.id)! } : null;
    for (const other of players) {
      if (other.id === p.id) continue;
      const anchor = bases.get(other.id);
      if (!anchor) continue;
      const rssi = strongestFresh(sightings, p.id, other.id, input.freshMs, now);
      if (rssi === null) continue;
      const d = distanceForRssi(rssi, input.rssiAt1m, input.pathLossExponent);
      if (d > MAX_NEIGHBOR_M) continue;
      // "Within about d of them": their uncertainty, plus the distance and how unsure BLE is about it.
      const measVar = anchor.variance + d ** 2 + (0.5 * d + 1) ** 2;
      if (!est) {
        // Standing next to them: same building and floor too.
        est = { ...anchor, playerId: p.id, variance: measVar, roomId: null, room: null, levelDelta: 0, sources: ["nearby"] };
        continue;
      }
      if (measVar >= est.variance) continue; // only someone better placed helps
      const k = est.variance / (est.variance + measVar);
      const off = toMeters(est.lat, est.lng, anchor.lat, anchor.lng);
      const moved = Math.hypot(off.x, off.y) * k;
      const next = fromMeters(est.lat, est.lng, off.x * k, off.y * k);
      est.lat = next.lat;
      est.lng = next.lng;
      est.variance = (1 - k) * est.variance;
      est.at = Math.max(est.at, anchor.at);
      if (!est.sources.includes("nearby")) est.sources = [...est.sources, "nearby"];
      if (moved > 5) {
        est.roomId = null;
        est.room = null;
      }
    }
    if (!est) continue;
    const { variance, ...rest } = est;
    out.push({
      ...rest,
      accuracyM: Math.round(Math.min(Math.sqrt(variance), MAX_ACCURACY_M) * 10) / 10,
      stale: now - est.at > STALE_MS,
    });
  }
  return out;
}

function strongestFresh(
  sightings: Map<string, Map<string, Sighting>>,
  a: string,
  b: string,
  freshMs: number,
  now: number,
): number | null {
  let best: number | null = null;
  for (const s of [sightings.get(a)?.get(b), sightings.get(b)?.get(a)]) {
    if (s && now - s.at <= freshMs && (best === null || s.rssi > best)) best = s.rssi;
  }
  return best;
}

/** Test bots wander between the venue's GPS-tagged signs so the live map has something on it. */
export class BotWalker {
  private walks = new Map<string, { lat: number; lng: number; target: number; at: number }>();

  positions(bots: Player[], stations: Station[], now: number): Map<string, PositionReport> {
    const spots = stations.filter((s) => s.lat !== undefined && s.lng !== undefined);
    const out = new Map<string, PositionReport>();
    if (spots.length === 0) return out;
    for (const bot of bots) {
      let w = this.walks.get(bot.id);
      if (!w) {
        const start = spots[Math.floor(Math.random() * spots.length)];
        w = { lat: start.lat!, lng: start.lng!, target: Math.floor(Math.random() * spots.length), at: now };
        this.walks.set(bot.id, w);
      }
      const target = spots[w.target % spots.length];
      const off = toMeters(w.lat, w.lng, target.lat!, target.lng!);
      const dist = Math.hypot(off.x, off.y);
      const step = Math.min(dist, (0.9 * (now - w.at)) / 1000);
      if (dist < 1) {
        w.target = Math.floor(Math.random() * spots.length);
      } else {
        const next = fromMeters(w.lat, w.lng, (off.x / dist) * step, (off.y / dist) * step);
        w.lat = next.lat;
        w.lng = next.lng;
      }
      w.at = now;
      out.set(bot.id, {
        lat: w.lat,
        lng: w.lng,
        accuracyM: 6,
        at: now,
        roomId: null,
        room: null,
        buildingId: target.buildingId ?? null,
        floorId: target.floorId ?? null,
        levelDelta: 0,
        sources: ["bot"],
      });
    }
    return out;
  }
}
