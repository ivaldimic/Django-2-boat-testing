'use strict';

/*
 * Cloud relay + app host (deploy on Render as a Web Service).
 * -----------------------------------------------------------
 * One public HTTPS/WSS endpoint that:
 *   1. serves the static web app (from the repo root), and
 *   2. relays messages between boats (publishers) and apps (subscribers) so that
 *      boats on separate networks (Starlink/5G) and viewers anywhere can talk
 *      through the cloud — everyone connects OUTBOUND, so CGNAT/firewalls are
 *      not a problem.
 *
 * Connections identify themselves with query params on /ws:
 *   role=pub|view   room=<team>   boat=1|2   token=<secret>
 *   - publishers (boat bridges) push their boat's NMEA up and receive waypoint
 *     commands for their boat back down;
 *   - subscribers (apps) receive both boats' NMEA and exchange control (sync).
 *
 * Security: TLS is provided by Render on *.onrender.com (so the app uses wss://).
 * Two shared secrets gate access — PUBLISH_TOKEN (boats) and VIEW_TOKEN (apps) —
 * set as environment variables in the Render dashboard.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const VIEW_TOKEN = process.env.VIEW_TOKEN || '';
const PUBLISH_TOKEN = process.env.PUBLISH_TOKEN || '';

const WEB_ROOT = path.join(__dirname, '..');   // repo root holds index.html, app.js, …
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  const filePath = path.join(WEB_ROOT, p === '/' ? 'index.html' : p);
  if (!filePath.startsWith(WEB_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

// rooms: id -> { pubs: Map(boat -> Set(ws)), subs: Set(ws), last: Map(boat -> string) }
const rooms = new Map();
function getRoom(id) { let r = rooms.get(id); if (!r) { r = { pubs: new Map(), subs: new Set(), last: new Map() }; rooms.set(id, r); } return r; }

wss.on('connection', (ws, req) => {
  const q = url.parse(req.url, true).query;
  const roomId = String(q.room || 'default').slice(0, 64);
  const isPub = ['pub', 'publish', 'boat'].includes(String(q.role || 'view'));
  const boat = String(q.boat || '').slice(0, 8);
  const token = String(q.token || '');

  const okToken = isPub ? (PUBLISH_TOKEN && token === PUBLISH_TOKEN) : (VIEW_TOKEN && token === VIEW_TOKEN);
  if (!okToken) { try { ws.close(4001, 'bad token'); } catch (_) {} return; }

  const r = getRoom(roomId);
  ws._meta = { roomId, isPub, boat };

  if (isPub) {
    if (!r.pubs.has(boat)) r.pubs.set(boat, new Set());
    r.pubs.get(boat).add(ws);
    console.log(`pub connected room=${roomId} boat=${boat}`);
  } else {
    r.subs.add(ws);
    if (boat && r.last.has(boat)) { try { ws.send(r.last.get(boat)); } catch (_) {} }   // prime new viewer
    console.log(`sub connected room=${roomId} boat=${boat} (${r.subs.size} subs)`);
  }

  ws.on('message', (data, isBinary) => {
    const s = data.toString();
    if (isPub) {
      // boat NMEA -> cache + fan out to subscribers watching this boat
      r.last.set(boat, s);
      for (const sub of r.subs) if (sub.readyState === 1 && sub._meta.boat === boat) sub.send(data, { binary: isBinary });
      return;
    }
    // subscriber -> waypoint (route down to this connection's boat) or control (fan to other subs)
    if (s.startsWith('{')) {
      try {
        const m = JSON.parse(s);
        if (m && m.kind === 'waypoint') {
          const set = r.pubs.get(boat);
          if (set) for (const p of set) if (p.readyState === 1) p.send(data, { binary: isBinary });
          return;
        }
      } catch (_) {}
    }
    for (const sub of r.subs) if (sub !== ws && sub.readyState === 1) sub.send(data, { binary: isBinary });
  });

  ws.on('close', () => {
    if (isPub) { const set = r.pubs.get(boat); if (set) { set.delete(ws); if (!set.size) r.pubs.delete(boat); } }
    else r.subs.delete(ws);
    if (!r.subs.size && ![...r.pubs.values()].some((s) => s.size)) rooms.delete(roomId);
  });
  ws.on('error', () => {});
});

// Keep-alive ping so idle connections aren't dropped by proxies.
setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) { try { ws.ping(); } catch (_) {} } }, 30000);

server.listen(PORT, () => {
  console.log(`Relay + app on :${PORT}`);
  if (!VIEW_TOKEN || !PUBLISH_TOKEN) console.warn('WARNING: set VIEW_TOKEN and PUBLISH_TOKEN env vars — connections are rejected without them.');
});
