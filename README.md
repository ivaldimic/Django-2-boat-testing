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
`http://localhost:8080`. Both boats should read **Live**. A simulator **control panel** (start/stop/restart,
change heading & wind) is at **http://localhost:8099**. Press **Ctrl+C** in that
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
   the tests; **viewers** watch and their screen **mirrors the master's running
   test** — start, stop, duration, waypoint, reference boat and trim all follow
   the master live (see "Master → viewer sync" below). Change it later in Settings.
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
     - **Upwind vs downwind** — the VMG axis points toward the wind upwind and
       *away* from the wind downwind (detected from the boats' overall track). So
       downwind the winner is the boat sailing more away from the wind, and the
       sign flips accordingly. The header shows `upwind`/`downwind`.
     - Two plots show VMG gain and the UP/DOWN & FWD/BACK gains over the run.
   - **VMC test** — creates **one waypoint** at the range/bearing you enter, from
     the **master (reference) boat's** start position (the *VMC waypoint*). The
     button prefills the reference boat's current heading and **20 nm**. **VMC
     gain** = the boat separation projected on the bearing to that waypoint, now
     minus at the start. **UP/DOWN** = the change in the *absolute* separation
     projected on the perpendicular of that bearing (grows → positive). No
     FWD/BACK for VMC.
   - **TWA test** — creates **two waypoints**, one per boat, each at the same
     range/bearing from **that boat's own** start position (*Target WP Master* and
     *Target WP Slave*). Prefills current heading and **2 nm**. **TWA gain** = how
     much closer the reference boat is to its waypoint than the other is to
     theirs (other's distance − reference's distance), now minus at the start.
     **UP/DOWN** as in VMC.
   - **Waypoints on screen and to Expedition.** For VMC and TWA the waypoint
     latitude/longitude is shown at the top of the test view ("VMC waypoint …",
     or "Waypoint <boat> …" per boat for TWA) and drawn as a diamond on the map.
     Each waypoint is also **sent to Expedition on the relevant boat** as a WPL
     sentence: the app pushes it to that boat's bridge, which forwards it over UDP.
     Set `"expedition": { "host": "127.0.0.1", "port": N }` in `bridge/config.json`
     to the host/port Expedition is configured to read NMEA input on (leave the
     port unset and the bridge just logs the waypoint).
   - **Stop, then review** — stopping a test lets you **trim** the last N seconds
     (e.g. if the boats bore away at the end) and recompute, then **Save** it to
     the history or **Discard** it.
   - The three test buttons are colour-outlined (VMG teal, VMC orange, TWA
     purple); in the viewer role they're visible but disabled.
4. **Live dashboard** (always on the main page, for master and viewers alike):
   - **Range & bearing** between the two boats, in metres and degrees true
     (boat 1 → boat 2), updated continuously.
   - **Track plot** — a north-up, equal-scale local plot of both boats with their
     tracks, a dashed range line, a heading tick per boat, a north arrow and a
     scale bar. It auto-zooms to keep both boats in view. Zoom with the wheel, pinch or the +/−/⤢ buttons (drag to pan; Fit resets); test waypoints show as diamonds. It's offline (no map
     tiles); if you later want a geographic basemap where there's signal, that can
     be added.
   - **Strip charts** — one trace per boat, with each boat's current value in the
     header and its **average since the test started** in a box beside the chart.
     Add or remove strips with **+ Add** / the **×** on each, choosing from the
     variables in the feed (SOG, BS, COG, HDG, TWA, AWA, TWD, TWS, AWS, HEEL,
     RUDDER, PITCH). The **time window** (1 / 5 / 10 / 20 min) is selectable at the
     top. Your choice of strips and window is saved on the device.
5. **Test history** — at the bottom of the page, one row per saved test: date &
   time, type (VMG/VMC/TWA), duration, winner, gain rate, FWD/BACK, UP/DOWN, and
   the whole-test averages of **BS, TWS, TWD, HDG, COG, SOG, HEEL, RUDDER**, each
   shown as the two boats by **colour** (a legend maps colour to boat name). **Export CSV** downloads everything (each average as a
   separate per-boat column); **Clear** empties the history. Stored on the device.

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

## Master → viewer sync

Viewers mirror the master's test automatically. The master broadcasts the test
state — type, start time, duration, reference boat, waypoint(s), running/stopped
and trim — as small JSON control messages over the **same boat WebSockets**. The
bridge (and the simulator) **relay** each client's message to the other connected
clients, so viewers receive it. Each viewer then reconstructs the test in mirror
from its **own** identical boat feed plus those parameters, so only the light
parameters travel, not the full sample stream.

A viewer's test view is read-only: the Stop/Trim/Save/Discard controls and the
reference switch are hidden or disabled, and it follows the master's Stop, trim
and Close. The master re-sends the state every ~1.5 s as a heartbeat, so a viewer
that joins after a test has started still catches up; if the master's sync goes
silent for a few seconds the viewer drops the mirrored test. This needs every
client to share at least one bridge (normally all connect to both boats), and the
bridge/simulator relay to be running (both included here).

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
