import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.ts";

function setup(demo = true) {
  let now = 1_000_000;
  const game = new Game("DEMO", "test", [], () => {}, {}, () => now);
  const players = [game.addPlayer("Host"), game.addPlayer("Crew"), game.addPlayer("Crew2")];
  const [host] = players;
  const act = (id: string, action: string, payload = {}) => game.handle(id, action, payload);
  act(host.id, "add_station", { name: "Red button", kind: "emergency" });
  act(host.id, "update_settings", {
    signsPerPlayer: 0, devSkipProximity: true, devSkipCheckpoint: true,
    killCooldownSec: 0, emergencyCooldownSec: 0,
    forcedImpostorIds: [host.id], demoContinueAtParity: demo,
  });
  const start = () => {
    act(host.id, "start_game");
    for (const player of players) act(player.id, "ack_role");
  };
  const vote = () => {
    act(host.id, "host_advance");
    if (game.phase === "MEETING") act(host.id, "host_advance");
    assert.equal(game.phase, "VOTING");
  };
  const advance = () => { now += 100_000; game.tick(); };
  return { game, players, host, act, start, vote, advance };
}

test("three-player demo can vote an impostor out before a kill", () => {
  const ctx = setup();
  ctx.start();
  ctx.act(ctx.players[1].id, "call_emergency");
  ctx.vote();
  ctx.act(ctx.host.id, "vote", { targetId: null });
  for (const crew of ctx.players.slice(1)) ctx.act(crew.id, "vote", { targetId: ctx.host.id });
  assert.equal(ctx.game.result?.ejectedId, ctx.host.id);
  ctx.advance();
  assert.equal(ctx.game.winner, "crewmates");
});

test("three-player demo survives a kill, reports, and ejects the impostor", () => {
  const ctx = setup();
  ctx.start();
  ctx.act(ctx.host.id, "kill", { targetId: ctx.players[1].id });
  assert.equal(ctx.game.phase, "PLAYING");
  ctx.advance();
  assert.equal(ctx.game.phase, "PLAYING");
  ctx.act(ctx.players[2].id, "report_body", { bodyId: ctx.players[1].id });
  ctx.vote();
  assert.throws(() => ctx.act(ctx.players[1].id, "vote", { targetId: ctx.host.id }), /Ghosts/);
  ctx.act(ctx.players[2].id, "vote", { targetId: ctx.host.id });
  ctx.act(ctx.host.id, "vote", { targetId: ctx.host.id });
  assert.equal(ctx.game.result?.ejectedId, ctx.host.id);
  ctx.advance();
  assert.equal(ctx.game.winner, "crewmates");
});

for (const otherVote of ["crew", "skip"]) {
  test(`demo keeps normal tie/skip rules at parity (${otherVote})`, () => {
    const ctx = setup();
    ctx.start();
    ctx.act(ctx.host.id, "kill", { targetId: ctx.players[1].id });
    ctx.act(ctx.players[2].id, "report_body", { bodyId: ctx.players[1].id });
    ctx.vote();
    ctx.act(ctx.host.id, "vote", { targetId: otherVote === "skip" ? null : ctx.players[2].id });
    ctx.act(ctx.players[2].id, "vote", { targetId: otherVote === "skip" ? null : ctx.host.id });
    assert.equal(ctx.game.result?.ejectedId, null);
    assert.equal(ctx.game.result?.tie, otherVote === "crew");
    ctx.advance();
    assert.equal(ctx.game.phase, "PLAYING");
  });
}

test("demo still ends when the last crewmate is killed", () => {
  const ctx = setup();
  ctx.start();
  for (const crew of ctx.players.slice(1)) ctx.act(ctx.host.id, "kill", { targetId: crew.id });
  assert.equal(ctx.game.phase, "GAME_OVER");
  assert.equal(ctx.game.winner, "impostors");
});

test("normal three-player game ends at parity after a kill", () => {
  const ctx = setup(false);
  ctx.start();
  ctx.act(ctx.host.id, "kill", { targetId: ctx.players[1].id });
  assert.equal(ctx.game.phase, "GAME_OVER");
  assert.equal(ctx.game.winner, "impostors");
});

test("demo voting setting is host-only, lobby-only, typed, and survives restore", () => {
  const ctx = setup();
  assert.throws(() => ctx.act(ctx.players[1].id, "update_settings", { demoContinueAtParity: false }), /host/i);
  assert.throws(() => ctx.act(ctx.host.id, "update_settings", { demoContinueAtParity: "true" }), /boolean/);
  const snapshot = JSON.parse(JSON.stringify(ctx.game.toSnapshot()));
  const restored = Game.fromSnapshot(snapshot, () => {});
  assert.equal(restored.viewFor(ctx.players[1].id).settings.demoContinueAtParity, true);
  delete snapshot.settings.demoContinueAtParity;
  assert.equal(Game.fromSnapshot(snapshot, () => {}).settings.demoContinueAtParity, false);
  ctx.act(ctx.host.id, "update_settings", { demoContinueAtParity: false });
  assert.equal(ctx.game.settings.demoContinueAtParity, false);
  ctx.start();
  assert.throws(() => ctx.act(ctx.host.id, "update_settings", { demoContinueAtParity: true }), /Not allowed during PLAYING/);
});
