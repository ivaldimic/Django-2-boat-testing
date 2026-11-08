# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based monitor for two sailboats' live NMEA data plus on-the-water
two-boat performance tests (VMG / VMC / TWA). Despite the repo name there is no
Django — it is plain JavaScript: a static web app at the repo root and three small
Node servers (`simulator/`, `bridge/`, `relay/`), each depending only on `ws`.
The tests are computed **server-side** by `testengine.js` (repo root), which all
three servers `require`; the app only sends commands and renders server state.

There is no build step, no linter, and no test suite. Verify changes by running
the dev environment and watching the app in a browser.

## Commands

```bash
node launcher.js                 # dev: installs deps if missing, starts simulator + bridge, opens http://localhost:8080
                                 # (same as double-clicking start-dev.command / start-dev.bat)
cd simulator && npm start        # two simulated boats on ws://localhost:8090 / :8091, control panel at http://localhost:8099
cd bridge && npm start           # serves the app over http + WebSocket on :8080, listens for Expedition UDP
PORT=10000 VIEW_TOKEN=v PUBLISH_TOKEN=p node relay/server.js   # cloud relay locally (needs `cd relay && npm install` first)
```

The servers `require('../testengine')`, so they need the whole repo, not just
their own folder.

Run `npm install` separately in each of `simulator/`, `bridge/` and `relay/`.

## Architecture

### Topologies (the app code is identical in all three)
```
Dev:    app ⇄ simulator (one ws port per boat)          ; bridge only serves the static app
Boat:   app ⇄ bridge on each boat PC (ws://boat-pc:8080) ⇄ Expedition over UDP
Cloud:  bridges --wss out--> relay (Render) <--wss out-- apps   (DEPLOY.md, render.yaml)
```
The test engine runs wherever both boats are visible: the simulator, the relay
(one `TestHub` per room), or a bridge whose config has `peer` (the other bridge's
ws URL, which it reads with `?peer=1`). A bridge without a peer runs no engine.
The app holds **one WebSocket per boat**. Boat URLs come from `config.js`
(`window.DEFAULT_BOATS`, which point at the simulator), get overridden in the
Settings drawer (saved in localStorage), or are generated from URL params
(`?role=&room=&token=&relay=`, see `applyCloudParams()` in `app.js`), which builds
`<relay>/ws?role=view&room=…&token=…&boat=1|2`.

### Wire protocol (shared by all components)
- **Raw text lines** go from boat to app, either Expedition format
  (`#<boat>,<ch>,<val>,…*CS`, the default) or NMEA 0183. The bridge checks the
  Expedition checksum and keeps only one Expedition boat per client
  (`expeditionBoat` in config, or `?exp=N` on the ws URL). Parsing lives in
  `feedparse.js`, which the app and the engine share:
  `parseExpedition` maps core channels (`EXP_CORE`) onto the usual `live` keys
  and stores every other channel as `live.x<ch>`. `parseNMEA` handles RMC/GLL,
  HDT, MWD, MWV, VHW, XDR(ROLL), RSA.
- `kind: 'channels'` (boat → app): the channel names from Expedition's
  `channels.xml`. The bridge and simulator send it on connect, and the relay
  caches it per boat to prime late viewers. The app keeps it in localStorage
  (`boat-receiver:expchannels:v1`); dashboard strips use ids like `x22`.
- **JSON control messages** carry `{ctl: 1, kind: …}`. Any frame starting with `{`
  is checked for these first.
  - `kind: 'testcmd'` (app → server): `op` is `start` | `stop` | `trim` |
    `save` | `discard` | `snapshot`. `ref: 'self'|'other'` and the order of
    `names` are relative to the connection the command came in on.
  - `kind: 'hello'` / `'test'` / `'sep'` / `'result'` / `'history'` (server →
    apps): every one carries `you`, the engine boat index (0/1) of that
    connection, so the app can map the server's boats to its own (`srvMap`).
    `test` broadcasts carry `boot` + `seq` and series **deltas**
    (`series.from` + rows `[x, primary, up, fwd]`). The app drops old or
    duplicate seqs (it gets each one once per connection) and asks for a
    `snapshot` when there is a gap.
  - `kind: 'waypoint'` (engine → a boat): created by the engine. The relay routes
    it to that boat's publisher. The bridge turns it into an `ECWPL` sentence and
    sends it over UDP to `config.expedition.host:port`, or forwards it to its peer
    bridge for the other boat.
- The servers no longer forward client messages to other clients.
- If you change the message shapes, update `app.js`, `testengine.js`,
  `bridge/bridge.js`, `simulator/simulator.js` and `relay/server.js` together.

### Server-side tests
`testengine.js` (`TestHub`) owns the test: sampling (gains at 1 Hz, averages of
every channel at 2 Hz), waypoint creation, auto-complete at the duration, trim,
the saved result row, and an in-memory history that it replays to new clients.
Every second it also broadcasts the boat separation (`sep`: range plus the
bearing each way). The master and the viewers render the same state.
`sendTestCmd` only sends commands in the master role. Gains are relative to engine
boat 0. The per-user reference flip happens in the app via `test.antisym`
(primary and fwd always flip, up only for VMG). Keep that consistent with
`computeGains()`.

### Web app files
Plain `<script>` tags in `index.html`, loaded in this order with no modules:
`config.js` → `sailmath.js` → `feedparse.js` → `charts.js` → `trackmap.js` →
`app.js`. They share globals (`SailMath`, `FeedParse`, `LineChart`/`StripChart`,
`TrackMap`).
- `sailmath.js`, `feedparse.js`: UMD wrappers (browser global + Node `require`),
  also used by `testengine.js`. Angles in degrees, speeds in knots, distances in
  metres. `TWA = COG − TWD`, `VMG = SOG·cos(TWA)`.
- `charts.js` and `trackmap.js`: canvas renderers with no dependencies. The app
  must keep working **offline** on a nav PC: no CDNs and no map tiles.
- `app.js`: one large file split by `/* ---------- section ---------- */`
  banners (connections, dashboard, roles, settings, tests, server messages,
  test view, history). All state lives in a single `state` object.
  `state.test` mirrors the server's test.
  Persistence uses localStorage keys `boat-receiver:*:v1` (boats, role, strips,
  window, history).
- The gain definitions (VMG advantage on the TWD axis, average-path FWD/BACK and
  UP/DOWN, the upwind/downwind sign flip, VMC/TWA waypoint geometry) are specified
  in `README.md` and implemented in `computeGains()` in `testengine.js`. Keep the
  two consistent.

### Servers
- `bridge/bridge.js` reads `bridge/config.json` (`udpPort`, `port`, `serveWebApp`,
  `expedition`, optional `relay` uplink, optional `peer` for LAN tests). It serves the repo root as static files
  and fans UDP lines out to LAN WebSocket clients and to the relay uplink.
  Expedition uses "Tx on port + 1", so the bridge listens on 5556 and sends
  waypoints to 5555. `config.json` holds these values.
- `simulator/simulator.js` reads `simulator/config.json` (per-boat port and start
  state, wind, `updateHz`, `controlPort`) and sends checksummed NMEA.
- `relay/server.js` (deployed on Render via `render.yaml`) serves the app plus
  `/health` and runs `/ws` with rooms. Publishers (`role=pub`, `PUBLISH_TOKEN`)
  and viewers (`role=view`, `VIEW_TOKEN`) are keyed by `room` and `boat`. It
  caches each boat's last message to prime new viewers, and runs one `TestHub`
  per room (boat `1` is engine boat 0, boat `2` is engine boat 1).
