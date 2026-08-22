# Deploying to the cloud (Render) — two boats on separate networks

This lets the two boats sit on **separate Starlink/5G networks**, one running as
**master**, and viewers connect from the **dinghy over 5G** or from **home,
hundreds of km away** — with just a link, no software to install.

Everything connects **outbound** to one small cloud server (the *relay*), so
Starlink CGNAT, 5G and home firewalls are not a problem. The relay also **serves
the web app**, so there is a single URL for everything. Waypoints for VMC/TWA
tests travel back down through the relay to each boat's Expedition.

```
 Boat 1 (Starlink)                              Boat 2 (Starlink)
 Expedition ⇄ bridge ──(wss out)──┐   ┌──(wss out)── bridge ⇄ Expedition
                                  ▼   ▼
                        ┌──────────────────────┐
                        │  RENDER: relay + app │   https://…onrender.com  (TLS)
                        └──────────────────────┘
                          ▲          ▲         ▲
                (wss out) │          │         │ (wss out)
                    Master(boat)  Viewer(5G)  Viewer(home)
```

## What you need
- The repo pushed to GitHub (done).
- A free Render account (https://render.com).
- On each boat: Node.js installed and Expedition running.

---

## 1) Deploy the relay + app on Render

**Option A — Blueprint (one click):**
1. Render dashboard → **New +** → **Blueprint** → connect your GitHub repo.
2. Render reads `render.yaml` and creates a web service called **boat-relay**.
   Click **Apply**. First build takes a couple of minutes.
3. When it's live you get a URL like **`https://boat-relay-xxxx.onrender.com`**.
4. Open the service → **Environment**. You'll see two generated secrets:
   **`VIEW_TOKEN`** and **`PUBLISH_TOKEN`**. Copy both (you can also replace them
   with your own values — click Save to redeploy).

**Option B — Manual (if you prefer):**
1. **New +** → **Web Service** → connect the repo.
2. Environment **Node**; Build Command `cd relay && npm install`; Start Command
   `node relay/server.js`; Health Check Path `/health`; Plan Free.
3. Add environment variables `VIEW_TOKEN` and `PUBLISH_TOKEN` (any long random
   strings you choose). Create the service.

> Free services **spin down after ~15 min idle** and cold-start (~1 min) on the
> next connection. The always-on bridges keep it warm; for race-day reliability
> switch the plan to **Starter** ($7/mo).

Check it works: open `https://boat-relay-xxxx.onrender.com/health` → shows `ok`,
and the root URL shows the app.

---

## 2) Configure each boat (bridge → cloud)

On **each** boat PC (the one running Expedition):

1. **Expedition output** (unchanged): send NMEA out via **UDP to `127.0.0.1`
   port `5555`**.
2. **Expedition input** (for receiving the test waypoints): set Expedition to
   **read incoming NMEA on a UDP port**, e.g. `5556`.
3. Edit **`bridge/config.json`** on that boat:

   Boat 1:
   ```json
   {
     "udpPort": 5555,
     "port": 8080,
     "serveWebApp": true,
     "expedition": { "host": "127.0.0.1", "port": 5556 },
     "relay": {
       "url": "wss://boat-relay-xxxx.onrender.com",
       "room": "team",
       "token": "PASTE_PUBLISH_TOKEN_HERE",
       "boat": "1"
     }
   }
   ```
   Boat 2: identical, but `"boat": "2"`.

   Use the **same `room`** on both boats and in the viewer links. Use the
   **`PUBLISH_TOKEN`** here (never the view token).
4. Start the bridge: `cd bridge && npm install && npm start`.
   You should see `Uplink: connected to cloud relay.`

That's all each boat needs — it pushes its data up and receives its waypoints
back down, all over one outbound WSS connection.

---

## 3) The master

On the **master boat**, open the app in a browser at:

```
https://boat-relay-xxxx.onrender.com/?role=master&room=team&token=PASTE_VIEW_TOKEN
```

It opens straight into **master** mode, connected through the cloud. Run VMG/VMC/
TWA tests as usual; the VMC/TWA waypoints are sent down to **both** boats'
Expedition automatically.

---

## 4) Viewers (dinghy, home) — just a link

Send anyone this single link (phone, tablet or laptop; 5G or home internet):

```
https://boat-relay-xxxx.onrender.com/?role=viewer&room=team&token=PASTE_VIEW_TOKEN
```

They open it and immediately see the live dashboard and **mirror the master's
running test** — no install, no settings. Tip: on a phone, "Add to Home Screen"
makes it feel like an app.

> Want an easy-to-type address instead of the `onrender.com` name? In Render →
> service → **Settings → Custom Domains**, add e.g. `boats.yourdomain.com`
> (Render issues the TLS certificate). Then the link becomes
> `https://boats.yourdomain.com/?role=viewer&room=team&token=…`.

---

## Security

- **TLS everywhere:** Render serves the app and the relay over HTTPS/WSS, so all
  traffic is encrypted.
- **Two secrets:** boats authenticate with `PUBLISH_TOKEN` (publish rights);
  apps use `VIEW_TOKEN` (read/mirror only). Only the boats can inject data.
- The **view token lives in the viewer link** — treat the link as the password.
  To revoke, change `VIEW_TOKEN` in Render (redeploys in ~1 min); reshare the new
  link. Same for `PUBLISH_TOKEN` on the boats.
- Use a distinct **`room`** per team if you ever share one relay across teams.

---

## Hybrid (optional): fast LAN on board, cloud for the rest

The bridge still serves the app on the boat's LAN (`http://<boat-ip>:8080`) and
relays LAN clients directly. On board you can use that for lowest latency; the
cloud relay is what makes the **other boat**, the **dinghy** and **home** work.
Because each device's connection URLs are independent, some can be local and
others cloud at the same time.

## Data volumes

NMEA is tiny (a few hundred bytes/second per boat), so 5G/Starlink and the free
relay handle it comfortably; latency over the internet is well under a second for
a monitoring dashboard.
