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

## Develop on this computer — one click

**macOS:** double-click **`start-dev.command`**.
**Windows:** double-click **`start-dev.bat`**.
**Any OS, from a terminal:** `node launcher.js`

It installs dependencies on first run, starts the simulator (two boats) and the
bridge (which serves the app over http), then opens the app in your browser at
`http://localhost:8080`. Both boats should read **Live**. Press **Ctrl+C** in that
window to stop everything.

> First time on macOS: if double-clicking is blocked because the file was
> downloaded, right-click `start-dev.command` → **Open** once to allow it. If it
> opens in an editor instead of running, run `chmod +x start-dev.command` once (or
> just use `node launcher.js`).

Why both the simulator and the bridge in dev? The bridge is what serves the app
over http (its job on the boat too); the simulator supplies the boat data in
place of Expedition. On the boats it's the mirror image — real data through the
bridge, no simulator.

### Manual alternative

```bash
cd simulator && npm install && npm start        # terminal 1: the two boats
cd bridge && npm install && npm start           # terminal 2: serves the app
# then open http://localhost:8080
```

## Using the app

1. **Pick a role.** The first screen asks master or viewer. The **master** runs
   the tests; **viewers** watch. Change it later in Settings.
2. **Check connections.** The bar under the title shows each boat Live / No data /
   Offline with its data rate. Settings has the same plus the raw stream.
3. **Run a test.** Three buttons top-left:
   - **VMG test** — prompts for a duration (default 5 min), then monitors four
     gains between the two boats, all measured from the **Start** button. Pick the
     **reference** boat; every gain is that boat relative to the other, and
     switching reference just flips the signs. Definitions (as supplied):
     - **TWD used** — the average of both boats' TWD from the start of the test to
       now (shown in the header).
     - **VMG advantage** = the distance between the two boats' positions projected
       on the TWD axis. **VMG gain** = VMG advantage now − VMG advantage at the
       start.
     - **VMG gain / min** = VMG gain ÷ elapsed minutes.
     - **Average path** = the line from the midpoint between the two boats at the
       start to the midpoint now. **FWD/BACK** = boat separation projected along
       the average path; **UP/DOWN** = separation projected on its perpendicular
       (windward positive).
     - **FWD/BACK gain** and **UP/DOWN gain** = each distance now minus its value
       at the start.
     - Equivalently, all three gains are the relative displacement (reference boat
       minus other, from the start) projected onto the TWD axis, the average-path
       axis, and its perpendicular. Two plots show VMG gain and the UP/DOWN &
       FWD/BACK gains over the run. Auto-stops at the duration; **Stop** ends
       early; **Close** returns.
   - **VMC test / TWA test** — buttons are in place; the calculations aren't built
     yet (VMC needs a target bearing/mark). Tell me the definitions and they fill
     in.
4. **Live dashboard** (always on the main page, for master and viewers alike):
   - **Range & bearing** between the two boats, in metres and degrees true
     (boat 1 → boat 2), updated continuously.
   - **Track plot** — a north-up, equal-scale local plot of both boats with their
     tracks, a dashed range line, a heading tick per boat, a north arrow and a
     scale bar. It auto-zooms to keep both boats in view. It's offline (no map
     tiles); if you later want a geographic basemap where there's signal, that can
     be added.
   - **Strip charts** — the last 2 minutes of **BS, COG, TWA, HEEL, RUDDER, TWD,
     TWS**, one trace per boat, with each boat's current value in the header. TWA
     is derived from COG and TWD. Wrapping channels (COG/TWD) break cleanly at
     360/0 instead of drawing a false spike.

The simulator now also sends boat speed (`VHW`), heel (`XDR/ROLL`) and rudder
(`RSA`) so all six strips have data on the desk. On a real boat these come from
Expedition if it's outputting them; any channel Expedition doesn't send simply
shows no trace.

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
