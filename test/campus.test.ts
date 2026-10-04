import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { buildCampusBundle, CampusCache, floorOrder } from "../src/campus.ts";
import { buildStation, placeStation } from "../src/game.ts";

const square = (x: number, y: number) => ({
  type: "Polygon",
  coordinates: [[[x, y], [x + 0.0001, y], [x + 0.0001, y + 0.0001], [x, y + 0.0001], [x, y]]],
});
const room = (bl: string, fl: string, id: string, name = "", x = -122.918, y = 49.278) => ({
  properties: { bl_abbr: bl, bl_name: `${bl} Building`, fl_id: fl, fl_name: `${fl} Level`, rm_id: id, rm_type: "Office", rm_name: name },
  geometry: square(x, y),
});

test("rooms are grouped into buildings and floors, ordered bottom to top, with a bounding box", () => {
  const bundle = buildCampusBundle(
    [
      room("SUB", "3000", "3100", "Lounge"),
      room("SUB", "2000", "212", "", -122.919, 49.277),
      room("SUB", "P1", "P10"),
      room("AQ", "4000", "4120"),
      { properties: { bl_abbr: "AQ", fl_id: "3000" }, geometry: null },
    ],
    123,
  );
  assert.equal(bundle.version, "123");
  assert.deepEqual(bundle.buildings.map((b) => b.id), ["AQ", "SUB"]);
  const sub = bundle.buildings[1];
  assert.deepEqual(sub.floors.map((f) => f.id), ["P1", "2000", "3000"]);
  assert.equal(sub.floors[1].rooms[0].name, "SUB 212", "unnamed rooms get building + number");
  assert.equal(sub.floors[2].rooms[0].name, "Lounge");
  assert.deepEqual(sub.bbox, [-122.919, 49.277, -122.9179, 49.2781]);
  assert.equal(sub.floors[2].rooms[0].rings[0].length, 5, "rings keep their closing point");
});

test("floor ids from different buildings sort sensibly", () => {
  const ids = ["2000", "P2", "MEZ", "1000", "P1", "3000"];
  assert.deepEqual([...ids].sort((a, b) => floorOrder(a, ids) - floorOrder(b, ids)), ["P2", "P1", "1000", "MEZ", "2000", "3000"]);
  assert.ok(floorOrder("00A", []) < floorOrder("00B", []));
  assert.ok(floorOrder("01", []) < floorOrder("02", []));
});

test("the campus cache fetches once, serves gzip, and keeps working copy when a refresh fails", async () => {
  let calls = 0;
  let fail = false;
  let clock = 0;
  const cache = new CampusCache(async () => {
    calls++;
    if (fail) throw new Error("SFU down");
    return [room("SUB", "2000", "212")];
  }, () => clock);
  const first = await cache.get();
  assert.equal(JSON.parse(gunzipSync(first.gzip).toString()).buildings[0].id, "SUB");
  await cache.get();
  assert.equal(calls, 1);
  fail = true;
  clock += 8 * 24 * 3600_000; // stale: refreshes in the background, still serves the old copy
  assert.equal((await cache.get()).version, first.version);
});

test("the first load failing is reported, and the next request tries again", async () => {
  let fail = true;
  const cache = new CampusCache(async () => {
    if (fail) throw new Error("SFU down");
    return [room("SUB", "2000", "212")];
  });
  await assert.rejects(() => cache.get(), /unavailable/);
  fail = false;
  assert.ok((await cache.get()).json.includes("SUB"));
});

test("signs keep their building and floor", () => {
  const s = buildStation({ name: "Sign", kind: "task", buildingId: " SUB ", floorId: "2000" });
  assert.equal(s.buildingId, "SUB");
  assert.equal(s.floorId, "2000");
  assert.equal(buildStation({ name: "x", kind: "task", buildingId: "" }).buildingId, undefined);
});

test("moving a saved sign changes only its pin, building and floor", () => {
  const s = buildStation({ name: "Sign", kind: "emergency", lat: 49.1, lng: -122.9, buildingId: "SUB", floorId: "2000", photoId: "p1" });
  const moved = placeStation(s, { lat: 49.2788, lng: -122.9187, buildingId: " AQ ", floorId: "3000" });
  assert.deepEqual(moved, { ...s, lat: 49.2788, lng: -122.9187, buildingId: "AQ", floorId: "3000" });
  assert.equal(placeStation(s, { lat: 49.2, lng: -122.9, buildingId: "" }).buildingId, undefined, "off campus clears it");
  assert.throws(() => placeStation(s, { lat: "49", lng: -122.9 }));
  assert.throws(() => placeStation(s, { lat: Number.NaN, lng: -122.9 }));
  assert.throws(() => placeStation(s, { lat: 91, lng: 0 }));
});

test("when SFU can't be reached, the saved snapshot is served and the reason is kept", async () => {
  const saved = await new CampusCache(async () => [room("SUB", "2000", "212")], () => 5).fetchFresh();
  const cache = new CampusCache(async () => {
    throw new Error("fetch failed", { cause: new Error("connect ETIMEDOUT") });
  }, () => 10, async () => saved);
  const bundle = await cache.get();
  assert.equal(bundle.version, "5");
  assert.ok(bundle.json.includes("SUB"));
  assert.equal(cache.lastError, "fetch failed: connect ETIMEDOUT");
  // No snapshot either: unavailable, with the reason.
  const none = new CampusCache(async () => { throw new Error("blocked"); });
  await assert.rejects(() => none.get(), /unavailable/);
  assert.equal(none.lastError, "blocked");
});
