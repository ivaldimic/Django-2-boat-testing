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
const boats = config.boats.map((b, i) => ({
  ...b,
  cog: b.cog, hdg: b.hdg, sog: b.sog,
  heelBase: b.heel != null ? b.heel : 22 + i * 2,   // deg
  heel: b.heel != null ? b.heel : 22 + i * 2,
  rudder: 0,
  phase: Math.random() * Math.PI * 2,               // for gentle oscillations
  t: 0,
  wss: new WebSocketServer({ port: b.port }),
}));

boats.forEach((b) => {
  b.wss.on('connection', (ws) => {
    console.log(`${b.name}: app connected (${b.wss.clients.size} on port ${b.port})`);
    ws.on('close', () => console.log(`${b.name}: app disconnected (${b.wss.clients.size} on port ${b.port})`));
  });
  b.wss.on('listening', () => console.log(`${b.name}: serving NMEA at ws://localhost:${b.port}`));
});

// ---- Simulation loop ------------------------------------------------------
function step(b) {
  b.t += dtSec;
  // Gentle random walk so the plots have life, kept near the configured values.
  b.cog = wrap360(b.cog + (Math.random() - 0.5) * 1.2);
  b.sog = clamp(b.sog + (Math.random() - 0.5) * 0.08, 0.5, 20);
  b.hdg = wrap360(b.cog - 2 + (Math.random() - 0.5) * 0.6); // small leeway vs course

  // Heel: base + slow swell + puffs, correlated loosely with speed.
  b.heel = b.heelBase + 2.2 * Math.sin(b.t * 0.25 + b.phase) + (Math.random() - 0.5) * 1.2;
  // Rudder: small helming oscillation around a touch of weather helm.
  b.rudder = 2.0 * Math.sin(b.t * 0.6 + b.phase) + (Math.random() - 0.5) * 1.6;

  // Advance position along COG.
  const distM = b.sog * 1852 / 3600 * dtSec; // knots -> m over dt
  const cogRad = b.cog * Math.PI / 180;
  const dNorth = distM * Math.cos(cogRad);
  const dEast = distM * Math.sin(cogRad);
  b.lat += dNorth / 111320;
  b.lon += dEast / (111320 * Math.cos(b.lat * Math.PI / 180));
}

function emit(b) {
  if (!b.wss.clients.size) return;
  const now = new Date();
  const tws = config.wind.tws;
  const twd = config.wind.twd;

  const rmc = sentence(
    `GPRMC,${utcStamp(now)},A,${fmtLat(b.lat)},${fmtLon(b.lon)},` +
    `${b.sog.toFixed(1)},${b.cog.toFixed(1)},${utcDate(now)},,,A`
  );
  const hdt = sentence(`HEHDT,${b.hdg.toFixed(1)},T`);
  const twsMs = (tws * 0.514444).toFixed(1);
  const mwd = sentence(`WIMWD,${twd.toFixed(1)},T,${twd.toFixed(1)},M,${tws.toFixed(1)},N,${twsMs},M`);
  // Boat speed through water (~ SOG here, small offset), knots in the N field.
  const bs = Math.max(0, b.sog - 0.1);
  const vhw = sentence(`VWVHW,,T,,M,${bs.toFixed(1)},N,${(bs * 1.852).toFixed(1)},K`);
  // Heel via XDR ROLL (degrees), rudder via RSA (degrees).
  const xdr = sentence(`IIXDR,A,${b.heel.toFixed(1)},D,ROLL`);
  const rsa = sentence(`IIRSA,${b.rudder.toFixed(1)},A,,`);

  const payload = `${rmc}\r\n${hdt}\r\n${mwd}\r\n${vhw}\r\n${xdr}\r\n${rsa}\r\n`;
  for (const ws of b.wss.clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

setInterval(() => {
  for (const b of boats) { step(b); emit(b); }
}, dtSec * 1000);

console.log('');
console.log(`  Two-boat simulator running (${config.updateHz} Hz).`);
console.log(`  Wind: TWS ${config.wind.tws} kn, TWD ${config.wind.twd}\u00b0`);
console.log('  Set the web app boats to:');
boats.forEach((b) => console.log(`    ${b.name}: ws://localhost:${b.port}`));
console.log('');
console.log('  Ctrl+C to stop.');
