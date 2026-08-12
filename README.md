# Boat data receiver

Live navigation data from two boats in one browser-based monitor (PC, Mac, iPad,
iPhone), plus on-the-water performance tests. Built to develop on a laptop
against a simulator, then deploy unchanged to the nav PCs.

## The three pieces

- **Web app** (repo root) — the monitor and the tests. Static HTML/JS, no build,
  works offline.
- **`simulator/`** — a two-boat NMEA simulator for developing on this computer.
  See `simulator/README.md`.
- **`bridge/`** — the on-boat server: reads Expedition's UDP and re-serves it as a
  WebSocket, and serves the app over http. See `bridge/README.md`.

The app connects the same way to the simulator or to the bridges, so nothing in
the app changes between the desk and the boat.

```
Develop:  app  ⇄  simulator (ws://localhost:8090 / :8091)
Deploy:   app  ⇄  bridge on each boat (ws://boat-pc:8080)  ⇄  Expedition (UDP)
```

## Develop on this computer

```bash
cd simulator && npm install && npm start      # streams two boats
```

Then open the app over http (needed so the browser will allow ws://):

```bash
# from the repo root, in another terminal
python3 -m http.server 8000
# open http://localhost:8000
```

Both boats should read **Live**. (The app defaults to the simulator's two ports.)

## Using the app

1. **Pick a role.** The first screen asks master or viewer. The **master** runs
   the tests; **viewers** watch. Change it later in Settings.
2. **Check connections.** The bar under the title shows each boat Live / No data /
   Offline with its data rate. Settings has the same plus the raw stream.
3. **Run a test.** Three buttons top-left:
   - **VMG test** — prompts for a duration (default 5 min), then goes live with:
     - **VMG now** (kn) per boat — speed made good to windward,
     - **↑ windward** (m) — distance made good to windward (∫VMG dt),
     - **sailed** (m) — distance over ground (∫SOG dt),
     - **VMG/min** (m) — windward metres per minute,
     - **Windward gain (B1 − B2)** — how much boat 1 is gaining on boat 2,
     - and two live plots (VMG and cumulative windward distance).
     It auto-stops at the duration; **Stop** ends it early; **Close** returns.
   - **VMC test / TWA test** — buttons are in place; the calculations aren't built
     yet (VMC needs a target bearing/mark). Tell me the definitions and they fill
     in.

### Metric definitions (so we agree on the maths)

`TWA = COG − TWD`. `VMG = SOG·cos(TWA)` (positive upwind, negative downwind).
Distances integrate over the test: windward = ∫VMG dt, sailed = ∫SOG dt.

## Deploy to the boats

Per boat PC: install the `bridge/`, point Expedition's UDP at it, and run it (see
`bridge/README.md`). Then in the app's **Settings**, set the two boats to each
bridge's address, e.g. `ws://192.168.1.101:8080` and `ws://192.168.1.102:8080`.

## Known next step: master → viewer sync

Right now the role is per device: a viewer's screen does not yet mirror the
master's running test, because that needs a shared control channel (the master's
start/stop/duration relayed to viewers). The bridge/simulator can carry it — say
the word and I'll add it so viewers follow the master automatically.

## Add to the git repo

```bash
git init
git add .
git commit -m "Boat data receiver: app + simulator + Expedition bridge"
git branch -M main
git remote add origin https://github.com/<owner>/Django-2-boat-testing.git
git push -u origin main
```

`node_modules/` is gitignored; each person runs `npm install` in `simulator/`
and `bridge/` once.
