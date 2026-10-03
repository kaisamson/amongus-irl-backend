/**
 * Fill a lobby with bot players so you can test a full game with one or two phones.
 *   npm run bots -- ABCD 3 [http://localhost:3000]
 * Bots acknowledge their role, walk to the meeting point when a meeting is called,
 * and vote skip. They never kill, so give a human the impostor role by re-rolling if needed.
 */
import WebSocket from "ws";

const [code, countArg, base = "http://localhost:3000"] = process.argv.slice(2);
if (!code) {
  console.error("usage: npm run bots -- <CODE> [count] [serverUrl]");
  process.exit(1);
}
const count = Number(countArg ?? 3);

async function runBot(i: number) {
  const name = `Bot${i + 1}`;
  const res = await fetch(`${base}/games/${code}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const join = await res.json();
  if (!res.ok) throw new Error(`${name}: ${join.error}`);
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?code=${code}&playerId=${join.playerId}&token=${join.token}`);
  let reqId = 0;
  const act = (action: string, payload: unknown = {}) => ws.send(JSON.stringify({ id: ++reqId, action, payload }));
  // State updates arrive constantly; only schedule each reaction once per phase.
  const scheduled = new Set<string>();
  const once = (key: string, fn: () => void, delay: number) => {
    if (scheduled.has(key)) return;
    scheduled.add(key);
    setTimeout(fn, delay);
  };

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "event") console.log(`${name} <- ${msg.event}`);
    if (msg.type === "ack" && !msg.ok) console.log(`${name} !! ${msg.error}`);
    if (msg.type !== "state") return;
    const s = msg.state;
    if (s.phase === "LOBBY" || s.phase === "PLAYING") scheduled.clear();
    if (s.phase === "ROLE_REVEAL" && !s.me.ackedRole) {
      console.log(`${name} is ${s.me.role}`);
      once("ack", () => act("ack_role"), 500 + Math.random() * 1000);
    }
    if (s.phase === "MEETING" && s.meeting?.stage === "gathering" && s.me.alive && !s.meeting.arrived.includes(s.me.id)) {
      const meetingPoint = s.stations.find((st: any) => st.kind === "meeting");
      if (meetingPoint) once("gather", () => act("checkpoint", { stationId: meetingPoint.id, method: "manual" }), 1500);
    }
    if (s.phase === "VOTING" && s.me.alive && !s.me.hasVoted) {
      once("vote", () => act("vote", { targetId: null }), 1000 + Math.random() * 2000);
    }
  });
  ws.on("close", (c, reason) => console.log(`${name} disconnected ${c} ${reason}`));
  console.log(`${name} joined ${code}`);
}

for (let i = 0; i < count; i++) await runBot(i);
