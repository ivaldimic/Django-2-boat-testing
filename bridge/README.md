# Expedition bridge

Runs on the **same PC as Expedition** (one per boat). It reads the UDP data
Expedition sends out and re-serves it as a WebSocket that the web app connects
to. It also serves the web app itself over http, so any device on the network
can open it with no extra hosting.

```
Expedition ──UDP tx 5556──► bridge ──ws://this-pc:8080──► web app
web app ──waypoint──► bridge ──UDP 5555──► Expedition
```

## Expedition network setup (important — avoids the UDP port clash)

Two programs on one PC can't both *open* the same UDP port, so Expedition and the
bridge must sit on **different ports**. Expedition's **"Tx on port + 1"** option
does exactly this: it receives on its network port and transmits on that port + 1.

In Expedition → the UDP **Network** connection:
- Connection **UDP**, Address **127.0.0.1**, Port **5555**
- tick **"Tx on port + 1"**  → Expedition transmits on **5556**, receives on **5555**
- (in **NMEA 0183 settings**, enable RMC/GLL, HDT, MWD, MWV, VHW so the app gets
  position, heading, wind and boat speed)

The bridge then listens on **5556** (Expedition's transmit) and sends the test
waypoints back on **5555** (Expedition's receive) — matching `config.json`:

```json
{ "udpPort": 5556, "port": 8080, "serveWebApp": true,
  "expedition": { "host": "127.0.0.1", "port": 5555 } }
```

Because the two use different ports, **the start order no longer matters** — no
more "can't attach" if one is already running.

## Install (once per boat PC — Windows)

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. Copy this whole repo onto the boat PC.
3. Double-click **`start.bat`** in this `bridge` folder. On first run it installs
   dependencies, then starts. (Or from a terminal: `npm install` then `npm start`.)
4. The first time it runs, Windows asks whether to allow Node through the
   firewall — **allow it on Private networks**, or other devices won't be able
   to connect.

When it starts it prints the exact addresses to use, e.g.:

```
  2. In the web app, set this boat's address to:
         ws://192.168.1.101:8080
  3. Or just open the app in a browser at:
         http://192.168.1.101:8080
```

## Point Expedition at the bridge

In Expedition, open **Instruments** (Ctrl+I → *Serial and Network Ports*) and add
an outgoing connection:

- **Instruments:** NMEA 0183
- **Connection:** *UDP to IP address* → address `127.0.0.1`, port `5555`
  (matches `udpPort` in `config.json`)
- **NMEA 0183 settings:** tick the sentences to send (position, speed, wind,
  heading — or tick everything; the app shows all of it)
- **OK** and save the Expedition settings.

Sending to `127.0.0.1` keeps the data on the local machine and straight into the
bridge. Plain "UDP" broadcast also works if you prefer.

## Open the web app

On each device (laptop, iPad, iPhone), open `http://<boat-pc-ip>:8080`. In
**Settings**, set the two boats' addresses to each boat PC's bridge, e.g.
`ws://192.168.1.101:8080` and `ws://192.168.1.102:8080`. The web app connects to
both at once, so it doesn't matter which boat's bridge served the page.

## config.json

```json
{
  "udpPort": 5555,      // port Expedition sends UDP to on this PC
  "port": 8080,         // port the web app uses (both the http page and ws://)
  "serveWebApp": true   // also serve the web app over http on the same port
}
```

## Checks if no data shows up

- Expedition's **Raw data** window shows sentences going out (data exists).
- The bridge console prints `Receiving UDP from Expedition …` once the first
  packet arrives — if it never does, the Expedition UDP target/port is wrong.
- The web app panel shows **Live** but no decoded chips: the feed isn't standard
  NMEA 0183 — the raw stream still confirms data is flowing.
- Another device can't connect: Windows Firewall is blocking the port, or the
  address/port in the app is wrong.
