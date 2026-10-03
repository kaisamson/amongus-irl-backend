import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, type Outbound } from "../src/game.ts";
import type { Player, Station } from "../src/types.ts";

function setup(n = 4, stations?: Partial<Station>[]) {
  let clock = 1_000_000;
  const inbox = new Map<string, Outbound[]>();
  const game = new Game("TEST", "test", [], (id, msg) => {
    inbox.set(id, [...(inbox.get(id) ?? []), msg]);
  }, {}, () => clock);
  const players: Player[] = [];
  for (let i = 0; i < n; i++) players.push(game.addPlayer(`P${i}`));
  const host = players[0];
  const defs = stations ?? [
    { name: "Electrical", kind: "task", taskType: "wiring" },
    { name: "Comms", kind: "task", taskType: "upload" },
    { name: "Cafeteria", kind: "meeting" },
  ];
  for (const s of defs) game.handle(host.id, "add_station", s);
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
    { name: "Comms", kind: "task", taskType: "upload" },
  ]);
  ctx.game.settings.tasksPerPlayer = 1;
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

test("GPS checkpoints are geofenced on the server", () => {
  const ctx = setup(4, [{ name: "Fountain", kind: "task", taskType: "wiring", lat: 49.2781, lng: -122.9199, radiusM: 20 }]);
  const { crew } = startPlaying(ctx);
  const id = ctx.station("Fountain").id;
  assert.throws(() => ctx.act(crew[0], "checkpoint", { stationId: id, method: "gps", lat: 49.2790, lng: -122.9199 }), /Too far/);
  ctx.act(crew[0], "checkpoint", { stationId: id, method: "gps", lat: 49.27811, lng: -122.91991 });
});

test("delivery task needs both stations in order; all tasks done -> crewmates win", () => {
  const ctx = setup(4, [
    { name: "A", kind: "task", taskType: "delivery" },
    { name: "B", kind: "task", taskType: "wiring" },
  ]);
  ctx.game.settings.devSkipCheckpoint = false;
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
  ctx.game.stations.push({ id: "btn", name: "Button", kind: "emergency", radiusM: 10 });
  ctx.advance(ctx.game.settings.emergencyCooldownSec * 1000);
  ctx.act(crew[0], "call_emergency");
  assert.equal(ctx.game.meeting!.stage, "discussion", "no meeting station -> skip gathering");
  assert.throws(() => ctx.act(crew[0], "call_emergency"), /Not allowed/);
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
  assert.equal(ctx.game.stations.length, 3);
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
  const players = ["A", "B", "C", "D"].map((n) => game.addPlayer(n));
  game.handle(players[0].id, "add_station", { name: "T", kind: "task" });
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
