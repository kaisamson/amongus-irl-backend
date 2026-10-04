# IRL Among Us: game server

Authoritative game server for [IRL Among Us](https://github.com/Mighty303/irl-amongus), the native iPhone app.
Node + TypeScript, one process serving HTTP and WebSocket on one port. The phones only *ask*; this server decides
every kill, vote, task completion and win, and sends each player a filtered view of the game.

## Run locally

```sh
npm install
npm start      # http://localhost:3000. Prints LAN URLs for phones on the same Wi-Fi.
npm test       # game state machine + storage tests
npm run bots -- <CODE> 3   # fill a lobby with bots (ack roles, gather at meetings, vote skip)
```

Phones on campus/enterprise Wi-Fi or behind a VPN usually can't reach a laptop directly. Use a tunnel:
`cloudflared tunnel --url http://localhost:3000` and enter the printed `https://…trycloudflare.com` URL in the app.

## Storage

| `REDIS_URL` | Store |
| --- | --- |
| set | Redis (Render Key Value, Upstash, …) |
| unset | files in `./data` (local dev) |

Persisted: venue maps (`map:<id>`), sign reference photos (`photo:<id>`), **live-game snapshots** (`game:<CODE>`, 6h TTL,
written ≤250 ms after each change) and finished-game history (`history`). Live gameplay (timers, BLE sightings, votes)
runs in memory; BLE sightings are never persisted.

After a restart or redeploy, each game is restored from its snapshot the first time a phone reconnects with its saved
token. SIGTERM flushes every snapshot first.

## Deploy to Render

`render.yaml` is a Blueprint: Render dashboard → **New → Blueprint** → this repo. It creates:

- **irl-amongus-server**: web service (`npm ci`, `npm start`, health check `/health`)
- **irl-amongus-kv**: Key Value (Redis) with `noeviction`, wired in as `REDIS_URL` over Render's private network

Use paid plans for playtests: free web services sleep (30–60s cold start) and free Key Value has no persistence.
Run **one instance** only, since live games live in that process's memory. Avoid deploying mid-game.

## Host settings worth knowing

All settings live in `src/types.ts` (`DEFAULT_SETTINGS`) and can be changed by any player in the lobby (except `forcedImpostorIds`, which only the host sees and sets). Starting, kicking and adding bots stay with the host.

- **Starting:** new lobbies default to a minimum of two players. Two-player games assign one impostor and one crewmate, and remain playable until an elimination. Task signs are optional: without them, players have no tasks and the task-completion win condition is inactive. Existing lobbies keep their configured minimum; anyone can change it to two in settings.
- **Signs and tasks:** stations of kind `task` are just signs (photo + location). At game start each player gets
  `tasksPerPlayer` different signs, each with a random mini-game from `taskTypes`.
- **Kill / report range:** `killDistanceM` and `reportDistanceM` are approximate meters, converted to RSSI cutoffs
  with `rssi(d) = rssiAt1m - 10 · pathLossExponent · log10(d)`. Calibrate `rssiAt1m` by holding two phones 1 m apart
  (the app's Bluetooth tab shows the reading).
- **Timers:** `roleRevealSec`, `gatherTimeoutSec`, `discussionSec`, `votingSec`, `resultSec`, `killCooldownSec`,
  `emergencyCooldownSec`, `sabotageCooldownSec`, `reactorSec`, `uploadSec`.
- **Lobby signs:** the game wants `signsPerPlayer` task signs per non-bot player (default 3, `0` turns it off).
  Signs already there (a saved game's) count toward that total and the rest is split as evenly as possible
  (`signQuotas` in each player's view). Those signs belong to the game; special signs are saved with the venue map.
- **Special signs:** the red button (`emergency`) is required to start and doubles as the meeting point when there's no
  separate `meeting` sign. Optional: two `reactor` signs and `electrical` (sabotages), `security` (cameras) and `admin`
  (room occupancy). Anyone can set them; adding another of a kind replaces the oldest (reactor keeps two).
- **Saved games (gamesets) for demos/judging:** named collections of already-photographed signs kept on the server.
  Anyone can list and use them; creating and editing needs the shared password (`GAMESET_PASSWORD`, default
  `kaimartin`) until there are accounts. Any player picks a saved game (or none) in the lobby; using one replaces the
  lobby's signs (keeping players' own signs and any special signs the saved game doesn't have); its signs count toward
  the sign total, so players only photograph the rest. Picking none restores the lobby's signs.
- **Testing:** `forcedImpostorIds` (only the host sees it), `devSkipProximity`, `devSkipCheckpoint`, `minPlayers`.
- **Live positions:** `livePositions` (default on; anyone can flip it, even mid-game). Each phone reports its
  own estimate about every 2 s (`position` action: `{ lat, lng, accuracyM, roomId?, room?, levelDelta?, sources? }`),
  built from sign check-ins, steps and compass, accuracy-weighted GPS and the floor plan; no beacons. The server
  (`src/positions.ts`) pulls a player with a poor fix toward a better-placed player they're within a few meters of over
  BLE, treats a fresh sign check-in as an exact fix, grows the radius while a phone is quiet, and sends everyone
  `{ type: "positions", positions }` once a second. Bots wander between GPS-tagged signs so the map isn't empty.

## API

| | |
| --- | --- |
| `GET /health` | `{ ok, games, store }` |
| `POST /games` `{ name, mapId? }` | create lobby; caller is host → `{ code, playerId, token }` |
| `POST /games/:code/join` `{ name }` | → `{ code, playerId, token }` |
| `POST /photos` `{ jpegBase64 }` | sign reference photo → `{ photoId }` |
| `GET /photos/:id.jpg` | photo bytes |
| `GET /gamesets` | saved games `[{ id, name, signs, updatedAt }]`, newest first |
| `GET /gamesets/:id` | a saved game with its signs |
| `POST /gamesets/check` `{ password }` | checks the gameset password |
| `POST /gamesets` `{ password, name }` | creates a saved game |
| `POST /gamesets/:id/stations` `{ password, name, kind, lat?, lng?, signText?, photoId? }` | adds a sign |
| `POST /gamesets/:id/stations/:stationId/delete` `{ password }` | removes a sign |
| `POST /gamesets/:id/rename` / `delete` `{ password, name? }` | renames / deletes a saved game |
| `POST /games/:code/gameset` `{ playerId, token, gamesetId \| null }` | any player uses a saved game in the lobby (or none) |
| `WS /ws?code&playerId&token` | client → `{ id, action, payload }`; server → `ack`, `state` (per-player snapshot), `event`, `positions` (live map, when on) |

Actions and the state machine live in `src/game.ts` (`Game.handle`, `Game.viewFor`).
Each player receives a distinct server-assigned suit color when joining. The color is included in
player views and stored in the live-game snapshot so reconnects and server restarts preserve it.
