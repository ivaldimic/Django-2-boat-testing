'use strict';

/*
 * Expedition UDP -> WebSocket bridge
 * ---------------------------------
 * Runs on the same PC as Expedition (one per boat). It:
 *   1. listens for the UDP data Expedition sends to this machine, and
 *   2. re-serves that data as a WebSocket the web app can connect to.
 *
 * It also serves the web app itself over http (from the repo root), so any
 * device on the network can just open http://<this-pc-ip>:<port> — and because
 * the page is served over http, it is allowed to open the ws:// connection.
 */

const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

// ---- Config ---------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = { udpPort: 5555, port: 8080, serveWebApp: true };
try {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch (_) {
  console.warn('No readable config.json found — using defaults (udpPort 5555, port 8080).');
}
const { udpPort, port, serveWebApp } = config;
// Where to send waypoints so Expedition receives them (Expedition must be set to
// read incoming NMEA on this host:port). Configure `expedition` in config.json.
const exp = Object.assign({ host: '127.0.0.1', port: 0 }, config.expedition || {});

// The web app lives in the repo root, one level up from this bridge folder.
const WEB_ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// ---- HTTP server (serves the web app, and hosts the WebSocket) ------------
const httpServer = http.createServer((req, res) => {
  if (!serveWebApp) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bridge running. Connect via WebSocket on this port.');
    return;
  }
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const filePath = path.join(WEB_ROOT, urlPath === '/' ? 'index.html' : urlPath);

  // Never serve anything outside the repo root.
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- WebSocket server (shares the http port) ------------------------------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  console.log(`Web app connected from ${req.socket.remoteAddress} (${wss.clients.size} connected)`);
  ws.on('message', (data, isBinary) => {
    const s = data.toString();
    if (s.startsWith('{')) {
      try {
        const m = JSON.parse(s);
        if (m && m.kind === 'waypoint' && Number.isFinite(m.lat) && Number.isFinite(m.lon)) {
          sendWaypointToExpedition(m); return;      // don't relay waypoints to other clients
        }
      } catch (_) {}
    }
    // Otherwise relay (master → viewer sync/result) to the OTHER clients.
    for (const c of wss.clients) if (c !== ws && c.readyState === 1) c.send(data, { binary: isBinary });
  });
  ws.on('close', () => console.log(`Web app disconnected (${wss.clients.size} connected)`));
});

// ---- Send a waypoint to Expedition as a WPL sentence over UDP --------------
function nmeaChecksum(body) {
  let c = 0; for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, '0');
}
function ddm(v, degWidth) {
  const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
  return `${String(d).padStart(degWidth, '0')}${m.toFixed(4).padStart(7, '0')}`;
}
function sendWaypointToExpedition(m) {
  if (!exp.port) { console.log(`waypoint ${m.name} ${m.lat.toFixed(5)},${m.lon.toFixed(5)} — set "expedition":{"port":N} in config.json to forward to Expedition`); return; }
  const name = String(m.name || 'WP').slice(0, 12).replace(/[^\w-]/g, '');
  const body = `ECWPL,${ddm(m.lat, 2)},${m.lat >= 0 ? 'N' : 'S'},${ddm(m.lon, 3)},${m.lon >= 0 ? 'E' : 'W'},${name}`;
  const sentence = `$${body}*${nmeaChecksum(body)}\r\n`;
  const sock = dgram.createSocket('udp4');
  sock.send(Buffer.from(sentence), exp.port, exp.host, (err) => {
    if (err) console.error(`waypoint send error: ${err.message}`);
    else console.log(`waypoint → Expedition ${exp.host}:${exp.port}  ${sentence.trim()}`);
    sock.close();
  });
}

function broadcast(text) {
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(text);
  }
}

// ---- UDP listener (data coming out of Expedition) -------------------------
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let firstPacket = true;

udp.on('message', (buf, rinfo) => {
  if (firstPacket) {
    firstPacket = false;
    console.log(`Receiving UDP from Expedition (${rinfo.address}:${rinfo.port}) — forwarding to the web app.`);
  }
  const text = buf.toString('utf8');
  broadcast(text);           // LAN clients
  uplinkSend(text);          // cloud relay (if configured)
});

udp.on('error', (err) => console.error(`UDP error: ${err.message}`));
udp.on('listening', () => {
  try { udp.setBroadcast(true); } catch (_) {}
});
udp.bind(udpPort);

// ---- Optional cloud uplink (for boats on separate Starlink/5G networks) ----
// Configure `relay` in config.json: { "url":"wss://host", "room":"team",
// "token":"<PUBLISH_TOKEN>", "boat":"1" }. The bridge connects OUTBOUND to the
// relay, pushes this boat's NMEA up, and forwards any waypoint it receives to
// Expedition — no inbound ports or port-forwarding needed.
let uplink = null;
function uplinkSend(text) { if (uplink && uplink.readyState === 1) { try { uplink.send(text); } catch (_) {} } }
function startUplink() {
  const rc = config.relay;
  if (!rc || !rc.url) return;
  const base = String(rc.url).replace(/^http/, 'ws').replace(/\/+$/, '');
  const wsUrl = `${base}/ws?role=pub&room=${encodeURIComponent(rc.room || 'default')}&boat=${encodeURIComponent(rc.boat || '1')}&token=${encodeURIComponent(rc.token || '')}`;
  const connect = () => {
    console.log(`Uplink: connecting to relay as boat ${rc.boat || '1'} …`);
    uplink = new WebSocket(wsUrl);
    uplink.on('open', () => console.log('Uplink: connected to cloud relay.'));
    uplink.on('message', (data) => {
      const s = data.toString();
      if (s.startsWith('{')) {
        try { const m = JSON.parse(s); if (m && m.kind === 'waypoint' && Number.isFinite(m.lat) && Number.isFinite(m.lon)) sendWaypointToExpedition(m); } catch (_) {}
      }
    });
    uplink.on('close', () => { console.log('Uplink: disconnected — retrying in 3s.'); setTimeout(connect, 3000); });
    uplink.on('error', (e) => console.log(`Uplink error: ${e.message}`));
  };
  connect();
}
startUplink();

// ---- Start ----------------------------------------------------------------
function lanIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out.length ? out : ['<this-pc-ip>'];
}

httpServer.listen(port, () => {
  const ips = lanIps();
  console.log('');
  console.log('  Expedition bridge is running on this PC.');
  console.log('');
  console.log(`  1. In Expedition, send UDP to  127.0.0.1  on port ${udpPort}`);
  console.log(`  2. In the web app, set this boat's address to:`);
  for (const ip of ips) console.log(`         ws://${ip}:${port}`);
  if (serveWebApp) {
    console.log('  3. Or just open the app in a browser at:');
    for (const ip of ips) console.log(`         http://${ip}:${port}`);
  }
  console.log('');
  console.log('  Waiting for data…  (Ctrl+C to stop)');
});
