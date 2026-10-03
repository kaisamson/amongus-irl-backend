import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import type { GameSnapshot, GameSummary } from "./game.ts";
import type { Station } from "./types.ts";

/**
 * What the game server persists. Live gameplay runs in memory; the store holds:
 *  - venue maps (stations) and sign reference photos, so a venue is set up once
 *  - snapshots of live games, so a restart/redeploy restores games instead of ending them
 *  - finished-game history
 */
export interface Store {
  readonly kind: string;
  init(): Promise<void>;
  loadStations(mapId: string): Promise<Station[]>;
  saveStations(mapId: string, stations: Station[]): Promise<void>;
  savePhoto(jpeg: Buffer): Promise<string>;
  getPhoto(photoId: string): Promise<Buffer | null>;
  saveGame(snapshot: GameSnapshot, ttlSec: number): Promise<void>;
  deleteGame(code: string): Promise<void>;
  loadGame(code: string): Promise<GameSnapshot | null>;
  recordGame(summary: GameSummary): Promise<void>;
  close(): Promise<void>;
}

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function checkId(id: string) {
  if (!ID_PATTERN.test(id)) throw new Error("Bad id");
  return id;
}

function newPhotoId() {
  return randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------- Redis

/**
 * Key layout:
 *   map:<mapId>      JSON { stations }         (no TTL)
 *   photo:<id>       JPEG bytes                (no TTL)
 *   game:<CODE>      JSON GameSnapshot         (TTL; refreshed on every change)
 *   history          list of JSON GameSummary  (newest first, capped)
 *
 * Maps and photos must never be evicted. Run Redis with maxmemory-policy noeviction and persistence on.
 */
export class RedisStore implements Store {
  readonly kind = "redis";
  private redis: Redis;

  /** Pass a URL (rediss:// for TLS) or an existing client (tests). */
  constructor(urlOrClient: string | Redis) {
    this.redis =
      typeof urlOrClient === "string"
        ? // Connects immediately and keeps reconnecting (ioredis default retry strategy) if Redis goes away.
          new Redis(urlOrClient, { maxRetriesPerRequest: 3 })
        : urlOrClient;
    this.redis.on("error", (err: Error) => console.error("Redis error:", err.message));
  }

  /**
   * Waits for Redis to answer. On Render the Key Value instance can still be starting when the
   * web service boots, so retry for a while instead of crashing on the first refused connection.
   */
  async init(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.redis.ping();
        return;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        console.log(`Waiting for Redis: ${(err as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async loadStations(mapId: string): Promise<Station[]> {
    const raw = await this.redis.get(`map:${checkId(mapId)}`);
    return raw ? JSON.parse(raw).stations : [];
  }

  async saveStations(mapId: string, stations: Station[]) {
    await this.redis.set(`map:${checkId(mapId)}`, JSON.stringify({ stations }));
  }

  async savePhoto(jpeg: Buffer) {
    const id = newPhotoId();
    await this.redis.set(`photo:${id}`, jpeg);
    return id;
  }

  async getPhoto(photoId: string) {
    return this.redis.getBuffer(`photo:${checkId(photoId)}`);
  }

  async saveGame(snapshot: GameSnapshot, ttlSec: number) {
    await this.redis.set(`game:${snapshot.code}`, JSON.stringify(snapshot), "EX", ttlSec);
  }

  async deleteGame(code: string) {
    await this.redis.del(`game:${code}`);
  }

  async loadGame(code: string): Promise<GameSnapshot | null> {
    const raw = await this.redis.get(`game:${checkId(code)}`);
    return raw ? JSON.parse(raw) : null;
  }

  async recordGame(summary: GameSummary) {
    await this.redis.multi().lpush("history", JSON.stringify(summary)).ltrim("history", 0, 999).exec();
  }

  async close() {
    await this.redis.quit();
  }
}

// ---------------------------------------------------------------- local files (dev without Redis)

export class FileStore implements Store {
  readonly kind = "files";
  private mapsDir: string;
  private photosDir: string;
  private gamesDir: string;
  private historyFile: string;

  constructor(dataDir: string) {
    this.mapsDir = join(dataDir, "maps");
    this.photosDir = join(dataDir, "photos");
    this.gamesDir = join(dataDir, "games");
    this.historyFile = join(dataDir, "history.jsonl");
  }

  async init() {
    for (const dir of [this.mapsDir, this.photosDir, this.gamesDir]) mkdirSync(dir, { recursive: true });
  }

  async loadStations(mapId: string) {
    const file = join(this.mapsDir, `${checkId(mapId)}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).stations : [];
  }

  async saveStations(mapId: string, stations: Station[]) {
    writeFileSync(join(this.mapsDir, `${checkId(mapId)}.json`), JSON.stringify({ stations }, null, 2));
  }

  async savePhoto(jpeg: Buffer) {
    const id = newPhotoId();
    writeFileSync(join(this.photosDir, `${id}.jpg`), jpeg);
    return id;
  }

  async getPhoto(photoId: string) {
    const file = join(this.photosDir, `${checkId(photoId)}.jpg`);
    return existsSync(file) ? readFileSync(file) : null;
  }

  async saveGame(snapshot: GameSnapshot) {
    writeFileSync(join(this.gamesDir, `${checkId(snapshot.code)}.json`), JSON.stringify(snapshot));
  }

  async deleteGame(code: string) {
    rmSync(join(this.gamesDir, `${checkId(code)}.json`), { force: true });
  }

  async loadGame(code: string) {
    const file = join(this.gamesDir, `${checkId(code)}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }

  async recordGame(summary: GameSummary) {
    writeFileSync(this.historyFile, JSON.stringify(summary) + "\n", { flag: "a" });
  }

  async close() {}
}
