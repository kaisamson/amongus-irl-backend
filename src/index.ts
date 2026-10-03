import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Game, type Outbound } from "./game.ts";
import { MapStore } from "./store.ts";
import { GameError } from "./types.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const GAME_TTL_MS = 6 * 60 * 60 * 1000;

const store = new MapStore(DATA_DIR);
const games = new Map<string, Game>();
/** code -> playerId -> socket */
const sockets = new Map<string, Map<string, WebSocket>>();

function send(code: string, playerId: string, msg: Outbound) {
  const ws = sockets.get(code)?.get(playerId);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function newCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion when read aloud
  for (;;) {
    const code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
    if (!games.has(code)) return code;
  }
}

function createGame(mapId: string): Game {
  const code = newCode();
  const game = new Game(
    code,
    mapId,
    store.loadStations(mapId),
    (playerId, msg) => send(code, playerId, msg),
    (stations) => store.saveStations(mapId, stations),
  );
  games.set(code, game);
  sockets.set(code, new Map());
  return game;
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

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, games: games.size });
    }
    // POST /games { name, mapId? } -> creates lobby, caller becomes host
    if (req.method === "POST" && parts.length === 1 && parts[0] === "games") {
      const body = await readJson(req);
      const game = createGame(body.mapId || "default");
      const p = game.addPlayer(String(body.name ?? ""));
      return json(res, 200, { code: game.code, playerId: p.id, token: p.token });
    }
    // POST /games/:code/join { name }
    if (req.method === "POST" && parts.length === 3 && parts[0] === "games" && parts[2] === "join") {
      const game = games.get(parts[1].toUpperCase());
      if (!game) return json(res, 404, { error: "No game with that code" });
      const body = await readJson(req);
      const p = game.addPlayer(String(body.name ?? ""));
      game.broadcast();
      return json(res, 200, { code: game.code, playerId: p.id, token: p.token });
    }
    // POST /photos { jpegBase64 } -> { photoId }   (sign reference photos for stations)
    if (req.method === "POST" && url.pathname === "/photos") {
      const body = await readJson(req);
      if (typeof body.jpegBase64 !== "string") return json(res, 400, { error: "jpegBase64 required" });
      return json(res, 200, { photoId: store.savePhoto(body.jpegBase64) });
    }
    // GET /photos/:id.jpg
    if (req.method === "GET" && parts.length === 2 && parts[0] === "photos") {
      const path = store.photoPath(parts[1].replace(/\.jpg$/, ""));
      if (!path) return json(res, 404, { error: "Not found" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
      return createReadStream(path).pipe(res);
    }
    json(res, 404, { error: "Not found" });
  } catch (err) {
    json(res, err instanceof GameError ? 400 : 500, { error: (err as Error).message });
  }
});

// ---------------------------------------------------------------- WebSocket
// Connect: /ws?code=ABCD&playerId=...&token=...
// Client -> server: { id, action, payload }   Server -> client: { type: "ack", id, ok, error?, result? }
// Server pushes { type: "state", state } (full redacted snapshot) and { type: "event", event, data }.

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 2 * 1024 * 1024 });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const code = (url.searchParams.get("code") ?? "").toUpperCase();
  const game = games.get(code);
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

// Timers + periodic re-evaluation of proximity-derived state.
setInterval(() => {
  const now = Date.now();
  for (const [code, game] of games) {
    if (now - game.lastActivity > GAME_TTL_MS) {
      games.delete(code);
      sockets.get(code)?.forEach((ws) => ws.close(4002, "Game expired"));
      sockets.delete(code);
      continue;
    }
    game.tick();
  }
}, 500);

server.listen(PORT, () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  console.log(`IRL Among Us server on port ${PORT}`);
  for (const ip of ips) console.log(`  phones on this Wi-Fi: http://${ip}:${PORT}`);
});
