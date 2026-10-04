import { gzipSync } from "node:zlib";

/**
 * The SFU Burnaby campus floor plans, from SFU's public RoomFinder map service (the same ArcGIS layer
 * SFU's room finder uses). Fetched once, compacted (rooms grouped by building and floor, coordinates
 * rounded to ~10 cm) and cached in memory; phones download it once and keep a copy.
 */

const SERVICE =
  "https://viewsfu-prd.its.sfu.ca/fsgis/rest/services/RoomFinder/RoomFinder2024_RoomSearch/MapServer/0";
const FIELDS = "bl_abbr,bl_name,fl_id,fl_name,rm_id,rm_type,rm_name";
const PAGE = 1000;
const REFRESH_MS = 7 * 24 * 3600_000;

export interface CampusRoom {
  id: string;
  name: string;
  type: string;
  /** Outer rings, [lng, lat] pairs. */
  rings: number[][][];
}

export interface CampusFloor {
  id: string;
  name: string;
  /** Sort key within the building: lower floors first. */
  order: number;
  rooms: CampusRoom[];
}

export interface CampusBuilding {
  id: string;
  name: string;
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: number[];
  floors: CampusFloor[];
}

export interface CampusBundle {
  version: string;
  fetchedAt: number;
  source: string;
  buildings: CampusBuilding[];
}

interface Feature {
  properties: Record<string, string | null>;
  geometry: { type: string; coordinates: any } | null;
}

/** Floor ids vary by building ("2000", "01", "P1", "MEZ"); this orders them bottom to top. */
export function floorOrder(id: string, siblings: string[]): number {
  const parkade = /^P(\d+)$/i.exec(id);
  if (parkade) return -Number(parkade[1]);
  if (/^MEZ/i.test(id)) {
    // Between the first two above-ground floors.
    const levels = siblings.map((s) => /^\d+/.exec(s)).filter(Boolean).map((m) => Number(m![0])).filter((n) => n > 0).sort((a, b) => a - b);
    return levels.length >= 2 ? (levels[0] + levels[1]) / 2 : (levels[0] ?? 0) + 0.5;
  }
  const digits = /^\d+/.exec(id);
  const letter = /[A-Z]$/i.exec(id);
  return (digits ? Number(digits[0]) : 0) + (letter ? (letter[0].toUpperCase().charCodeAt(0) - 64) * 0.01 : 0);
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function outerRings(geometry: Feature["geometry"]): number[][][] {
  if (!geometry) return [];
  const polygons: number[][][][] =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons
    .map((poly) => {
      const ring: number[][] = [];
      for (const [lng, lat] of poly[0] ?? []) {
        const p = [round(lng), round(lat)];
        const last = ring[ring.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) ring.push(p);
      }
      return ring;
    })
    .filter((ring) => ring.length >= 3);
}

/** Groups SFU room features into buildings and floors. Pure, for tests. */
export function buildCampusBundle(features: Feature[], fetchedAt: number): CampusBundle {
  const buildings = new Map<string, { name: string; floors: Map<string, { name: string; rooms: CampusRoom[] }> }>();
  for (const f of features) {
    const p = f.properties ?? {};
    const bl = p.bl_abbr?.trim();
    const fl = p.fl_id?.trim();
    const rings = outerRings(f.geometry);
    if (!bl || !fl || rings.length === 0) continue;
    let building = buildings.get(bl);
    if (!building) buildings.set(bl, (building = { name: p.bl_name?.trim() || bl, floors: new Map() }));
    let floor = building.floors.get(fl);
    if (!floor) building.floors.set(fl, (floor = { name: p.fl_name?.trim() || fl, rooms: [] }));
    const roomId = p.rm_id?.trim() ?? "";
    floor.rooms.push({
      id: roomId,
      name: p.rm_name?.trim() || `${bl} ${roomId}`.trim(),
      type: p.rm_type?.trim() || "",
      rings,
    });
  }
  const out: CampusBuilding[] = [...buildings].map(([id, b]) => {
    const ids = [...b.floors.keys()];
    let bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const floors = [...b.floors].map(([fid, f]) => {
      for (const room of f.rooms) {
        for (const ring of room.rings) {
          for (const [lng, lat] of ring) {
            bbox = [Math.min(bbox[0], lng), Math.min(bbox[1], lat), Math.max(bbox[2], lng), Math.max(bbox[3], lat)];
          }
        }
      }
      return { id: fid, name: f.name, order: floorOrder(fid, ids), rooms: f.rooms };
    });
    floors.sort((a, b) => a.order - b.order);
    return { id, name: b.name, bbox, floors };
  });
  out.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: `${fetchedAt}`,
    fetchedAt,
    source: "Simon Fraser University RoomFinder (ArcGIS)",
    buildings: out,
  };
}

async function fetchAllRooms(): Promise<Feature[]> {
  const features: Feature[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = new URL(`${SERVICE}/query`);
    for (const [k, v] of Object.entries({
      where: "campus='Burnaby'",
      outFields: FIELDS,
      returnGeometry: "true",
      outSR: "4326",
      geometryPrecision: "6",
      orderByFields: "OBJECTID",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      f: "geojson",
    })) url.searchParams.set(k, v);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`SFU map service returned ${res.status}`);
    const page = (await res.json()) as { features?: Feature[]; error?: { message?: string } };
    if (page.error) throw new Error(`SFU map service: ${page.error.message ?? "error"}`);
    const batch = page.features ?? [];
    features.push(...batch);
    if (batch.length < PAGE) return features;
  }
}

/** The campus bundle, fetched on first use and refreshed weekly. A failed refresh keeps the old copy. */
export class CampusCache {
  private bundle: { json: string; gzip: Buffer; version: string; at: number } | null = null;
  private loading: Promise<void> | null = null;

  constructor(private fetchRooms: () => Promise<Feature[]> = fetchAllRooms, private now: () => number = Date.now) {}

  async get() {
    if (!this.bundle || this.now() - this.bundle.at > REFRESH_MS) {
      const refresh = (this.loading ??= this.load().finally(() => (this.loading = null)));
      // Serve the old copy while refreshing; only the very first load has to wait.
      if (!this.bundle) await refresh;
    }
    if (!this.bundle) throw new Error("Campus map unavailable");
    return this.bundle;
  }

  private async load() {
    try {
      const bundle = buildCampusBundle(await this.fetchRooms(), this.now());
      const json = JSON.stringify(bundle);
      this.bundle = { json, gzip: gzipSync(json), version: bundle.version, at: this.now() };
      console.log(`Campus map: ${bundle.buildings.length} buildings, ${Math.round(json.length / 1024)} KB`);
    } catch (err) {
      console.error("Campus map fetch failed:", (err as Error).message);
    }
  }
}
