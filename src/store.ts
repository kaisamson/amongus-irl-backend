import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Station } from "./types.ts";

/**
 * Venue maps (stations + sign photos) persist to disk so the host only has to walk
 * the venue and photograph signage once. Active games themselves live in memory.
 */
export class MapStore {
  private mapsDir: string;
  private photosDir: string;

  constructor(dataDir: string) {
    this.mapsDir = join(dataDir, "maps");
    this.photosDir = join(dataDir, "photos");
    mkdirSync(this.mapsDir, { recursive: true });
    mkdirSync(this.photosDir, { recursive: true });
  }

  private safe(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error("Bad id");
    return id;
  }

  loadStations(mapId: string): Station[] {
    const file = join(this.mapsDir, `${this.safe(mapId)}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).stations : [];
  }

  saveStations(mapId: string, stations: Station[]) {
    writeFileSync(join(this.mapsDir, `${this.safe(mapId)}.json`), JSON.stringify({ stations }, null, 2));
  }

  savePhoto(jpegBase64: string): string {
    const id = randomBytes(8).toString("hex");
    writeFileSync(join(this.photosDir, `${id}.jpg`), Buffer.from(jpegBase64, "base64"));
    return id;
  }

  photoPath(id: string): string | null {
    const file = join(this.photosDir, `${this.safe(id)}.jpg`);
    return existsSync(file) ? file : null;
  }
}
