# Two-boat simulator

Stands in for the two on-boat bridges so you can build the app on this computer
with no boats and no Expedition. It serves one WebSocket per boat and streams
realistic NMEA for two boats close-hauled and slowly diverging.

## Run

```bash
cd simulator
npm install      # first time only
npm start
```

It prints the addresses to use:

```
  Boat 1: ws://localhost:8090
  Boat 2: ws://localhost:8091
```

The app already defaults to these two, so with the simulator running you can just
open the app and both boats go **Live**.

## Configure the scenario — `config.json`

```json
{
  "updateHz": 2,
  "wind": { "tws": 12.0, "twd": 0 },
  "boats": [
    { "port": 8090, "name": "Boat 1", "lat": 43.4325, "lon": 13.7542, "cog": 42, "hdg": 40, "sog": 6.6 },
    { "port": 8091, "name": "Boat 2", "lat": 43.4327, "lon": 13.7545, "cog": 46, "hdg": 44, "sog": 6.4 }
  ]
}
```

- **wind.tws / wind.twd** — true wind speed (kn) and direction (°).
- Per boat: starting **lat/lon**, **cog** (course), **hdg** (heading), **sog** (speed, kn).

The defaults put both boats on a starboard beat: Boat 1 lower and faster, Boat 2
higher and slower, so they diverge and Boat 1 makes slightly better VMG — a
normal two-boat line-up. A gentle random walk keeps the numbers alive so the
plots move. Each boat sends `RMC` (position, SOG, COG), `HDT` (heading), and
`MWD` (TWD, TWS) with valid checksums.

## Emit downwind / other angles

Set `twd` and the boats' `cog` so the wind angle is what you want. Dead downwind
example: `twd: 0`, boats' `cog` near `180` — VMG then reads negative (running),
which the app shows correctly.
