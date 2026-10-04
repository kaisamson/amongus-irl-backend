import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, type Outbound } from "../src/game.ts";
import { fusePositions, parseReport, type PositionReport } from "../src/positions.ts";
import type { Player, Sighting, Station } from "../src/types.ts";

const LAT = 49.2786;
const LNG = -122.9182;
const M = 1 / 111_320; // one meter of latitude
const now = 1_000_000;

function player(id: string, extra: Partial<Player> = {}): Player {
  return { id, lastCheckpoint: null, ...extra } as Player;
}

function report(lat: number, lng: number, accuracyM: number, extra: Partial<PositionReport> = {}): PositionReport {
  return { lat, lng, accuracyM, at: now, roomId: null, room: null, levelDelta: 0, sources: ["gps"], ...extra };
}

function fuse(players: Player[], reports: [string, PositionReport][], sightings: [string, string, number][] = [], stations: Station[] = []) {
  const sightingMap = new Map<string, Map<string, Sighting>>();
  for (const [a, b, rssi] of sightings) {
    if (!sightingMap.has(a)) sightingMap.set(a, new Map());
    sightingMap.get(a)!.set(b, { rssi, at: now });
  }
  return fusePositions({
    players,
    stations,
    reports: new Map(reports),
    sightings: sightingMap,
    rssiAt1m: -59,
    pathLossExponent: 2.2,
    freshMs: 6000,
    now,
  });
}

test("a phone's report is used as is, and its radius grows while it goes quiet", () => {
  const [fresh] = fuse([player("a")], [["a", report(LAT, LNG, 5)]]);
  assert.equal(fresh.accuracyM, 5);
  assert.equal(fresh.stale, false);

  const [old] = fuse([player("a")], [["a", report(LAT, LNG, 5, { at: now - 30_000 })]]);
  assert.ok(old.accuracyM > 30, `grew to ${old.accuracyM}`);
  assert.equal(old.stale, true);
});

test("a sign check-in newer than the last report pins the player to the sign", () => {
  const sign = { id: "s1", name: "Sign", kind: "task", lat: LAT + 50 * M, lng: LNG, radiusM: 15 } as Station;
  const p = player("a", { lastCheckpoint: { stationId: "s1", method: "sign", at: now - 1000 } });
  const [pos] = fuse([p], [["a", report(LAT, LNG, 30, { at: now - 5000 })]], [], [sign]);
  assert.equal(pos.lat, sign.lat);
  assert.deepEqual(pos.sources, ["sign"]);
  assert.ok(pos.accuracyM < 6);
});

test("an older check-in doesn't override the phone's newer report", () => {
  const sign = { id: "s1", name: "Sign", kind: "task", lat: LAT + 50 * M, lng: LNG, radiusM: 15 } as Station;
  const p = player("a", { lastCheckpoint: { stationId: "s1", method: "sign", at: now - 60_000 } });
  const [pos] = fuse([p], [["a", report(LAT, LNG, 8)]], [], [sign]);
  assert.equal(pos.lat, LAT);
});

test("standing next to someone better placed pulls a poor estimate toward them", () => {
  const players = [player("good"), player("poor")];
  const reports: [string, PositionReport][] = [
    ["good", report(LAT, LNG, 3)],
    ["poor", report(LAT + 40 * M, LNG, 40)],
  ];
  const [, before] = fuse(players, reports);
  // -59 dBm is about 1 m apart.
  const [good, poor] = fuse(players, reports, [["poor", "good", -59]]);
  assert.equal(good.lat, LAT, "the better-placed player isn't moved");
  assert.ok(poor.lat < before.lat - 30 * M, "pulled most of the way over");
  assert.ok(poor.accuracyM < 10, `tightened to ${poor.accuracyM}`);
  assert.ok(poor.sources.includes("nearby"));
});

test("far-away or worse-placed neighbors don't change anything", () => {
  const players = [player("a"), player("b")];
  const reports: [string, PositionReport][] = [
    ["a", report(LAT, LNG, 4)],
    ["b", report(LAT + 20 * M, LNG, 30)],
  ];
  // -90 dBm is tens of meters: too far to say anything.
  const [, far] = fuse(players, reports, [["a", "b", -90]]);
  assert.equal(far.lat, LAT + 20 * M);
  const [near] = fuse(players, reports, [["a", "b", -59]]);
  assert.equal(near.lat, LAT, "a is better placed than b, so b can't move a");
});

test("a phone with no fix of its own still shows up next to whoever it's near", () => {
  const [, b] = fuse([player("a"), player("b")], [["a", report(LAT, LNG, 4)]], [["b", "a", -62]]);
  assert.equal(b.playerId, "b");
  assert.equal(b.lat, LAT);
  assert.ok(b.accuracyM > 4);
  assert.deepEqual(b.sources, ["nearby"]);
});

test("reports are validated", () => {
  assert.throws(() => parseReport({ lat: "x", lng: 1, accuracyM: 5 }, now));
  assert.throws(() => parseReport({ lat: 1, lng: 1 }, now));
  const r = parseReport({ lat: 1, lng: 2, accuracyM: 0.2, room: " Lounge ", levelDelta: 1.4, sources: ["sign", 3] }, now);
  assert.equal(r.accuracyM, 1);
  assert.equal(r.room, "Lounge");
  assert.equal(r.levelDelta, 1);
  assert.deepEqual(r.sources, ["sign"]);
});

function setup() {
  let clock = now;
  const inbox = new Map<string, Outbound[]>();
  const game = new Game("TEST", "test", [], (id, msg) => inbox.set(id, [...(inbox.get(id) ?? []), msg]), {}, () => clock);
  game.settings.signsPerPlayer = 0;
  const host = game.addPlayer("Host");
  const other = game.addPlayer("Other");
  host.connected = other.connected = true;
  const positions = (p: Player) =>
    (inbox.get(p.id) ?? []).filter((m) => m.type === "positions").map((m: any) => m.positions);
  const states = (p: Player) => (inbox.get(p.id) ?? []).filter((m) => m.type === "state").length;
  const advance = (ms: number) => {
    clock += ms;
    game.tick();
  };
  return { game, host, other, positions, states, advance };
}

test("positions go out while live positions are on (the default), and stop when it's off", () => {
  const { game, host, other, positions, advance } = setup();
  assert.equal(game.settings.livePositions, true);
  game.handle(host.id, "update_settings", { livePositions: false });
  game.handle(other.id, "position", { lat: LAT, lng: LNG, accuracyM: 6 });
  advance(1000);
  assert.equal(positions(host).length, 0);

  game.handle(host.id, "update_settings", { livePositions: true });
  advance(1000);
  const latest = positions(host).at(-1);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].playerId, other.id);

  game.handle(host.id, "update_settings", { livePositions: false });
  advance(1000);
  assert.deepEqual(positions(host).at(-1), [], "maps are cleared when it's turned off");
});

test("position reports don't resend the game state", () => {
  const { game, other, states } = setup();
  const before = states(other);
  game.handle(other.id, "position", { lat: LAT, lng: LNG, accuracyM: 6 });
  assert.equal(states(other), before);
});

test("live positions can be flipped mid-game, but not other settings", () => {
  const { game, host } = setup();
  game.handle(host.id, "add_station", { name: "A", kind: "task" });
  game.handle(host.id, "add_station", { name: "B", kind: "task" });
  game.handle(host.id, "add_station", { name: "Meet", kind: "meeting" });
  game.handle(host.id, "add_station", { name: "Red button", kind: "emergency" });
  game.handle(host.id, "start_game", {});
  game.handle(host.id, "update_settings", { livePositions: true });
  assert.equal(game.settings.livePositions, true);
  assert.throws(() => game.handle(host.id, "update_settings", { livePositions: false, impostors: 2 }));
});
