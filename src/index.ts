import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { buildStation, Game, type GameSnapshot, type Outbound } from "./game.ts";
import { FileStore, RedisStore, type Store } from "./store.ts";
import { GameError, type Gameset, type Station } from "./types.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const GAME_TTL_MS = 6 * 60 * 60 * 1000;
/** Shared password for creating and editing saved games until there are accounts. */
const GAMESET_PASSWORD = process.env.GAMESET_PASSWORD ?? "kaimartin";

function taskSigns(stations: Station[]) {
  return stations.filter((s) => s.kind === "task").length;
}
const SAVE_DEBOUNCE_MS = 250;

// REDIS_URL set (Render Key Value / Upstash) -> Redis. Otherwise local files, for development.
const store: Store = process.env.REDIS_URL ? new RedisStore(process.env.REDIS_URL) : new FileStore(DATA_DIR);
const games = new Map<string, Game>();
/** code -> playerId -> socket */
const sockets = new Map<string, Map<string, WebSocket>>();
const pendingSaves = new Map<string, NodeJS.Timeout>();

function send(code: string, playerId: string, msg: Outbound) {
  const ws = sockets.get(code)?.get(playerId);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function logError(what: string) {
  return (err: unknown) => console.error(`${what} failed:`, (err as Error).message);
}

/** Coalesce bursts of changes into one snapshot write per game. */
function scheduleSave(game: Game) {
  if (pendingSaves.has(game.code)) return;
  pendingSaves.set(
    game.code,
    setTimeout(() => {
      pendingSaves.delete(game.code);
      store.saveGame(game.toSnapshot(), GAME_TTL_MS / 1000).catch(logError(`Saving game ${game.code}`));
    }, SAVE_DEBOUNCE_MS),
  );
}

function register(game: Game) {
  games.set(game.code, game);
  sockets.set(game.code, new Map());
}

function hooksFor(code: () => string, mapId: string) {
  return {
    // Only special stations persist with the venue map; players' task signs belong to this game.
    onStationsChanged: (stations: GameSnapshot["stations"]) =>
      store.saveStations(mapId, stations.filter((s) => s.kind !== "task" && !s.fromGameset)).catch(logError("Saving stations")),
    onChange: () => {
      const game = games.get(code());
      if (game) scheduleSave(game);
    },
    onGameOver: (summary: Parameters<Store["recordGame"]>[0]) => store.recordGame(summary).catch(logError("Recording game")),
  };
}

function newCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion when read aloud
  for (;;) {
    const code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
    if (!games.has(code)) return code;
  }
}

async function createGame(mapId: string): Promise<Game> {
  let code = newCode();
  // A saved game may exist in the store without being loaded into this process yet.
  while (await store.loadGame(code)) code = newCode();
  // Task signs saved on older maps belong to past games; new games start with only the special stations.
  const stations = (await store.loadStations(mapId)).filter((s) => s.kind !== "task");
  const game = new Game(code, mapId, stations, (playerId, msg) => send(code, playerId, msg), hooksFor(() => code, mapId));
  register(game);
  return game;
}

/**
 * Games load lazily from the store the first time a phone asks for them. That covers crash restarts,
 * and Render's zero-downtime deploys: the new instance starts before the old one saves its final
 * snapshot on SIGTERM, so reading at boot would miss the last moves.
 */
const loading = new Map<string, Promise<Game | undefined>>();
async function getGame(code: string): Promise<Game | undefined> {
  const live = games.get(code);
  if (live) return live;
  if (!/^[A-Z]{4}$/.test(code)) return undefined;
  if (!loading.has(code)) {
    loading.set(
      code,
      (async () => {
        const snap = await store.loadGame(code);
        if (!snap || Date.now() - snap.lastActivity > GAME_TTL_MS) return undefined;
        const game = Game.fromSnapshot(snap, (playerId, msg) => send(code, playerId, msg), hooksFor(() => code, snap.mapId));
        register(game);
        // Persist migrations applied by fromSnapshot (for example colors added to older players)
        // even if everyone only reconnects and no gameplay action follows.
        scheduleSave(game);
        console.log(`Restored game ${code} from ${store.kind} (${snap.phase})`);
        return game;
      })().finally(() => loading.delete(code)),
    );
  }
  return loading.get(code);
}

// ---------------------------------------------------------------- HTTP

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new GameError("Body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, games: games.size, store: store.kind });
    }
    // POST /games { name, mapId? } -> creates lobby, caller becomes host
    if (req.method === "POST" && parts.length === 1 && parts[0] === "games") {
      const body = await readJson(req);
      const game = await createGame(body.mapId || "default");
      const p = game.addPlayer(String(body.name ?? ""));
      scheduleSave(game);
      return json(res, 200, { code: game.code, playerId: p.id, token: p.token });
    }
    // POST /games/:code/join { name }
    if (req.method === "POST" && parts.length === 3 && parts[0] === "games" && parts[2] === "join") {
      const game = await getGame(parts[1].toUpperCase());
      if (!game) return json(res, 404, { error: "No game with that code" });
      const body = await readJson(req);
      const p = game.addPlayer(String(body.name ?? ""));
      game.broadcast();
      scheduleSave(game);
      return json(res, 200, { code: game.code, playerId: p.id, token: p.token });
    }
    // ---- Saved games (gamesets): reading is open, writing needs GAMESET_PASSWORD.
    if (parts[0] === "gamesets") {
      // GET /gamesets -> [{ id, name, signs, updatedAt }]   newest first
      if (req.method === "GET" && parts.length === 1) {
        const all = await store.listGamesets();
        return json(res, 200, all.map((g) => ({ id: g.id, name: g.name, signs: taskSigns(g.stations), updatedAt: g.updatedAt })));
      }
      // GET /gamesets/:id -> { id, name, stations, ... }
      if (req.method === "GET" && parts.length === 2) {
        const gameset = await store.getGameset(parts[1]);
        return gameset ? json(res, 200, gameset) : json(res, 404, { error: "No game with that id" });
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        if (body.password !== GAMESET_PASSWORD) return json(res, 403, { error: "Wrong password" });
        // POST /gamesets/check { password } -> { ok }
        if (parts.length === 2 && parts[1] === "check") return json(res, 200, { ok: true });
        // POST /gamesets { password, name } -> gameset
        if (parts.length === 1) {
          const name = String(body.name ?? "").trim().slice(0, 40);
          if (!name) return json(res, 400, { error: "Name the game" });
          const now = Date.now();
          const gameset: Gameset = { id: randomBytes(4).toString("hex"), name, stations: [], createdAt: now, updatedAt: now };
          await store.saveGameset(gameset);
          return json(res, 200, gameset);
        }
        const gameset = await store.getGameset(parts[1]);
        if (!gameset) return json(res, 404, { error: "No game with that id" });
        // POST /gamesets/:id/delete { password }
        if (parts.length === 3 && parts[2] === "delete") {
          await store.deleteGameset(gameset.id);
          return json(res, 200, { ok: true });
        }
        // POST /gamesets/:id/rename { password, name }
        if (parts.length === 3 && parts[2] === "rename") {
          const name = String(body.name ?? "").trim().slice(0, 40);
          if (!name) return json(res, 400, { error: "Name the game" });
          await store.saveGameset({ ...gameset, name, updatedAt: Date.now() });
          return json(res, 200, { ok: true });
        }
        // POST /gamesets/:id/stations { password, name, kind, lat, lng, signText, photoId, radiusM } -> station
        if (parts.length === 3 && parts[2] === "stations") {
          const station = buildStation(body);
          await store.saveGameset({ ...gameset, stations: [...gameset.stations, station], updatedAt: Date.now() });
          return json(res, 200, station);
        }
        // POST /gamesets/:id/stations/:stationId/delete { password }
        if (parts.length === 5 && parts[2] === "stations" && parts[4] === "delete") {
          const stations = gameset.stations.filter((s) => s.id !== parts[3]);
          await store.saveGameset({ ...gameset, stations, updatedAt: Date.now() });
          return json(res, 200, { ok: true });
        }
      }
    }
    // POST /games/:code/gameset { playerId, token, gamesetId | null } -> { signs }   any player picks a saved game (or none)
    if (req.method === "POST" && parts.length === 3 && parts[0] === "games" && parts[2] === "gameset") {
      const game = await getGame(parts[1].toUpperCase());
      if (!game) return json(res, 404, { error: "No game with that code" });
      const body = await readJson(req);
      const player = game.authenticate(String(body.playerId ?? ""), String(body.token ?? ""));
      if (!player) return json(res, 403, { error: "Not in this game" });
      let gameset: Gameset | null = null;
      if (body.gamesetId) {
        gameset = await store.getGameset(String(body.gamesetId));
        if (!gameset) return json(res, 404, { error: "No game with that id" });
        if (taskSigns(gameset.stations) === 0) return json(res, 400, { error: "That game has no signs yet" });
      }
      return json(res, 200, { signs: game.useGameset(player.id, gameset) });
    }
    // POST /photos { jpegBase64 } -> { photoId }   (sign reference photos for stations)
    if (req.method === "POST" && url.pathname === "/photos") {
      const body = await readJson(req);
      if (typeof body.jpegBase64 !== "string") return json(res, 400, { error: "jpegBase64 required" });
      return json(res, 200, { photoId: await store.savePhoto(Buffer.from(body.jpegBase64, "base64")) });
    }
    // POST /faces { pngBase64 } -> { faceId }   (players' cut-out heads, transparent PNG)
    if (req.method === "POST" && url.pathname === "/faces") {
      const body = await readJson(req);
      if (typeof body.pngBase64 !== "string") return json(res, 400, { error: "pngBase64 required" });
      const png = Buffer.from(body.pngBase64, "base64");
      if (png.length > 1024 * 1024 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return json(res, 400, { error: "Face must be a PNG under 1 MB" });
      }
      return json(res, 200, { faceId: await store.savePhoto(png) });
    }
    // GET /faces/:id.png
    if (req.method === "GET" && parts.length === 2 && parts[0] === "faces") {
      const png = await store.getPhoto(parts[1].replace(/\.png$/, ""));
      if (!png) return json(res, 404, { error: "Not found" });
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(png);
    }
    // GET /photos/:id.jpg
    if (req.method === "GET" && parts.length === 2 && parts[0] === "photos") {
      const jpeg = await store.getPhoto(parts[1].replace(/\.jpg$/, ""));
      if (!jpeg) return json(res, 404, { error: "Not found" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
      return res.end(jpeg);
    }
    json(res, 404, { error: "Not found" });
  } catch (err) {
    if (!(err instanceof GameError)) console.error(err);
    json(res, err instanceof GameError ? 400 : 500, { error: (err as Error).message });
  }
});

// ---------------------------------------------------------------- WebSocket
// Connect: /ws?code=ABCD&playerId=...&token=...
// Client -> server: { id, action, payload }   Server -> client: { type: "ack", id, ok, error?, result? }
// Server pushes { type: "state", state } (full redacted snapshot) and { type: "event", event, data }.

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 2 * 1024 * 1024 });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const code = (url.searchParams.get("code") ?? "").toUpperCase();
  // Clients send nothing until they receive their first snapshot, so awaiting here drops no messages.
  const game = await getGame(code).catch(() => undefined);
  const player = game?.authenticate(url.searchParams.get("playerId") ?? "", url.searchParams.get("token") ?? "");
  if (!game || !player) {
    ws.close(4001, "Unknown game or player");
    return;
  }
  const conns = sockets.get(code)!;
  conns.get(player.id)?.close(4000, "Replaced by newer connection");
  conns.set(player.id, ws);
  game.setConnected(player.id, true);

  let alive = true;
  ws.on("pong", () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 10_000);

  ws.on("message", (raw) => {
    let msg: { id?: number; action?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      const result = game.handle(player.id, String(msg.action), msg.payload ?? {});
      ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: true, result }));
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: false, error: (err as Error).message }));
    }
  });

  ws.on("close", () => {
    clearInterval(ping);
    if (conns.get(player.id) === ws) {
      conns.delete(player.id);
      game.setConnected(player.id, false);
    }
  });
});

// ---------------------------------------------------------------- lifecycle

// Timers + periodic re-evaluation of proximity-derived state.
const ticker = setInterval(() => {
  const now = Date.now();
  for (const [code, game] of games) {
    if (now - game.lastActivity > GAME_TTL_MS) {
      games.delete(code);
      sockets.get(code)?.forEach((ws) => ws.close(4002, "Game expired"));
      sockets.delete(code);
      store.deleteGame(code).catch(logError(`Deleting game ${code}`));
      continue;
    }
    game.tick();
  }
}, 500);

/** Render sends SIGTERM before every deploy/restart: write every live game so phones reconnect into it. */
async function shutdown(signal: string) {
  console.log(`${signal}: saving ${games.size} game(s) and shutting down`);
  clearInterval(ticker);
  for (const t of pendingSaves.values()) clearTimeout(t);
  await Promise.allSettled([...games.values()].map((g) => store.saveGame(g.toSnapshot(), GAME_TTL_MS / 1000)));
  wss.clients.forEach((ws) => ws.close(1012, "Server restarting"));
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await store.init();
// Bind IPv4 explicitly: Render's port detection looks for 0.0.0.0.
server.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  console.log(`IRL Among Us server on port ${PORT} (store: ${store.kind})`);
  for (const ip of ips) console.log(`  same Wi-Fi: http://${ip}:${PORT}`);
});
