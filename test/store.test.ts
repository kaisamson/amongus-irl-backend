import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { FileStore, RedisStore, type Store } from "../src/store.ts";
import { Game } from "../src/game.ts";
import type { Station } from "../src/types.ts";

const stations: Station[] = [
  { id: "s1", name: "Electrical", kind: "task", taskType: "wiring", lat: 49.27, lng: -122.91, radiusM: 15, photoId: "abc123" },
  { id: "s2", name: "Cafeteria", kind: "meeting", radiusM: 20, signText: "CAFE" },
];

function snapshotOfStartedGame() {
  const game = new Game("ABCD", "venue", structuredClone(stations), () => {});
  for (const name of ["A", "B", "C", "D"]) game.addPlayer(name);
  game.handle(game.hostId, "start_game", {});
  return game.toSnapshot();
}

/** ioredis-mock instances share one in-memory database, so wipe it for each test. */
function freshRedis(): Redis {
  const client = new (RedisMock as any)() as Redis;
  void client.flushall();
  return client;
}

const stores: [string, () => Store][] = [
  ["redis", () => new RedisStore(freshRedis())],
  ["files", () => new FileStore(mkdtempSync(join(tmpdir(), "irlau-")))],
];

for (const [kind, make] of stores) {
  test(`${kind}: venue maps round-trip and stay per-map`, async () => {
    const store = make();
    await store.init();
    assert.deepEqual(await store.loadStations("venue"), []);
    await store.saveStations("venue", stations);
    assert.deepEqual(await store.loadStations("venue"), stations);
    assert.deepEqual(await store.loadStations("other"), []);
  });

  test(`${kind}: sign photos keep exact bytes`, async () => {
    const store = make();
    await store.init();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x00, 0xff, 0xd9]);
    const id = await store.savePhoto(jpeg);
    assert.ok((await store.getPhoto(id))!.equals(jpeg));
    assert.equal(await store.getPhoto("missing"), null);
    await assert.rejects(store.getPhoto("../etc/passwd"), /Bad id/);
  });

  test(`${kind}: live game snapshot saves, loads and deletes`, async () => {
    const store = make();
    await store.init();
    const snap = snapshotOfStartedGame();
    await store.saveGame(snap, 60);
    const loaded = await store.loadGame("ABCD");
    assert.deepEqual(loaded, JSON.parse(JSON.stringify(snap)));
    await store.deleteGame("ABCD");
    assert.equal(await store.loadGame("ABCD"), null);
  });

  test(`${kind}: game history records`, async () => {
    const store = make();
    await store.init();
    await store.recordGame({
      code: "ABCD", mapId: "venue", startedAt: 1, endedAt: 2, winner: "crewmates", winReason: "x",
      players: [{ name: "A", role: "impostor", alive: false, ejected: true }],
    });
  });
}

test("redis: live games expire, venue maps and photos never do", async () => {
  const client = freshRedis();
  const store = new RedisStore(client);
  await store.init();
  await store.saveGame(snapshotOfStartedGame(), 600);
  await store.saveStations("venue", stations);
  const photoId = await store.savePhoto(Buffer.from("jpeg"));
  const ttl = await client.ttl("game:ABCD");
  assert.ok(ttl > 0 && ttl <= 600);
  assert.equal(await client.ttl("map:venue"), -1, "-1 = exists with no expiry");
  assert.equal(await client.ttl(`photo:${photoId}`), -1);
});
