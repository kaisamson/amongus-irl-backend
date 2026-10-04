import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStation, Game, rssiAtDistance, type Outbound } from "../src/game.ts";
import { DEFAULT_SETTINGS, PLAYER_COLORS, type Player, type Station } from "../src/types.ts";

function setup(n = 4, stations?: Partial<Station>[]) {
  let clock = 1_000_000;
  const inbox = new Map<string, Outbound[]>();
  const game = new Game("TEST", "test", [], (id, msg) => {
    inbox.set(id, [...(inbox.get(id) ?? []), msg]);
  }, {}, () => clock);
  game.settings.signsPerPlayer = 0; // these tests aren't about lobby sign setup (see the signs tests below)
  const players: Player[] = [];
  for (let i = 0; i < n; i++) players.push(game.addPlayer(`P${i}`));
  const host = players[0];
  const defs = stations ?? [
    { name: "Electrical", kind: "task" },
    { name: "Comms", kind: "task" },
    { name: "Cafeteria", kind: "meeting" },
  ];
  // Every map needs a red button to start.
  const withButton = defs.some((s) => s.kind === "emergency") ? defs : [...defs, { name: "Red button", kind: "emergency" as const }];
  for (const s of withButton) game.handle(host.id, "add_station", s);
  const act = (p: Player, action: string, payload: any = {}) => game.handle(p.id, action, payload);
  const advance = (ms: number) => {
    clock += ms;
    game.tick();
  };
  const events = (p: Player) => (inbox.get(p.id) ?? []).filter((m) => m.type === "event").map((m: any) => m.event);
  const station = (name: string) => game.stations.find((s) => s.name === name)!;
  return { game, players, host, act, advance, events, station };
}

function startPlaying(ctx: ReturnType<typeof setup>) {
  ctx.act(ctx.host, "start_game");
  for (const p of ctx.players) ctx.act(p, "ack_role");
  assert.equal(ctx.game.phase, "PLAYING");
  const impostor = ctx.players.find((p) => p.role === "impostor")!;
  const crew = ctx.players.filter((p) => p.role === "crewmate");
  return { impostor, crew };
}

test("a lobby without signs starts role reveal and can enter play", () => {
  const ctx = setup(4, []);
  ctx.act(ctx.host, "start_game");
  assert.equal(ctx.game.phase, "ROLE_REVEAL");
  assert.equal(ctx.players.filter((p) => p.role === "impostor").length, 1);
  for (const p of ctx.players) {
    assert.equal(p.tasks.length, 0);
    assert.ok(ctx.events(p).includes("ROLE_ASSIGNED"));
    ctx.act(p, "ack_role");
  }
  assert.equal(ctx.game.phase, "PLAYING");
  ctx.advance(1000);
  assert.equal(ctx.game.phase, "PLAYING", "zero tasks must not immediately end the game");
});

test("players receive distinct colors that survive snapshots", () => {
  const ctx = setup(15, []);
  const colors = ctx.players.map((player) => player.color);
  assert.equal(new Set(colors).size, colors.length);
  assert.deepEqual(colors, PLAYER_COLORS);
  assert.deepEqual(ctx.game.viewFor(ctx.host.id).players.map((player) => player.color), PLAYER_COLORS);

  const restored = Game.fromSnapshot(JSON.parse(JSON.stringify(ctx.game.toSnapshot())), () => {});
  assert.deepEqual([...restored.players.values()].map((player) => player.color), PLAYER_COLORS);
});

test("players can pick a free color and set a face in the lobby only", () => {
  const ctx = setup(4, []);
  const [a, b] = ctx.players;
  ctx.act(a, "set_color", { color: "cyan" });
  assert.equal(a.color, "cyan");
  assert.throws(() => ctx.act(b, "set_color", { color: "cyan" }), /taken/);
  assert.throws(() => ctx.act(b, "set_color", { color: "plaid" }), /Unknown color/);
  ctx.act(a, "set_color", { color: "cyan" }); // re-picking your own color is fine

  assert.equal(ctx.game.viewFor(b.id).players.find((p) => p.id === a.id)?.faceId, null);
  ctx.act(a, "set_face", { faceId: "abc123" });
  assert.equal(ctx.game.viewFor(b.id).players.find((p) => p.id === a.id)?.faceId, "abc123");
  assert.throws(() => ctx.act(a, "set_face", { faceId: "../etc" }), /Bad face id/);
  const restored = Game.fromSnapshot(JSON.parse(JSON.stringify(ctx.game.toSnapshot())), () => {});
  assert.equal(restored.players.get(a.id)?.faceId, "abc123");
  assert.equal(restored.players.get(a.id)?.color, "cyan");
  ctx.act(a, "set_face", { faceId: null });
  assert.equal(ctx.game.viewFor(a.id).players.find((p) => p.id === a.id)?.faceId, null);

  ctx.act(ctx.host, "start_game");
  assert.throws(() => ctx.act(a, "set_color", { color: "lime" }), /Not allowed/);
  assert.throws(() => ctx.act(a, "set_face", { faceId: "abc123" }), /Not allowed/);
});

test("restoring a legacy snapshot assigns and persists distinct player colors", () => {
  const ctx = setup(4, []);
  const snapshot = JSON.parse(JSON.stringify(ctx.game.toSnapshot()));
  for (const player of snapshot.players) delete player.color;

  const restored = Game.fromSnapshot(snapshot, () => {});
  const colors = [...restored.players.values()].map((player) => player.color);
  assert.equal(new Set(colors).size, colors.length);
  assert.deepEqual(colors, PLAYER_COLORS.slice(0, 4));
  assert.deepEqual(restored.toSnapshot().players.map((player) => player.color), colors);
});

test("starting without signs still requires the minimum player count", () => {
  const ctx = setup(1, []);
  assert.throws(() => ctx.act(ctx.host, "start_game"), /Need at least/);
  assert.equal(ctx.game.phase, "LOBBY");
});

test("two players can start without signs, reveal roles, and keep playing after a skipped vote", () => {
  const ctx = setup(2, []);
  const { game, act, players, host } = ctx;
  act(host, "update_settings", { devSkipCheckpoint: true, devSkipProximity: true, emergencyCooldownSec: 0 });
  const { impostor, crew } = startPlaying(ctx);
  assert.equal(crew.length, 1);
  assert.equal(game.viewFor(host.id).taskProgress.total, 0);
  act(crew[0], "call_emergency");
  act(host, "host_advance"); // gathering at the red button -> discussion
  act(host, "host_advance");
  for (const p of players) act(p, "vote", { targetId: null });
  act(host, "host_advance");
  assert.equal(game.phase, "PLAYING");
  ctx.advance(game.settings.killCooldownSec * 1000);
  act(impostor, "kill", { targetId: crew[0].id });
  assert.equal(game.phase, "GAME_OVER");
  assert.equal(game.winner, "impostors");
});

test("a two-player game still rejects two impostors", () => {
  const ctx = setup(2, []);
  ctx.act(ctx.host, "update_settings", { impostors: 2 });
  assert.throws(() => ctx.act(ctx.host, "start_game"), /Too many impostors/);
  assert.equal(ctx.game.phase, "LOBBY");
});

test("a host can still require more than two players", () => {
  const ctx = setup(2, []);
  ctx.act(ctx.host, "update_settings", { minPlayers: 4 });
  assert.throws(() => ctx.act(ctx.host, "start_game"), /Need at least 4 players/);
});

test("full loop: kill -> report -> gather -> discuss -> vote -> crewmates win", () => {
  const ctx = setup(4);
  const { game, act, advance, events, station } = ctx;
  const { impostor, crew } = startPlaying(ctx);
  const [victim, finder, other] = crew;

  // Kill is gated on cooldown, then on BLE proximity.
  assert.throws(() => act(impostor, "kill", { targetId: victim.id }), /cooldown/);
  advance(game.settings.killCooldownSec * 1000);
  assert.throws(() => act(impostor, "kill", { targetId: victim.id }), /not in range/);
  assert.deepEqual(game.viewFor(impostor.id).me.killTargets, []);

  // Victim's phone hears the impostor's BLE token at close range.
  act(victim, "proximity", { sightings: [{ token: impostor.bleToken, rssi: -50 }] });
  assert.deepEqual(game.viewFor(impostor.id).me.killTargets, [victim.id]);
  act(impostor, "kill", { targetId: victim.id });
  assert.ok(events(victim).includes("PLAYER_KILLED"));
  assert.ok(!events(finder).includes("PLAYER_KILLED"), "kills are not broadcast");
  assert.equal(game.viewFor(victim.id).me.isBody, true);
  // Other crew can't tell anyone died yet.
  assert.equal(game.viewFor(finder.id).players.find((p) => p.id === victim.id)!.alive, true);

  // Stale sightings don't count.
  act(finder, "proximity", { sightings: [{ token: victim.bleToken, rssi: -60 }] });
  advance(10_000);
  assert.deepEqual(game.viewFor(finder.id).me.nearbyBodies, []);
  act(finder, "proximity", { sightings: [{ token: victim.bleToken, rssi: -60 }] });
  assert.deepEqual(game.viewFor(finder.id).me.nearbyBodies, [victim.id]);
  act(finder, "report_body", { bodyId: victim.id });
  assert.equal(game.phase, "MEETING");
  assert.ok(events(other).includes("BODY_REPORTED"));
  assert.equal(game.viewFor(other.id).players.find((p) => p.id === victim.id)!.alive, false);

  // Gathering: every living player checks in at the meeting point.
  assert.equal(game.meeting!.stage, "gathering");
  assert.throws(() => act(victim, "kill", {}), /Not allowed during MEETING/);
  for (const p of [impostor, finder, other]) act(p, "checkpoint", { stationId: station("Cafeteria").id, method: "sign" });
  assert.equal(game.meeting!.stage, "discussion");
  assert.throws(() => act(finder, "vote", { targetId: impostor.id }), /Not allowed/);

  advance(game.settings.discussionSec * 1000);
  assert.equal(game.phase, "VOTING");
  assert.throws(() => act(victim, "vote", { targetId: null }), /Ghosts/);
  act(finder, "vote", { targetId: impostor.id });
  act(other, "vote", { targetId: impostor.id });
  assert.equal(game.phase, "VOTING");
  act(impostor, "vote", { targetId: null });
  assert.equal(game.phase, "RESULT");
  assert.equal(game.result!.ejectedId, impostor.id);
  assert.equal(game.result!.ejectedWasImpostor, true);
  assert.equal(game.result!.impostorsRemaining, 0, "shown as '0 Impostors remain.'");

  advance(game.settings.resultSec * 1000);
  assert.equal(game.phase, "GAME_OVER");
  assert.equal(game.winner, "crewmates");
  // Everyone sees all roles at game over.
  assert.ok(game.viewFor(finder.id).players.every((p) => p.role !== null));
});

test("hidden information: crewmates never see other roles", () => {
  const ctx = setup(5);
  const { crew } = startPlaying(ctx);
  for (const c of crew) {
    const view = ctx.game.viewFor(c.id);
    for (const p of view.players) {
      if (p.id !== c.id) assert.equal(p.role, null);
    }
    assert.equal(view.me.killCooldownUntil, null);
    assert.equal(JSON.stringify(view).includes('"impostor"'), false);
  }
});

test("tasks require a checkpoint, upload needs the full duration, fake tasks don't count", () => {
  const ctx = setup(4, [
    { name: "Comms", kind: "task" },
  ]);
  ctx.game.settings.tasksPerPlayer = 1;
  ctx.game.settings.taskTypes = ["upload"];
  const { impostor, crew } = startPlaying(ctx);
  const comms = ctx.station("Comms");
  const [a] = crew;
  const task = a.tasks[0];

  assert.throws(() => ctx.act(a, "task_start", { taskId: task.id }), /Check in/);
  assert.throws(() => ctx.act(a, "checkpoint", { stationId: comms.id, method: "manual" }), /disabled/);
  ctx.act(a, "checkpoint", { stationId: comms.id, method: "qr" });
  ctx.act(a, "task_start", { taskId: task.id });
  ctx.advance(2000);
  assert.throws(() => ctx.act(a, "task_complete", { taskId: task.id }), /interrupted/);
  ctx.advance(ctx.game.settings.uploadSec * 1000);
  ctx.act(a, "task_complete", { taskId: task.id });
  assert.deepEqual(ctx.game.taskProgress(), { done: 1, total: 3 });

  const fake = impostor.tasks[0];
  ctx.act(impostor, "checkpoint", { stationId: comms.id, method: "qr" });
  ctx.act(impostor, "task_start", { taskId: fake.id });
  ctx.advance(ctx.game.settings.uploadSec * 1000);
  ctx.act(impostor, "task_complete", { taskId: fake.id });
  assert.deepEqual(ctx.game.taskProgress(), { done: 1, total: 3 }, "fake task doesn't move the bar");

  // The checkpoint expires.
  ctx.advance(ctx.game.settings.checkpointTtlSec * 1000 + 1);
  assert.throws(() => ctx.act(crew[1], "task_start", { taskId: crew[1].tasks[0].id }), /Check in/);
});

test("submit scan needs the full scan time at the scanner", () => {
  const ctx = setup(4, [{ name: "MedBay", kind: "task" }]);
  ctx.game.settings.tasksPerPlayer = 1;
  ctx.game.settings.taskTypes = ["scan"];
  const { crew } = startPlaying(ctx);
  const [a] = crew;
  const task = a.tasks[0];
  assert.equal(task.type, "scan");
  ctx.act(a, "checkpoint", { stationId: ctx.station("MedBay").id, method: "qr" });
  assert.throws(() => ctx.act(a, "task_complete", { taskId: task.id }), /Scan interrupted/);
  ctx.act(a, "task_start", { taskId: task.id });
  ctx.advance(ctx.game.settings.uploadSec * 1000);
  assert.throws(() => ctx.act(a, "task_complete", { taskId: task.id }), /Scan interrupted/, "uses scanSec, not uploadSec");
  ctx.advance((ctx.game.settings.scanSec - ctx.game.settings.uploadSec) * 1000);
  ctx.act(a, "task_complete", { taskId: task.id });
  assert.equal(task.completed, true);
});

test("divert power is two steps at different signs; one-step mini-games finish at once", () => {
  const ctx = setup(4, [
    { name: "Electrical", kind: "task" },
    { name: "Shields", kind: "task" },
  ]);
  ctx.game.settings.tasksPerPlayer = 1;
  ctx.game.settings.taskTypes = ["divert"];
  const { crew } = startPlaying(ctx);
  const task = crew[0].tasks[0];
  assert.equal(task.steps.length, 2);
  assert.notEqual(task.steps[0], task.steps[1]);
  ctx.act(crew[0], "checkpoint", { stationId: task.steps[0], method: "sign" });
  ctx.act(crew[0], "task_complete", { taskId: task.id });
  assert.equal(task.completed, false, "diverting doesn't finish the task");
  assert.throws(() => ctx.act(crew[0], "task_complete", { taskId: task.id }), /Check in|station/i);
  ctx.act(crew[0], "checkpoint", { stationId: task.steps[1], method: "sign" });
  ctx.act(crew[0], "task_complete", { taskId: task.id });
  assert.equal(task.completed, true);

  const quick = setup(4, [{ name: "Admin", kind: "task" }]);
  quick.act(quick.host, "update_settings", { taskTypes: ["swipe", "shields", "o2", "divert"] });
  startPlaying(quick);
  for (const t of quick.players.flatMap((p) => p.tasks)) {
    assert.ok(["swipe", "shields", "o2"].includes(t.type), "one sign: divert is impossible");
    assert.equal(t.steps.length, 1);
  }
});

test("GPS checkpoints are geofenced on the server", () => {
  const ctx = setup(4, [{ name: "Fountain", kind: "task", lat: 49.2781, lng: -122.9199, radiusM: 20 }]);
  const { crew } = startPlaying(ctx);
  const id = ctx.station("Fountain").id;
  assert.throws(() => ctx.act(crew[0], "checkpoint", { stationId: id, method: "gps", lat: 49.2790, lng: -122.9199 }), /Too far/);
  ctx.act(crew[0], "checkpoint", { stationId: id, method: "gps", lat: 49.27811, lng: -122.91991 });
});

test("delivery task needs both stations in order; all tasks done -> crewmates win", () => {
  const ctx = setup(4, [
    { name: "A", kind: "task" },
    { name: "B", kind: "task" },
  ]);
  ctx.game.settings.taskTypes = ["delivery", "wiring"];
  const { crew } = startPlaying(ctx);
  for (const c of crew) {
    for (const t of c.tasks) {
      for (const stationId of [...t.steps]) {
        ctx.act(c, "checkpoint", { stationId, method: "sign" });
        ctx.act(c, "task_complete", { taskId: t.id });
      }
    }
  }
  assert.equal(ctx.game.phase, "GAME_OVER");
  assert.equal(ctx.game.winner, "crewmates");
});

test("impostors win when they equal the crew", () => {
  const ctx = setup(4);
  ctx.game.settings.devSkipProximity = true;
  const { impostor, crew } = startPlaying(ctx);
  ctx.advance(ctx.game.settings.killCooldownSec * 1000);
  ctx.act(impostor, "kill", { targetId: crew[0].id });
  assert.equal(ctx.game.phase, "PLAYING");
  ctx.advance(ctx.game.settings.killCooldownSec * 1000);
  ctx.act(impostor, "kill", { targetId: crew[1].id });
  assert.equal(ctx.game.phase, "GAME_OVER");
  assert.equal(ctx.game.winner, "impostors");
});

test("QR fallback kill and body-phone self report", () => {
  const ctx = setup(4);
  const { impostor, crew } = startPlaying(ctx);
  ctx.advance(ctx.game.settings.killCooldownSec * 1000);
  ctx.act(impostor, "kill", { method: "qr", qrToken: crew[0].qrToken });
  assert.equal(crew[0].alive, false);
  ctx.act(crew[0], "report_body", { method: "self" });
  assert.equal(ctx.game.phase, "MEETING");
  assert.equal(ctx.game.meeting!.calledBy, null);
});

test("tie vote ejects nobody and play resumes", () => {
  const ctx = setup(4, [{ name: "X", kind: "task" }]);
  const { impostor, crew } = startPlaying(ctx);
  ctx.game.settings.devSkipCheckpoint = true;
  ctx.advance(ctx.game.settings.emergencyCooldownSec * 1000);
  ctx.act(crew[0], "call_emergency");
  assert.equal(ctx.game.meeting!.stage, "gathering", "no meeting point: everyone gathers at the red button");
  assert.throws(() => ctx.act(crew[0], "call_emergency"), /Not allowed/);
  ctx.act(ctx.host, "host_advance"); // gathering -> discussion
  ctx.act(ctx.host, "host_advance");
  ctx.act(crew[0], "vote", { targetId: impostor.id });
  ctx.act(impostor, "vote", { targetId: crew[0].id });
  ctx.advance(ctx.game.settings.votingSec * 1000);
  assert.equal(ctx.game.result!.tie, true);
  assert.equal(ctx.game.result!.ejectedId, null);
  ctx.advance(ctx.game.settings.resultSec * 1000);
  assert.equal(ctx.game.phase, "PLAYING");
});

test("reactor sabotage: two stations within the window fixes it, timeout loses", () => {
  const stations: Partial<Station>[] = [
    { name: "T", kind: "task" },
    { name: "Reactor A", kind: "reactor" },
    { name: "Reactor B", kind: "reactor" },
  ];
  for (const fixIt of [true, false]) {
    const ctx = setup(4, stations);
    const { impostor, crew } = startPlaying(ctx);
    assert.throws(() => ctx.act(impostor, "sabotage", { kind: "reactor" }), /cooldown/);
    ctx.advance(ctx.game.settings.sabotageCooldownSec * 1000);
    assert.throws(() => ctx.act(crew[0], "sabotage", { kind: "reactor" }), /Only impostors/);
    ctx.act(impostor, "sabotage", { kind: "reactor" });
    const a = ctx.station("Reactor A").id;
    const b = ctx.station("Reactor B").id;
    if (fixIt) {
      ctx.act(crew[0], "checkpoint", { stationId: a, method: "sign" });
      ctx.act(crew[1], "checkpoint", { stationId: b, method: "sign" });
      ctx.act(crew[0], "fix_sabotage", { stationId: a });
      ctx.advance(ctx.game.settings.reactorWindowSec * 1000 + 1);
      ctx.act(crew[1], "fix_sabotage", { stationId: b });
      assert.ok(ctx.game.sabotage, "first activation expired: one person can't do both");
      ctx.act(crew[0], "fix_sabotage", { stationId: a });
      assert.equal(ctx.game.sabotage, null);
    } else {
      ctx.advance(ctx.game.settings.reactorSec * 1000);
      assert.equal(ctx.game.winner, "impostors");
    }
  }
});

test("restart returns everyone to the lobby with stations kept", () => {
  const ctx = setup(4);
  startPlaying(ctx);
  ctx.act(ctx.host, "restart");
  assert.equal(ctx.game.phase, "LOBBY");
  assert.equal(ctx.game.stations.length, 4);
  assert.ok(ctx.players.every((p) => p.role === null && p.alive));
  ctx.act(ctx.host, "start_game");
  assert.equal(ctx.game.phase, "ROLE_REVEAL");
});

test("snapshot/restore mid-meeting: a restarted server continues the same game", () => {
  const ctx = setup(4);
  const { impostor, crew } = startPlaying(ctx);
  ctx.game.settings.devSkipProximity = true;
  ctx.advance(ctx.game.settings.killCooldownSec * 1000);
  ctx.act(impostor, "kill", { targetId: crew[0].id });
  ctx.act(crew[1], "report_body", { bodyId: crew[0].id });
  ctx.act(ctx.host, "host_advance"); // gathering -> discussion

  // Simulate a server restart: serialize like Redis would, rebuild in a fresh process.
  const snap = JSON.parse(JSON.stringify(ctx.game.toSnapshot()));
  assert.equal(snap.sightings, undefined, "BLE sightings are not persisted");
  const sent: string[] = [];
  const restored = Game.fromSnapshot(snap, (id, msg) => sent.push(`${id}:${msg.type}`), {}, ctx.game.now);

  assert.equal(restored.phase, "MEETING");
  assert.equal(restored.meeting!.stage, "discussion");
  assert.ok([...restored.players.values()].every((p) => !p.connected));
  // Phones reconnect with the tokens they stored before the restart.
  assert.ok(restored.authenticate(crew[1].id, crew[1].token));
  assert.equal(restored.players.get(crew[0].id)!.alive, false);
  assert.equal(restored.viewFor(crew[1].id).me.role, "crewmate");

  restored.handle(ctx.host.id, "host_advance", {}); // -> voting
  for (const p of [impostor, crew[1], crew[2]]) restored.handle(p.id, "vote", { targetId: impostor.id });
  assert.equal(restored.result!.ejectedId, impostor.id);
});

test("hooks: onChange fires for actions but not BLE reports; onGameOver gets a summary", () => {
  let changes = 0;
  let summary: any = null;
  let clock = 1_000_000;
  const game = new Game("HOOK", "m", [], () => {}, { onChange: () => changes++, onGameOver: (s) => (summary = s) }, () => clock);
  game.settings.signsPerPlayer = 0;
  const players = ["A", "B", "C", "D"].map((n) => game.addPlayer(n));
  game.handle(players[0].id, "add_station", { name: "T", kind: "task" });
  game.handle(players[0].id, "add_station", { name: "Red button", kind: "emergency" });
  game.handle(players[0].id, "update_settings", { devSkipProximity: true, killCooldownSec: 0 });
  game.handle(players[0].id, "start_game", {});
  const before = changes;
  game.handle(players[1].id, "proximity", { sightings: [] });
  assert.equal(changes, before, "proximity reports are too frequent to snapshot");

  for (const p of players) game.handle(p.id, "ack_role", {});
  const imp = players.find((p) => p.role === "impostor")!;
  for (const t of players.filter((p) => p.role === "crewmate").slice(0, 2)) {
    game.handle(imp.id, "kill", { targetId: t.id });
  }
  assert.equal(summary.winner, "impostors");
  assert.equal(summary.players.length, 4);
  assert.ok(summary.endedAt >= summary.startedAt && summary.startedAt > 0);
});

test("signs get random mini-games from the host's rotation; delivery needs a second sign", () => {
  const ctx = setup(6, [{ name: "Only sign", kind: "task" }]);
  ctx.act(ctx.host, "update_settings", { taskTypes: ["delivery", "sequence"] });
  startPlaying(ctx);
  for (const p of ctx.players) {
    assert.ok(p.tasks.every((t) => t.type === "sequence" && t.steps.length === 1), "one sign: delivery is impossible");
  }

  const many = setup(6, [1, 2, 3, 4].map((i) => ({ name: `Sign ${i}`, kind: "task" as const })));
  many.act(many.host, "update_settings", { taskTypes: ["wiring", "delivery"], tasksPerPlayer: 3 });
  startPlaying(many);
  const all = many.players.flatMap((p) => p.tasks);
  assert.ok(all.every((t) => t.type === "wiring" || t.type === "delivery"));
  for (const t of all.filter((t) => t.type === "delivery")) {
    assert.equal(t.steps.length, 2);
    assert.notEqual(t.steps[0], t.steps[1]);
  }
  for (const p of many.players) assert.equal(new Set(p.tasks.map((t) => t.steps[0])).size, 3, "different sign per task");
  assert.throws(() => many.act(many.host, "update_settings", { taskTypes: [] }), /Not allowed|at least one/);
});

test("host can force who the impostor is, and only the host can see that", () => {
  const ctx = setup(5);
  const chosen = ctx.players[3];
  ctx.act(ctx.host, "update_settings", { forcedImpostorIds: [chosen.id] });
  assert.deepEqual(ctx.game.viewFor(ctx.host.id).settings.forcedImpostorIds, [chosen.id]);
  for (const p of ctx.players.slice(1)) assert.deepEqual(ctx.game.viewFor(p.id).settings.forcedImpostorIds, []);
  assert.throws(() => ctx.act(ctx.host, "update_settings", { forcedImpostorIds: ["nope"] }), /Unknown player/);

  for (let round = 0; round < 5; round++) {
    ctx.act(ctx.host, "start_game");
    assert.equal(chosen.role, "impostor");
    assert.equal(ctx.players.filter((p) => p.role === "impostor").length, 1);
    ctx.act(ctx.host, "restart");
  }
  ctx.act(ctx.host, "update_settings", { forcedImpostorIds: [ctx.players[1].id, ctx.players[2].id] });
  assert.throws(() => ctx.act(ctx.host, "start_game"), /pick fewer/);
});

test("kill and report ranges are set in approximate meters", () => {
  // Log-distance model: 1 m reads rssiAt1m; 10 m is 10·n dB weaker.
  assert.equal(rssiAtDistance(1, -59, 2), -59);
  assert.equal(rssiAtDistance(10, -59, 2), -79);

  const ctx = setup(4);
  ctx.act(ctx.host, "update_settings", { killDistanceM: 2, rssiAt1m: -60, pathLossExponent: 2, killCooldownSec: 0 });
  const { impostor, crew } = startPlaying(ctx);
  const cutoff = rssiAtDistance(2, -60, 2); // ≈ -66 dBm
  ctx.act(crew[0], "proximity", { sightings: [{ token: impostor.bleToken, rssi: Math.floor(cutoff) - 3 }] }); // ~3 m
  assert.deepEqual(ctx.game.viewFor(impostor.id).me.killTargets, []);
  ctx.act(crew[0], "proximity", { sightings: [{ token: impostor.bleToken, rssi: Math.ceil(cutoff) + 3 }] }); // ~1.4 m
  assert.deepEqual(ctx.game.viewFor(impostor.id).me.killTargets, [crew[0].id]);
  assert.throws(() => ctx.act(ctx.host, "update_settings", { killDistanceM: 0 }), /Not allowed|greater than 0/);
});

test("any player can adjust the settings, which are validated", () => {
  const ctx = setup(4);
  ctx.act(ctx.host, "update_settings", { roleRevealSec: 3, gatherTimeoutSec: 30, discussionSec: 0, votingSec: 20, resultSec: 2 });
  assert.equal(ctx.game.settings.resultSec, 2);
  assert.throws(() => ctx.act(ctx.host, "update_settings", { votingSec: -5 }), /negative/);
  assert.throws(() => ctx.act(ctx.host, "update_settings", { votingSec: "10" }), /must be number/);
  ctx.act(ctx.players[1], "update_settings", { votingSec: 10 });
  assert.equal(ctx.game.settings.votingSec, 10);
  // Forcing the impostor stays with the host: nobody else can see it, so nobody else may set it.
  assert.throws(() => ctx.act(ctx.players[1], "update_settings", { forcedImpostorIds: [ctx.players[1].id] }), /Only the host/);
});

test("restoring an old snapshot drops removed settings and defaults new ones", () => {
  const ctx = setup(4);
  const snap = JSON.parse(JSON.stringify(ctx.game.toSnapshot()));
  delete snap.settings.killDistanceM;
  delete snap.settings.taskTypes;
  snap.settings.killRssiThreshold = -65;
  const restored = Game.fromSnapshot(snap, () => {});
  assert.equal(restored.settings.killDistanceM, 1.5);
  assert.deepEqual(restored.settings.taskTypes, DEFAULT_SETTINGS.taskTypes);
  assert.equal((restored.settings as any).killRssiThreshold, undefined);
});

test("host-added bots fill a lobby and keep the game moving", () => {
  let clock = 1_000_000;
  const game = new Game("BOTS", "m", [], () => {}, {}, () => clock);
  game.settings.signsPerPlayer = 0;
  const host = game.addPlayer("Host");
  const friend = game.addPlayer("Friend");
  game.handle(host.id, "add_station", { name: "Sign", kind: "task" });
  game.handle(host.id, "add_station", { name: "Red button", kind: "emergency" });
  assert.throws(() => game.handle(friend.id, "add_bot", {}), /Only the host/);
  game.handle(host.id, "add_bot", {});
  game.handle(host.id, "add_bot", {});
  const bots = [...game.players.values()].filter((p) => p.bot);
  assert.deepEqual(bots.map((b) => b.name), ["Bot 1", "Bot 2"]);
  assert.ok(game.viewFor(host.id).players.filter((p) => p.isBot).every((p) => p.connected));

  game.handle(host.id, "update_settings", { forcedImpostorIds: [host.id], devSkipCheckpoint: true });
  game.handle(host.id, "start_game", {});
  game.handle(host.id, "ack_role", {});
  game.handle(friend.id, "ack_role", {});
  game.tick(); // bots acknowledge
  assert.equal(game.phase, "PLAYING");

  // Restored bots stay "connected" (no phone will ever reconnect them).
  const restored = Game.fromSnapshot(JSON.parse(JSON.stringify(game.toSnapshot())), () => {}, {}, () => clock);
  assert.ok([...restored.players.values()].filter((p) => p.bot).every((p) => p.connected));

  game.stations.push({ id: "btn", name: "Button", kind: "emergency", radiusM: 10 });
  game.stations.push({ id: "caf", name: "Cafe", kind: "meeting", radiusM: 10 });
  clock += game.settings.emergencyCooldownSec * 1000;
  game.handle(friend.id, "call_emergency", {});
  assert.equal(game.meeting!.stage, "gathering");
  game.handle(host.id, "checkpoint", { stationId: "caf", method: "manual" });
  game.handle(friend.id, "checkpoint", { stationId: "caf", method: "manual" });
  game.tick(); // bots arrive -> discussion
  assert.equal(game.meeting!.stage, "discussion");
  game.handle(host.id, "host_advance", {});
  game.handle(host.id, "vote", { targetId: friend.id });
  game.handle(friend.id, "vote", { targetId: host.id });
  game.tick(); // bots vote skip -> tally
  assert.equal(game.phase, "RESULT");
  assert.equal(game.result!.tallies.find((t) => t.targetId === null)!.count, 2);
});

test("every player must add their signs before the host can start", () => {
  const game = new Game("SIGN", "m", [], () => {}, {});
  const host = game.addPlayer("Host");
  const guest = game.addPlayer("Guest");
  game.handle(host.id, "add_bot", {});
  assert.equal(game.settings.signsPerPlayer, 3);
  const addSign = (p: Player, n: number) => {
    for (let i = 0; i < n; i++) game.handle(p.id, "add_station", { name: `${p.name} sign ${i}`, kind: "task" });
  };

  // Players add task signs; anyone can set the special signs too, and the red button is required.
  addSign(guest, 3);
  assert.ok(game.stations.every((s) => s.addedBy === guest.id));
  addSign(host, 3);
  assert.throws(() => game.handle(host.id, "start_game", {}), /red button/);
  game.handle(guest.id, "add_station", { name: "Red button", kind: "emergency" });
  assert.equal(game.stations.find((s) => s.kind === "emergency")?.addedBy, undefined, "special signs belong to the map");
  game.handle(host.id, "delete_station", { stationId: game.stations.find((s) => s.addedBy === host.id)!.id });
  assert.throws(() => game.handle(host.id, "start_game", {}), /Waiting for Host to add their signs/);
  addSign(host, 1);

  // A player can delete their own sign, not someone else's; the host can delete any.
  const guestSign = game.stations.find((s) => s.addedBy === guest.id)!;
  const hostSign = game.stations.find((s) => s.addedBy === host.id)!;
  assert.throws(() => game.handle(guest.id, "delete_station", { stationId: hostSign.id }), /Only the host/);
  game.handle(guest.id, "delete_station", { stationId: guestSign.id });
  assert.throws(() => game.handle(host.id, "start_game", {}), /Waiting for Guest/);
  addSign(guest, 1);

  game.handle(host.id, "start_game", {}); // the bot needs no signs
  assert.equal(game.phase, "ROLE_REVEAL");
});

test("signs per player is validated, 0 turns the requirement off, kicked players take their signs", () => {
  const game = new Game("SIG0", "m", [], () => {}, {});
  const host = game.addPlayer("Host");
  const guest = game.addPlayer("Guest");
  assert.throws(() => game.handle(host.id, "update_settings", { signsPerPlayer: 2.5 }), /whole number/);
  assert.throws(() => game.handle(host.id, "update_settings", { signsPerPlayer: 11 }), /whole number/);
  game.handle(guest.id, "add_station", { name: "Guest sign", kind: "task" });
  game.handle(host.id, "kick", { playerId: guest.id });
  assert.equal(game.stations.length, 0);
  game.handle(host.id, "update_settings", { signsPerPlayer: 0 });
  game.addPlayer("Other");
  game.handle(host.id, "add_station", { name: "Red button", kind: "emergency" });
  game.handle(host.id, "start_game", {});
  assert.equal(game.phase, "ROLE_REVEAL");
});

test("any player can use a saved game's signs, switch games, and go back to none", () => {
  const game = new Game("SETS", "m", [{ id: "cafe", name: "Cafe", kind: "meeting", radiusM: 15 }], () => {}, {});
  const host = game.addPlayer("Host");
  const guest = game.addPlayer("Guest");
  game.handle(guest.id, "add_station", { name: "Guest sign", kind: "task" });
  const demo = {
    id: "demo", name: "Judging demo", createdAt: 1, updatedAt: 1,
    stations: [
      { id: "a", name: "2005", kind: "task" as const, radiusM: 15, photoId: "p1", addedBy: "someone-else" },
      { id: "b", name: "Sign 2", kind: "task" as const, radiusM: 15, photoId: "p2" },
      { id: "btn", name: "Red button", kind: "emergency" as const, radiusM: 15 },
    ],
  };
  const other = { ...demo, id: "other", name: "Other", stations: [{ id: "c", name: "3000", kind: "task" as const, radiusM: 15 }] };

  assert.equal(game.useGameset(guest.id, demo), 3, "2 from the game + the guest's own sign");
  assert.deepEqual(game.gameset, { id: "demo", name: "Judging demo" });
  assert.equal(game.settings.signsPerPlayer, 3, "the requirement stays; the saved game's signs count toward it");
  // 3 each × 2 players = 6 wanted, the saved game brings 2, so the other 4 are split 2 + 2.
  assert.deepEqual(game.viewFor(guest.id).signQuotas, { [host.id]: 2, [guest.id]: 2 });
  assert.ok(game.stations.some((s) => s.id === "cafe"), "the saved game has no meeting point, so the lobby's stays");
  assert.ok(game.stations.filter((s) => s.fromGameset === "demo").every((s) => s.addedBy === undefined));
  assert.equal(game.viewFor(guest.id).gameset?.name, "Judging demo");

  game.useGameset(host.id, other); // switching keeps the original "before" state
  assert.deepEqual(game.stations.map((s) => s.name).sort(), ["3000", "Cafe", "Guest sign"]);

  game.useGameset(host.id, null);
  assert.equal(game.gameset, null);
  assert.equal(game.settings.signsPerPlayer, 3);
  assert.deepEqual(game.stations.map((s) => s.id).sort(), ["cafe", game.stations.find((s) => s.addedBy)!.id].sort());

  // Survives a restart, then the game starts with the loaded signs.
  game.useGameset(host.id, demo);
  const restored = Game.fromSnapshot(JSON.parse(JSON.stringify(game.toSnapshot())), () => {});
  assert.equal(restored.gameset?.id, "demo");
  restored.useGameset(host.id, null);
  assert.ok(restored.stations.some((s) => s.id === "cafe"), "before-state restored after a restart too");
  game.handle(host.id, "update_settings", { signsPerPlayer: 0 });
  game.handle(host.id, "start_game", {});
  assert.equal(game.phase, "ROLE_REVEAL");
  assert.throws(() => game.useGameset(host.id, null), /Not allowed/);
});

test("buildStation validates and normalizes signs from phones", () => {
  assert.throws(() => buildStation({ name: "x", kind: "lounge" as any }), /name and kind/);
  assert.throws(() => buildStation({ kind: "task" }), /name and kind/);
  const s = buildStation({ name: "a".repeat(60), kind: "task", signText: "  2005 ", lat: 49.2, lng: -122.9 }, { fromGameset: "g" });
  assert.equal(s.name.length, 40);
  assert.equal(s.signText, "2005");
  assert.equal(s.radiusM, 15);
  assert.equal(s.fromGameset, "g");
});

test("a saved game's signs count toward the total and the rest is split evenly in join order", () => {
  const game = new Game("SPLT", "m", [], () => {}, {});
  const [a, b, c] = ["A", "B", "C"].map((n) => game.addPlayer(n));
  game.handle(a.id, "add_bot", {});
  const preset = (n: number) => ({
    id: `g${n}`, name: `G${n}`, createdAt: 1, updatedAt: 1,
    stations: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `S${i}`, kind: "task" as const, radiusM: 15 })),
  });
  // 3 each × 3 people = 9; 4 preset leaves 5: 2, 2, 1. Bots owe nothing.
  game.useGameset(a.id, preset(4));
  assert.deepEqual(game.signQuotas(), { [a.id]: 2, [b.id]: 2, [c.id]: 1 });
  // Enough preset signs: nobody has to photograph anything.
  game.useGameset(a.id, preset(12));
  assert.deepEqual(game.signQuotas(), { [a.id]: 0, [b.id]: 0, [c.id]: 0 });
  assert.equal(game.playersMissingSigns().length, 0);
  // No saved game: the full amount each.
  game.useGameset(a.id, null);
  assert.deepEqual(game.signQuotas(), { [a.id]: 3, [b.id]: 3, [c.id]: 3 });
});

test("special signs: anyone sets them, a new one replaces the old, reactor keeps two", () => {
  const game = new Game("SPEC", "m", [], () => {}, {});
  const host = game.addPlayer("Host");
  const guest = game.addPlayer("Guest");
  game.handle(guest.id, "add_station", { name: "Red button", kind: "emergency", signText: "OLD" });
  game.handle(guest.id, "add_station", { name: "Red button", kind: "emergency", signText: "NEW" });
  assert.deepEqual(game.stations.filter((s) => s.kind === "emergency").map((s) => s.signText), ["NEW"]);
  for (const t of ["R1", "R2", "R3"]) game.handle(host.id, "add_station", { name: "Reactor", kind: "reactor", signText: t });
  assert.deepEqual(game.stations.filter((s) => s.kind === "reactor").map((s) => s.signText), ["R2", "R3"]);
  game.handle(guest.id, "add_station", { name: "Security", kind: "security" });
  game.handle(guest.id, "add_station", { name: "Admin", kind: "admin" });
  assert.ok(game.stations.some((s) => s.kind === "security") && game.stations.some((s) => s.kind === "admin"));
  const reactor = game.stations.find((s) => s.kind === "reactor")!;
  game.handle(guest.id, "delete_station", { stationId: reactor.id });
  assert.equal(game.stations.filter((s) => s.kind === "reactor").length, 1);
});

test("loading a saved game keeps lobby special signs it doesn't have", () => {
  const game = new Game("KEEP", "m", [], () => {}, {});
  const host = game.addPlayer("Host");
  game.handle(host.id, "add_station", { name: "Red button", kind: "emergency" });
  game.handle(host.id, "add_station", { name: "Lights", kind: "electrical" });
  const demo = {
    id: "d", name: "Demo", createdAt: 1, updatedAt: 1,
    stations: [{ id: "x", name: "Their button", kind: "emergency" as const, radiusM: 15 }],
  };
  game.useGameset(host.id, demo);
  assert.deepEqual(game.stations.map((s) => s.name).sort(), ["Lights", "Their button"]);
  // A special sign added while the saved game is in use survives going back to none.
  game.handle(host.id, "add_station", { name: "Admin", kind: "admin" });
  game.useGameset(host.id, null);
  assert.deepEqual(game.stations.map((s) => s.name).sort(), ["Admin", "Lights", "Red button"]);
});

test("the play area (building and floor) is a lobby setting anyone can pick", () => {
  const ctx = setup(2);
  ctx.act(ctx.players[1], "update_settings", { mapBuildingId: "SUB", mapFloorId: "2000" });
  assert.equal(ctx.game.settings.mapBuildingId, "SUB");
  assert.equal(ctx.game.viewFor(ctx.host.id).settings.mapFloorId, "2000");
  assert.throws(() => ctx.act(ctx.host, "update_settings", { mapFloorId: 2000 }), /must be string/);
  assert.throws(() => ctx.act(ctx.host, "update_settings", { mapBuildingId: "x".repeat(20) }), /Bad building/);
});

test("security cameras: dead players and players at the Security sign can watch; frames go only to watchers", () => {
  const cams: { to: string; playerId: string }[] = [];
  const ctx = setup(4, [
    { name: "T", kind: "task" },
    { name: "Security", kind: "security" },
    { name: "Meet", kind: "meeting" },
  ]);
  const { game } = ctx;
  const send = (game as any).send;
  (game as any).send = (id: string, msg: any) => {
    if (msg.type === "cam") cams.push({ to: id, playerId: msg.playerId });
    send(id, msg);
  };
  const { impostor, crew } = startPlaying(ctx);
  const [watcher, subject, other] = crew;

  // Alive and not at Security: no.
  assert.throws(() => ctx.act(watcher, "cam_watch", { on: true }), /Security sign/);
  assert.equal(game.viewFor(subject.id).me.camWanted, false);

  ctx.act(watcher, "checkpoint", { stationId: ctx.station("Security").id, method: "sign" });
  assert.equal(game.viewFor(watcher.id).me.canWatchCams, true);
  ctx.act(watcher, "cam_watch", { on: true });
  assert.equal(game.viewFor(subject.id).me.camWanted, true, "phones stream once someone watches");
  assert.equal(game.viewFor(watcher.id).me.camWanted, false, "nobody else is watching the watcher");

  ctx.act(subject, "cam_frame", { jpeg: "AAAA" });
  assert.deepEqual(cams, [{ to: watcher.id, playerId: subject.id }]);
  ctx.act(other, "cam_frame", { jpeg: "AAAA" });
  ctx.act(other, "cam_frame", { jpeg: "BBBB" }); // too soon: dropped
  assert.equal(cams.length, 2);
  assert.throws(() => ctx.act(other, "cam_frame", { jpeg: 5 }), /Bad camera frame/);

  // The Security check-in wears off: they stop watching.
  ctx.advance(game.settings.checkpointTtlSec * 1000 + 1000);
  assert.equal(game.camWatchers.has(watcher.id), false);
  assert.equal(game.viewFor(subject.id).me.camWanted, false);

  // Dead players can always watch during play.
  impostor.alive = true;
  other.alive = false;
  assert.equal(game.viewFor(other.id).me.canWatchCams, true);
  ctx.act(other, "cam_watch", { on: true });
  assert.ok(game.camWatchers.has(other.id));
  ctx.act(other, "cam_watch", { on: false });
  assert.equal(game.camWatchers.size, 0);
});

test("kill range is optimistic about leaving: one weak reading doesn't drop the target", () => {
  const ctx = setup(4);
  const { impostor, crew } = startPlaying(ctx);
  const [target] = crew;
  const strong = Math.ceil(rssiAtDistance(ctx.game.settings.killDistanceM, ctx.game.settings.rssiAt1m, ctx.game.settings.pathLossExponent)) + 3;
  const report = (rssi: number) => ctx.act(target, "proximity", { sightings: [{ token: impostor.bleToken, rssi }] });

  report(strong);
  assert.deepEqual(ctx.game.viewFor(impostor.id).me.killTargets, [target.id], "in range at once");
  ctx.advance(1000);
  report(-95); // a body in the way for a moment
  assert.deepEqual(ctx.game.viewFor(impostor.id).me.killTargets, [target.id], "still in range");
  ctx.advance(ctx.game.settings.proximityFreshSec * 1000);
  report(-95); // really walked away
  assert.deepEqual(ctx.game.viewFor(impostor.id).me.killTargets, [], "out of range once the strong reading is old");
});

test("a preferred suit colour is used when it's free; kills name the killer", () => {
  const game = new Game("PREF", "m", [], () => {}, {});
  const a = game.addPlayer("A", "cyan");
  const b = game.addPlayer("B", "cyan"); // taken: gets the next free one
  const c = game.addPlayer("C", "not-a-colour");
  assert.equal(a.color, "cyan");
  assert.notEqual(b.color, "cyan");
  assert.ok(c.color);

  const events: { to: string; event: string; data: any }[] = [];
  const ctx = setup(4);
  (ctx.game as any).send = (to: string, msg: any) => { if (msg.type === "event") events.push({ to, event: msg.event, data: msg.data }); };
  const { impostor, crew } = startPlaying(ctx);
  ctx.game.settings.devSkipProximity = true;
  ctx.advance(ctx.game.settings.killCooldownSec * 1000);
  ctx.act(impostor, "kill", { targetId: crew[0].id });
  const killed = events.find((e) => e.event === "PLAYER_KILLED" && e.to === crew[0].id);
  assert.deepEqual(killed?.data, { victimId: crew[0].id, killerId: impostor.id });
  assert.equal(ctx.game.viewFor(crew[0].id).me.killedBy, impostor.id);
  assert.equal(ctx.game.viewFor(crew[1].id).me.killedBy, null);
});

test("lobby signs can be moved: special signs and your own by anyone, others' only by the host", () => {
  const game = new Game("MOVE", "m", [], () => {}, {}, () => 1_000_000);
  const host = game.addPlayer("Host");
  const friend = game.addPlayer("Friend");
  const mine = game.handle(friend.id, "add_station", { name: "Mine", kind: "task", lat: 1, lng: 1 }) as Station;
  const hosts = game.handle(host.id, "add_station", { name: "Host's", kind: "task" }) as Station;
  const button = game.handle(host.id, "add_station", { name: "Red button", kind: "emergency", photoId: "p" }) as Station;
  const at = { lat: 49.2788, lng: -122.9187, buildingId: "ASB", floorId: "09" };

  game.handle(friend.id, "move_station", { stationId: mine.id, ...at });
  game.handle(friend.id, "move_station", { stationId: button.id, ...at });
  assert.throws(() => game.handle(friend.id, "move_station", { stationId: hosts.id, ...at }), /Only the host/);
  game.handle(host.id, "move_station", { stationId: mine.id, ...at, floorId: "10" });

  const after = (id: string) => game.stations.find((s) => s.id === id)!;
  assert.deepEqual(after(mine.id), { ...mine, ...at, floorId: "10" });
  assert.deepEqual(after(button.id), { ...button, ...at }, "photo and kind are kept");
  assert.throws(() => game.handle(host.id, "move_station", { stationId: "nope", ...at }), /No sign/);
  assert.throws(() => game.handle(host.id, "move_station", { stationId: mine.id, lat: "x", lng: 0 }), /latitude/);
});
