# Expedition bridge

Runs on the **same PC as Expedition** (one per boat). It reads the UDP data
Expedition sends out and re-serves it as a WebSocket that the web app connects
to. It also serves the web app itself over http, so any device on the network
can open it with no extra hosting.

```
Expedition ──UDP tx 5556──► bridge ──ws://this-pc:8080──► web app
          (Expedition format)        (+ channel names from channels.xml)
test engine ──waypoint──► bridge ──UDP 5555──► Expedition
```

## Expedition network setup (important — avoids the UDP port clash)

Two programs on one PC can't both *open* the same UDP port, so Expedition and the
bridge must sit on **different ports**. Expedition's **"Tx on port + 1"** option
does exactly this: it receives on its network port and transmits on that port + 1.

In Expedition → the UDP **Network** connection:
- Connection **UDP**, Address **127.0.0.1**, Port **5555**
- tick **"Tx on port + 1"**  → Expedition transmits on **5556**, receives on **5555**
- Instruments: **Expedition** (Expedition's own data format), not NMEA 0183. See
  [Expedition data format](#expedition-data-format) below.

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

- **Instruments:** Expedition (the Expedition data format)
- **Connection:** *UDP to IP address* → address `127.0.0.1`, port `5555`, with
  **"Tx on port + 1"** ticked, so Expedition transmits on `5556` (matches
  `udpPort` in `config.json`)
- **OK** and save the Expedition settings.

NMEA 0183 output still works too (the bridge passes NMEA lines through
unchanged), but it only carries position, speed, wind, heading, heel and rudder.

Sending to `127.0.0.1` keeps the data on the local machine and straight into the
bridge. Plain "UDP" broadcast also works if you prefer.

## Open the web app

On each device (laptop, iPad, iPhone), open `http://<boat-pc-ip>:8080`. In
**Settings**, set the two boats' addresses to each boat PC's bridge, e.g.
`ws://192.168.1.101:8080` and `ws://192.168.1.102:8080`. The web app connects to
both at once, so it doesn't matter which boat's bridge served the page.

## Tests on the LAN — `peer`

The two-boat tests run on a server that sees **both** boats. With the cloud relay
that's the relay. On a LAN without it, give one bridge (or both) the other
boat's bridge as its `peer`:

```json
{ "udpPort": 5556, "port": 8080, "serveWebApp": true,
  "expedition": { "host": "127.0.0.1", "port": 5555 },
  "peer": "ws://192.168.1.102:8080" }
```

That bridge then reads the other boat's data as well, runs the tests for the apps
connected to it, and sends each test waypoint to the right boat: to its own
Expedition directly, and to the other boat through the peer bridge. It prints
`Peer: reading the other boat from …` once connected. A bridge without a peer
tells the apps it can't run tests, and they connect to one that can.

## config.json

```json
{
  "udpPort": 5556,      // port Expedition transmits UDP on (its port + 1)
  "port": 8080,         // port the web app uses (both the http page and ws://)
  "serveWebApp": true,  // also serve the web app over http on the same port
  "expedition": {       // where test waypoints are sent (Expedition's receive port)
    "host": "127.0.0.1",
    "port": 5555
  },
  "expeditionBoat": 0,  // which Expedition boat (#N) to forward; 0 = own boat
  "channelsFile": "channels.xml",  // Expedition's channel definitions (names)
  "peer": "ws://192.168.1.102:8080"  // optional: the other boat's bridge, to run tests on the LAN
}
```

## Expedition data format

Expedition sends plain-text lines like

```
#0,1,6.54,2,-25.20,3,14.21,4,-39.70,5,12.00*1C
```

`#<boat>` comes first (`0` = own boat, `1`… = other boats Expedition knows
about). Then come `channel,value` pairs, and the line ends with a checksum: the
XOR of every character from `#` up to `*`, in hex. The bridge:

- drops lines with a bad checksum (it logs a count once a minute),
- forwards only the lines for `expeditionBoat` to each client. A client can ask
  for another boat by adding `?exp=N` to its address, e.g. `ws://192.168.1.101:8080/?exp=1`,
  so one Expedition that tracks both boats can feed both of them in the app,
- reads the channel names from `channelsFile` and sends them to each app when it
  connects (and to the cloud relay). Point `channelsFile` at the `channels.xml`
  of the Expedition install on this boat (absolute paths work) so user channels
  show their configured names (e.g. `PLC_JibCunLoad` for *User 7*). A copy
  of a sample `channels.xml` ships in this folder.

In the app, the core channels (BSP, AWA, AWS, TWA, TWS, TWD, HDG, Heel, Trim,
Rudder, Lat, Lon, COG, SOG) feed the tests as before. Every other channel
received can be added to or removed from the dashboard with **Channels…** above
the strip charts.

## Checks if no data shows up

- Expedition's **Raw data** window shows sentences going out (data exists).
- The bridge console prints `Receiving UDP from Expedition …` once the first
  packet arrives — if it never does, the Expedition UDP target/port is wrong.
- The web app panel shows **Live** but no values: check that Expedition sends the
  Expedition format (lines start with `#`) or NMEA 0183. The raw stream panel
  still confirms data is flowing.
- Values are missing for this boat but `#1,…` lines show up in Expedition's raw
  data: set `expeditionBoat` (or `?exp=N`) to the boat number you want.
- Another device can't connect: Windows Firewall is blocking the port, or the
  address/port in the app is wrong.
