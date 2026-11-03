'use strict';

/*
 * Expedition UDP -> WebSocket bridge
 * ---------------------------------
 * Runs on the same PC as Expedition (one per boat). It:
 *   1. listens for the UDP data Expedition sends to this machine (Expedition's
 *      own "#boat,channel,value,…" format, or NMEA 0183), and
 *   2. re-serves that data as a WebSocket the web app can connect to, together
 *      with the channel names from Expedition's channels.xml.
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
const url = require('url');
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
// Which Expedition boat to forward (#0 = own boat, #1.. = other boats Expedition
// knows about). A client can pick another one with ?exp=N on its ws:// URL.
const defaultExpBoat = config.expeditionBoat == null ? '0' : String(config.expeditionBoat);

// ---- Expedition channel definitions (channels.xml) -------------------------
// Expedition's own data format sends channels by number; the names come from
// Expedition's channels.xml. Point `channelsFile` at the boat's copy so user
// channels (User 0..31) get their configured names.
const CHANNELS_PATH = path.resolve(__dirname, config.channelsFile || 'channels.xml');
function loadChannels(file) {
  let xml;
  try { xml = fs.readFileSync(file, 'utf8'); }
  catch (_) { console.warn(`No channel definitions at ${file} — the app will show channel numbers.`); return []; }
  const out = [];
  for (const m of xml.matchAll(/<channel\b([^>]*)\/?>/g)) {
    const a = {};
    for (const am of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[am[1]] = am[2];
    const id = parseInt(a.id, 10);
    if (!Number.isFinite(id) || !a.name) continue;
    const ch = { id, name: a.user || a.name };   // a user channel's own name beats "User 7"
    if (a.prec != null && a.prec !== '') ch.prec = +a.prec;
    out.push(ch);
  }
  console.log(`Loaded ${out.length} Expedition channel definitions from ${file}`);
  return out;
}
const channelsMsg = JSON.stringify({ ctl: 1, kind: 'channels', channels: loadChannels(CHANNELS_PATH) });

// ---- Expedition data lines --------------------------------------------------
// "#<boat>,<ch>,<value>,<ch>,<value>,…*<checksum>". The checksum is the XOR of
// every character from '#' up to '*'. Anything else (NMEA) is passed through as-is.
function expChecksumOk(line) {
  const star = line.lastIndexOf('*');
  if (star < 0) return true;                                // checksum is optional
  let c = 0; for (let i = 0; i < star; i++) c ^= line.charCodeAt(i);
  return c === parseInt(line.slice(star + 1, star + 3), 16);
}
let badChecksums = 0;
// Split a UDP datagram into { boat, line } items ('' boat = NMEA, goes to everyone).
function decodeDatagram(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '#') {
      if (!expChecksumOk(line)) { badChecksums++; continue; }
      out.push({ boat: line.slice(1, line.indexOf(',')), line });
    } else {
      out.push({ boat: '', line });
    }
  }
  return out;
}
// Join the lines of one datagram meant for a given Expedition boat.
function linesFor(items, expBoat) {
  const sel = items.filter((it) => it.boat === '' || it.boat === expBoat).map((it) => it.line);
  return sel.length ? sel.join('\r\n') + '\r\n' : '';
}

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
  const q = url.parse(req.url || '/', true).query;
  ws.expBoat = q.exp != null && q.exp !== '' ? String(q.exp) : defaultExpBoat;
  console.log(`Web app connected from ${req.socket.remoteAddress}, Expedition boat #${ws.expBoat} (${wss.clients.size} connected)`);
  ws.send(channelsMsg);
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

function broadcast(items) {
  const cache = new Map();   // expBoat -> text, so each selection is built once
  for (const client of wss.clients) {
    if (client.readyState !== 1 /* OPEN */) continue;
    if (!cache.has(client.expBoat)) cache.set(client.expBoat, linesFor(items, client.expBoat));
    const text = cache.get(client.expBoat);
    if (text) client.send(text);
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
  const items = decodeDatagram(buf.toString('utf8'));
  if (!items.length) return;
  broadcast(items);                                    // LAN clients
  const up = linesFor(items, uplinkExpBoat);
  if (up) uplinkSend(up);                              // cloud relay (if configured)
});
setInterval(() => {
  if (badChecksums) { console.warn(`Dropped ${badChecksums} Expedition line(s) with a bad checksum in the last minute.`); badChecksums = 0; }
}, 60000);

udp.on('error', (err) => console.error(`UDP error: ${err.message}`));
udp.on('listening', () => {
  try { udp.setBroadcast(true); } catch (_) {}
});
udp.bind(udpPort);

// ---- Optional cloud uplink (for boats on separate Starlink/5G networks) ----
// Configure `relay` in config.json: { "url":"wss://host", "room":"team",
// "token":"<PUBLISH_TOKEN>", "boat":"1" }. The bridge connects OUTBOUND to the
// relay, pushes this boat's data up, and forwards any waypoint it receives to
// Expedition — no inbound ports or port-forwarding needed. Optional
// "expeditionBoat" picks which Expedition boat (#N) goes up (default as above).
let uplink = null;
const uplinkExpBoat = config.relay && config.relay.expeditionBoat != null ? String(config.relay.expeditionBoat) : defaultExpBoat;
function uplinkSend(text) { if (uplink && uplink.readyState === 1) { try { uplink.send(text); } catch (_) {} } }
function startUplink() {
  const rc = config.relay;
  if (!rc || !rc.url) return;
  const base = String(rc.url).replace(/^http/, 'ws').replace(/\/+$/, '');
  const wsUrl = `${base}/ws?role=pub&room=${encodeURIComponent(rc.room || 'default')}&boat=${encodeURIComponent(rc.boat || '1')}&token=${encodeURIComponent(rc.token || '')}`;
  const connect = () => {
    console.log(`Uplink: connecting to relay as boat ${rc.boat || '1'} …`);
    uplink = new WebSocket(wsUrl);
    uplink.on('open', () => { console.log('Uplink: connected to cloud relay.'); uplinkSend(channelsMsg); });
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
  console.log(`  1. In Expedition (UDP network on 127.0.0.1:5555, Expedition format), tick "Tx on port + 1" so it transmits on ${udpPort}.`);
  console.log(`     (Waypoints are sent back to Expedition on ${exp.port || '<set expedition.port>'}.)`);
  console.log(`  2. In the web app, set this boat's address to:`);
  for (const ip of ips) console.log(`         ws://${ip}:${port}`);
  if (serveWebApp) {
    console.log('  3. Or just open the app in a browser at:');
    for (const ip of ips) console.log(`         http://${ip}:${port}`);
  }
  console.log('');
  console.log('  Waiting for data…  (Ctrl+C to stop)');
});
