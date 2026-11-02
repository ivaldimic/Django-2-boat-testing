# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based monitor for two sailboats' live NMEA data plus on-the-water
two-boat performance tests (VMG / VMC / TWA). Despite the repo name there is no
Django — it is plain JavaScript: a static web app at the repo root and three small
Node servers (`simulator/`, `bridge/`, `relay/`), each depending only on `ws`.

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

Run `npm install` separately in each of `simulator/`, `bridge/` and `relay/`.

## Architecture

### Topologies (the app code is identical in all three)
```
Dev:    app ⇄ simulator (one ws port per boat)          ; bridge only serves the static app
Boat:   app ⇄ bridge on each boat PC (ws://boat-pc:8080) ⇄ Expedition over UDP
Cloud:  bridges --wss out--> relay (Render) <--wss out-- apps   (DEPLOY.md, render.yaml)
```
The app holds **one WebSocket per boat**. Boat URLs come from `config.js`
(`window.DEFAULT_BOATS`, which point at the simulator), get overridden in the
Settings drawer (saved in localStorage), or are generated from URL params
(`?role=&room=&token=&relay=`, see `applyCloudParams()` in `app.js`), which builds
`<relay>/ws?role=view&room=…&token=…&boat=1|2`.

### Wire protocol (shared by all components)
- **Raw text lines** go from boat to app, either Expedition format
  (`#<boat>,<ch>,<val>,…*CS`, the default) or NMEA 0183. The bridge checks the
  Expedition checksum and keeps only one Expedition boat per client
  (`expeditionBoat` in config, or `?exp=N` on the ws URL). The app's
  `parseExpedition` maps core channels (`EXP_CORE`) onto the usual `live` keys
  and stores every other channel as `live.x<ch>`. `parseNMEA` handles RMC/GLL,
  HDT, MWD, MWV, VHW, XDR(ROLL), RSA.
- `kind: 'channels'` (boat → app): the channel names from Expedition's
  `channels.xml`. The bridge and simulator send it on connect, and the relay
  caches it per boat to prime late viewers. The app keeps it in localStorage
  (`boat-receiver:expchannels:v1`); dashboard strips use ids like `x22`.
- **JSON control messages** carry `{ctl: 1, kind: …}`. Any frame starting with `{`
  is checked for these first.
  - `kind: 'waypoint'` (app → its boat): the bridge turns it into an `ECWPL`
    sentence and sends it over UDP to `config.expedition.host:port`. It is **not**
    relayed to other clients. The relay routes it only to the publisher for that
    connection's `boat`.
  - `kind: 'sync'` / `'result'` (master → viewers): the bridge, simulator and relay
    each **forward these to every other connected client**. Master/viewer
    mirroring depends on that forwarding.
- If you change the message shapes, update `app.js`, `bridge/bridge.js`,
  `simulator/simulator.js` and `relay/server.js` together.

### Master/viewer sync
Only the master runs tests. It re-broadcasts the light test parameters (type,
startTs, duration, refId, waypoints, running, trimSec) about every 1.5 s as a
heartbeat. Viewers rebuild the same test from their **own** boat feeds plus those
parameters (`applyRemoteSync`/`startRemoteTest`), and drop it when the heartbeat
stops. Sample streams are never sent between clients.

### Web app files
Plain `<script>` tags in `index.html`, loaded in this order with no modules:
`config.js` → `sailmath.js` → `charts.js` → `trackmap.js` → `app.js`. They share
globals (`SailMath`, `LineChart`/`StripChart`, `TrackMap`).
- `sailmath.js`: UMD wrapper (browser global + Node `require`). Angles in degrees,
  speeds in knots, distances in metres. `TWA = COG − TWD`, `VMG = SOG·cos(TWA)`.
- `charts.js` and `trackmap.js`: canvas renderers with no dependencies. The app
  must keep working **offline** on a nav PC: no CDNs and no map tiles.
- `app.js`: one large file split by `/* ---------- section ---------- */`
  banners (connections, NMEA parse, dashboard, roles, settings, test engine,
  sync, geometry, gains, history). All state lives in a single `state` object.
  Persistence uses localStorage keys `boat-receiver:*:v1` (boats, role, strips,
  window, history).
- The gain definitions (VMG advantage on the TWD axis, average-path FWD/BACK and
  UP/DOWN, the upwind/downwind sign flip, VMC/TWA waypoint geometry) are specified
  in `README.md` and implemented in `computeGains()`. Keep the two consistent.

### Servers
- `bridge/bridge.js` reads `bridge/config.json` (`udpPort`, `port`, `serveWebApp`,
  `expedition`, optional `relay` uplink). It serves the repo root as static files
  and fans UDP lines out to LAN WebSocket clients and to the relay uplink.
  Expedition uses "Tx on port + 1", so the bridge listens on 5556 and sends
  waypoints to 5555. `config.json` holds these values.
- `simulator/simulator.js` reads `simulator/config.json` (per-boat port and start
  state, wind, `updateHz`, `controlPort`) and sends checksummed NMEA.
- `relay/server.js` (deployed on Render via `render.yaml`) serves the app plus
  `/health` and runs `/ws` with rooms. Publishers (`role=pub`, `PUBLISH_TOKEN`)
  and viewers (`role=view`, `VIEW_TOKEN`) are keyed by `room` and `boat`. It
  caches each boat's last message to prime new viewers.
