'use strict';

/*
 * Two-boat simulator
 * ------------------
 * Stands in for the two on-boat bridges while you develop the app on this
 * computer. It serves one WebSocket per boat (default ports 8090 and 8091) and
 * streams realistic NMEA for two boats close-hauled and slowly diverging, using
 * a configurable wind (TWS/TWD) and per-boat HDG/COG/speed.
 *
 * Point the web app's two boats at:  ws://localhost:8090  and  ws://localhost:8091
 */

const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// ---- Config ---------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = {
  updateHz: 2,
  wind: { tws: 12.0, twd: 0 },
  boats: [
    { port: 8090, name: 'Boat 1', lat: 43.4325, lon: 13.7542, cog: 42, hdg: 40, sog: 6.6 },
    { port: 8091, name: 'Boat 2', lat: 43.4327, lon: 13.7545, cog: 46, hdg: 44, sog: 6.4 },
  ],
};
try {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch (_) {
  console.warn('No readable config.json — using built-in defaults.');
}

const dtSec = 1 / (config.updateHz || 2);

// ---- Helpers --------------------------------------------------------------
function checksum(body) {
  let cs = 0;
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
  return cs.toString(16).toUpperCase().padStart(2, '0');
}
function sentence(body) {
  return `$${body}*${checksum(body)}`;
}
function fmtLat(lat) {
  const h = lat >= 0 ? 'N' : 'S';
  const a = Math.abs(lat);
  const deg = Math.floor(a);
  const min = (a - deg) * 60;
  return `${String(deg).padStart(2, '0')}${min.toFixed(4).padStart(7, '0')},${h}`;
}
function fmtLon(lon) {
  const h = lon >= 0 ? 'E' : 'W';
  const a = Math.abs(lon);
  const deg = Math.floor(a);
  const min = (a - deg) * 60;
  return `${String(deg).padStart(3, '0')}${min.toFixed(4).padStart(7, '0')},${h}`;
}
function utcStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.00`;
}
function utcDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}${p(d.getUTCMonth() + 1)}${String(d.getUTCFullYear()).slice(2)}`;
}
function wrap360(x) { return ((x % 360) + 360) % 360; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ---- Boat state + servers -------------------------------------------------
const KN_MS = 0.514444;
const boats = config.boats.map((b, i) => ({
  ...b,
  cog: b.cog, hdg: b.hdg, sog: b.sog,
  cogTarget: b.cog, sogTarget: b.sog,
  heelBase: b.heel != null ? b.heel : 22 + i * 2,
  heel: b.heel != null ? b.heel : 22 + i * 2,
  rudder: 0,
  phase: Math.random() * Math.PI * 2,
  t: 0,
  init: { lat: b.lat, lon: b.lon, cog: b.cog, hdg: b.hdg, sog: b.sog },
  wss: new WebSocketServer({ port: b.port }),
}));

let running = true;

boats.forEach((b) => {
  b.wss.on('connection', (ws) => {
    console.log(`${b.name}: app connected (${b.wss.clients.size} on port ${b.port})`);
    // Relay a client's message to the other clients on this boat (master → viewers sync).
    ws.on('message', (data, isBinary) => {
      for (const c of b.wss.clients) if (c !== ws && c.readyState === 1) c.send(data, { binary: isBinary });
    });
    ws.on('close', () => console.log(`${b.name}: app disconnected (${b.wss.clients.size} on port ${b.port})`));
  });
  b.wss.on('listening', () => console.log(`${b.name}: serving NMEA at ws://localhost:${b.port}`));
});

// ---- Simulation loop ------------------------------------------------------
function step(b) {
  b.t += dtSec;
  // Oscillate gently around the (controllable) targets so headings hold.
  b.cog = wrap360(b.cogTarget + (Math.random() - 0.5) * 1.5);
  b.sog = clamp(b.sogTarget + (Math.random() - 0.5) * 0.1, 0.5, 20);
  b.hdg = wrap360(b.cog - 2 + (Math.random() - 0.5) * 0.6);
  b.heel = b.heelBase + 2.2 * Math.sin(b.t * 0.25 + b.phase) + (Math.random() - 0.5) * 1.2;
  b.rudder = 2.0 * Math.sin(b.t * 0.6 + b.phase) + (Math.random() - 0.5) * 1.6;

  const distM = b.sog * 1852 / 3600 * dtSec;
  const cogRad = b.cog * Math.PI / 180;
  b.lat += (distM * Math.cos(cogRad)) / 111320;
  b.lon += (distM * Math.sin(cogRad)) / (111320 * Math.cos(b.lat * Math.PI / 180));
}

function restartBoats() {
  for (const b of boats) {
    b.lat = b.init.lat; b.lon = b.init.lon;
    b.cog = b.cogTarget = b.init.cog; b.sog = b.sogTarget = b.init.sog; b.hdg = b.init.hdg;
    b.t = 0;
  }
}

function emit(b) {
  if (!b.wss.clients.size) return;
  const now = new Date();
  const tws = config.wind.tws, twd = config.wind.twd;

  const rmc = sentence(`GPRMC,${utcStamp(now)},A,${fmtLat(b.lat)},${fmtLon(b.lon)},${b.sog.toFixed(1)},${b.cog.toFixed(1)},${utcDate(now)},,,A`);
  const hdt = sentence(`HEHDT,${b.hdg.toFixed(1)},T`);
  const twsMs = (tws * KN_MS).toFixed(1);
  const mwd = sentence(`WIMWD,${twd.toFixed(1)},T,${twd.toFixed(1)},M,${tws.toFixed(1)},N,${twsMs},M`);
  const bs = Math.max(0, b.sog - 0.1);
  const vhw = sentence(`VWVHW,,T,,M,${bs.toFixed(1)},N,${(bs * 1.852).toFixed(1)},K`);
  const xdr = sentence(`IIXDR,A,${b.heel.toFixed(1)},D,ROLL`);
  const rsa = sentence(`IIRSA,${b.rudder.toFixed(1)},A,,`);

  // Apparent wind = true wind (ground) minus boat velocity, expressed at the bow.
  const windToRad = (twd + 180) * Math.PI / 180;
  const wE = tws * KN_MS * Math.sin(windToRad), wN = tws * KN_MS * Math.cos(windToRad);
  const sogMs = b.sog * KN_MS, cogR = b.cog * Math.PI / 180;
  const relE = wE - sogMs * Math.sin(cogR), relN = wN - sogMs * Math.cos(cogR);
  const aws = Math.hypot(relE, relN) / KN_MS;
  const awFrom = (Math.atan2(-relE, -relN) * 180 / Math.PI + 360) % 360;
  const awaAbs = (awFrom - b.hdg + 360) % 360;
  const mwv = sentence(`WIMWV,${awaAbs.toFixed(1)},R,${aws.toFixed(1)},N,A`);

  const payload = `${rmc}\r\n${hdt}\r\n${mwd}\r\n${vhw}\r\n${xdr}\r\n${rsa}\r\n${mwv}\r\n`;
  for (const ws of b.wss.clients) if (ws.readyState === 1) ws.send(payload);
}

setInterval(() => {
  for (const b of boats) { if (running) step(b); emit(b); }
}, dtSec * 1000);

// ---- Control panel (HTTP) -------------------------------------------------
const http = require('http');
const controlPort = config.controlPort || 8099;

function controlPage() {
  const rows = boats.map((b, i) =>
    `<div class="boat"><b>${b.name}</b>
       <label>Heading <input type="number" id="hdg${i}" step="1"></label>
       <button onclick="setHeading(${i})">Set</button>
       <span id="cur${i}" class="cur"></span></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Simulator control</title><style>
  body{font-family:system-ui,sans-serif;background:#081521;color:#dceaf4;margin:0;padding:20px;}
  h1{font-size:16px;letter-spacing:.08em;text-transform:uppercase;}
  button{font:inherit;font-size:14px;color:#05201d;background:#37e0cf;border:none;border-radius:8px;padding:9px 15px;cursor:pointer;margin-right:6px;}
  button.sec{background:#123048;color:#dceaf4;border:1px solid #1b3a4e;}
  .row{display:flex;gap:8px;margin:14px 0;flex-wrap:wrap;}
  .boat{display:flex;align-items:center;gap:10px;background:#0f2534;border:1px solid #1b3a4e;border-radius:10px;padding:12px 14px;margin:10px 0;flex-wrap:wrap;}
  input{font:inherit;font-size:14px;color:#dceaf4;background:#0c1e2d;border:1px solid #1b3a4e;border-radius:7px;padding:8px 10px;width:90px;}
  label{font-size:13px;color:#7f9bb0;}
  .cur{font-family:ui-monospace,monospace;color:#7f9bb0;font-size:12px;}
  .state{font-family:ui-monospace,monospace;color:#37e0cf;}
  </style></head><body>
  <h1>Simulator control</h1>
  <div class="row">
    <button onclick="cmd('start')">Start</button>
    <button class="sec" onclick="cmd('stop')">Stop</button>
    <button class="sec" onclick="cmd('restart')">Restart</button>
    <span id="state" class="state"></span>
  </div>
  ${rows}
  <div class="boat"><b>Wind</b>
    <label>TWD <input type="number" id="twd" step="1"></label>
    <label>TWS <input type="number" id="tws" step="0.1"></label>
    <button onclick="setWind()">Set</button>
  </div>
  <script>
  async function post(body){await fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});refresh();}
  function cmd(c){post({cmd:c});}
  function setHeading(i){post({cmd:'heading',boat:i,value:+document.getElementById('hdg'+i).value});}
  function setWind(){post({cmd:'wind',twd:+document.getElementById('twd').value,tws:+document.getElementById('tws').value});}
  async function refresh(){try{const s=await (await fetch('/state')).json();
    document.getElementById('state').textContent=s.running?'running':'stopped';
    s.boats.forEach((b,i)=>{document.getElementById('cur'+i).textContent='COG '+b.cog.toFixed(0)+'°  SOG '+b.sog.toFixed(1)+'kn';
      const h=document.getElementById('hdg'+i); if(document.activeElement!==h) h.placeholder=b.cog.toFixed(0);});
    const twd=document.getElementById('twd'),tws=document.getElementById('tws');
    if(document.activeElement!==twd) twd.placeholder=s.wind.twd; if(document.activeElement!==tws) tws.placeholder=s.wind.tws;
  }catch(e){}}
  refresh(); setInterval(refresh,1000);
  </script></body></html>`;
}

http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(controlPage()); return;
  }
  if (req.method === 'GET' && req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running, wind: config.wind, boats: boats.map((b) => ({ name: b.name, cog: b.cog, sog: b.sog })) }));
    return;
  }
  if (req.method === 'POST' && req.url === '/control') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body || '{}');
        if (m.cmd === 'start') running = true;
        else if (m.cmd === 'stop') running = false;
        else if (m.cmd === 'restart') { restartBoats(); running = true; }
        else if (m.cmd === 'heading' && boats[m.boat] != null && isFinite(m.value)) { boats[m.boat].cogTarget = wrap360(m.value); }
        else if (m.cmd === 'wind') { if (isFinite(m.twd)) config.wind.twd = wrap360(m.twd); if (isFinite(m.tws)) config.wind.tws = Math.max(0, m.tws); }
        console.log(`control: ${JSON.stringify(m)}`);
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
}).listen(controlPort, () => {
  console.log('');
  console.log(`  Two-boat simulator running (${config.updateHz} Hz).`);
  console.log(`  Wind: TWS ${config.wind.tws} kn, TWD ${config.wind.twd}\u00b0`);
  console.log('  Set the web app boats to:');
  boats.forEach((b) => console.log(`    ${b.name}: ws://localhost:${b.port}`));
  console.log('');
  console.log(`  Control panel:  http://localhost:${controlPort}   (start/stop/restart, change heading & wind)`);
  console.log('  Ctrl+C to stop.');
});
