'use strict';

/* Boat data receiver — app logic.
 * Connections (one WebSocket per boat), master/viewer roles, and the test
 * engine. VMG test is fully implemented; VMC/TWA are stubbed pending spec. */

const BOATS_KEY = 'boat-receiver:boats:v1';
const ROLE_KEY = 'boat-receiver:role:v1';
const MAX_LINES = 120;
const LIVE_MS = 3000;
const RECONNECT_MAX_MS = 8000;
const COLORS = ['#37e0cf', '#ff8a5b', '#c084fc', '#7dd3fc'];
const STRIP_WINDOW_MS = 120000;   // strip charts show the last 2 minutes
const HIST_MS = 130000;           // keep a touch more history than shown
const TRACK_MS = 600000;          // keep up to 10 minutes of track
const SAMPLE_MS = 500;            // history sample + dashboard redraw cadence

const S = globalThis.SailMath;
const $ = (id) => document.getElementById(id);

const state = {
  role: null,
  boats: [],              // [{id,name,url}]
  rt: new Map(),          // id -> runtime
  test: null,
};

/* ---------- persistence ---------- */
function loadBoats() {
  try { const r = localStorage.getItem(BOATS_KEY); if (r) return JSON.parse(r); } catch (_) {}
  return (window.DEFAULT_BOATS || []).map((b) => ({ ...b }));
}
function saveBoats(list) { try { localStorage.setItem(BOATS_KEY, JSON.stringify(list)); } catch (_) {} }
function loadRole() { try { return localStorage.getItem(ROLE_KEY); } catch (_) { return null; } }
function saveRole(r) { try { localStorage.setItem(ROLE_KEY, r); } catch (_) {} }

/* ---------- connections ---------- */
function applyBoats(list) {
  for (const rt of state.rt.values()) {
    rt.closing = true;
    clearTimeout(rt.timer);
    if (rt.ws) { try { rt.ws.close(); } catch (_) {} }
  }
  state.rt.clear();
  state.boats = list;

  $('connbar').innerHTML = '';
  $('streams').innerHTML = '';

  list.forEach((def, i) => {
    const color = COLORS[i % COLORS.length];
    const rt = {
      def, color, ws: null, conn: 'idle', closing: false, retry: 0, timer: null,
      count: 0, lastTs: 0, times: [], live: {}, recent: [],
      hist: [], track: [],
      pill: makePill(def, color), sbox: makeStream(def),
    };
    state.rt.set(def.id, rt);
    connect(rt);
  });
}

function makePill(def, color) {
  const node = $('pill-template').content.firstElementChild.cloneNode(true);
  node.dataset.boatId = def.id;
  node.querySelector('.pill__dot').style.background = color;
  node.querySelector('.pill__name').textContent = def.name;
  $('connbar').appendChild(node);
  return node;
}
function makeStream(def) {
  const node = $('stream-template').content.firstElementChild.cloneNode(true);
  node.dataset.boatId = def.id;
  node.querySelector('.sbox__name').textContent = def.name;
  node.querySelector('.sbox__src').textContent = def.url || '';
  $('streams').appendChild(node);
  return { box: node, list: node.querySelector('.stream') };
}

function connect(rt) {
  if (!rt.def.url) { rt.conn = 'idle'; return; }
  rt.conn = 'connecting';
  let ws;
  try { ws = new WebSocket(rt.def.url); }
  catch (_) { rt.conn = 'closed'; return scheduleReconnect(rt); }
  rt.ws = ws;
  ws.onopen = () => { rt.retry = 0; rt.conn = 'open'; };
  ws.onmessage = (ev) => handleFrame(rt, ev.data);
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
  ws.onclose = () => { rt.ws = null; rt.conn = 'closed'; scheduleReconnect(rt); };
}
function scheduleReconnect(rt) {
  if (rt.closing) return;
  rt.retry = Math.min(rt.retry + 1, 6);
  const delay = Math.min(500 * 2 ** (rt.retry - 1), RECONNECT_MAX_MS);
  clearTimeout(rt.timer);
  rt.timer = setTimeout(() => connect(rt), delay);
}
function handleFrame(rt, data) {
  if (typeof data !== 'string') {
    if (typeof Blob !== 'undefined' && data instanceof Blob) { data.text().then((t) => handleFrame(rt, t)).catch(() => {}); return; }
    try { data = new TextDecoder().decode(data); } catch (_) { return; }
  }
  const ts = Date.now();
  const lines = data.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const line of (lines.length ? lines : [data.trim()])) onLine(rt, line, ts);
}
function onLine(rt, raw, ts) {
  rt.count += 1;
  rt.lastTs = ts;
  rt.times.push(ts);
  const cut = ts - 5000;
  while (rt.times.length && rt.times[0] < cut) rt.times.shift();
  parseNMEA(raw, rt.live);
  rt.live.ts = ts;

  rt.recent.push({ ts, raw });
  if (rt.recent.length > MAX_LINES) rt.recent.shift();
  if (rt.sbox.box.closest('details').open) appendStreamLine(rt, raw, ts);
}
function appendStreamLine(rt, raw, ts) {
  const t = new Date(ts);
  const li = document.createElement('li');
  li.className = 'stream__line';
  const a = document.createElement('span'); a.className = 'stream__t';
  a.textContent = t.toTimeString().slice(0, 8);
  const b = document.createElement('span'); b.className = 'stream__raw'; b.textContent = raw;
  li.append(a, b);
  rt.sbox.list.prepend(li);
  while (rt.sbox.list.children.length > MAX_LINES) rt.sbox.list.removeChild(rt.sbox.list.lastChild);
}

/* ---------- NMEA parse (into live state) ---------- */
function parseNMEA(raw, live) {
  if (!raw || (raw[0] !== '$' && raw[0] !== '!')) return;
  const star = raw.indexOf('*');
  const f = (star >= 0 ? raw.slice(1, star) : raw.slice(1)).split(',');
  const type = (f[0] || '').slice(2);
  switch (type) {
    case 'RMC': setPos(live, f[3], f[4], f[5], f[6]); if (f[7]) live.sog = +f[7]; if (f[8]) live.cog = +f[8]; break;
    case 'GGA': setPos(live, f[2], f[3], f[4], f[5]); break;
    case 'GLL': setPos(live, f[1], f[2], f[3], f[4]); break;
    case 'VTG': if (f[1]) live.cog = +f[1]; if (f[5]) live.sog = +f[5]; break;
    case 'HDT': case 'HDG': if (f[1]) live.hdg = +f[1]; break;
    case 'VHW': if (f[5]) live.bsp = +f[5]; break;
    case 'MWV': if (f[2] === 'T') { if (f[1]) live.twa = +f[1]; if (f[3]) live.tws = +f[3]; } break;
    case 'MWD': if (f[1]) live.twd = +f[1]; if (f[5]) live.tws = +f[5]; break;
    case 'RSA': if (f[1] !== '' && f[1] != null) live.rudder = +f[1]; break;
    case 'XDR': parseXDR(f, live); break;
  }
}
// XDR carries repeating groups of 4: type, value, unit, name.
function parseXDR(f, live) {
  for (let i = 1; i + 3 < f.length + 1; i += 4) {
    const val = f[i + 1], name = (f[i + 3] || '').toUpperCase();
    if (val === '' || val == null) continue;
    if (name.includes('ROLL') || name.includes('HEEL')) live.heel = +val;
    else if (name.includes('PITCH')) live.pitch = +val;
    else if (name.includes('RUDDER')) live.rudder = +val;
  }
}
function setPos(live, la, ns, lo, ew) {
  const lat = coord(la, ns, 2), lon = coord(lo, ew, 3);
  if (lat != null) live.lat = lat;
  if (lon != null) live.lon = lon;
}
function coord(v, hemi, dd) {
  if (!v) return null;
  const deg = parseInt(v.slice(0, dd), 10), min = parseFloat(v.slice(dd));
  if (Number.isNaN(deg) || Number.isNaN(min)) return null;
  let d = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') d = -d;
  return d;
}

/* ---------- status refresh ---------- */
function boatStatus(rt, now) {
  if (!rt.def.url) return 'idle';
  if (rt.conn === 'connecting') return 'idle';
  if (rt.conn !== 'open') return 'down';
  if (!rt.lastTs || now - rt.lastTs > LIVE_MS) return 'stale';
  return 'live';
}
setInterval(() => {
  const now = Date.now();
  for (const rt of state.rt.values()) {
    const st = boatStatus(rt, now);
    const rate = rt.times.filter((t) => t >= now - 1000).length;
    rt.pill.dataset.state = st;
    rt.pill.querySelector('.pill__state').textContent =
      st === 'live' ? 'Live' : st === 'stale' ? 'No data' : st === 'down' ? 'Offline' : 'Idle';
    rt.pill.querySelector('.pill__rate').textContent = `${rate}/s`;
  }
  if (!$('drawer').hidden) renderStatusList(now);
  sampleHistory(now);
  renderDashboard(now);
}, SAMPLE_MS);

/* ---------- live dashboard (map + strips + range/bearing) ---------- */
const CHANNELS = [
  { key: 'bsp', id: 'bs', angular: false, dp: 1 },
  { key: 'cog', id: 'cog', angular: true, dp: 0 },
  { key: 'twa', id: 'twa', angular: false, dp: 0 },
  { key: 'heel', id: 'heel', angular: false, dp: 1 },
  { key: 'rudder', id: 'rudder', angular: false, dp: 1 },
  { key: 'twd', id: 'twd', angular: true, dp: 0 },
  { key: 'tws', id: 'tws', angular: false, dp: 1 },
];
let trackMap = null;
const strips = {};
function initDashboard() {
  if (trackMap || typeof TrackMap === 'undefined') return;
  const mapC = $('map'); if (!mapC) return;
  trackMap = new TrackMap(mapC);
  for (const ch of CHANNELS) {
    const c = $(`strip-${ch.id}`);
    if (c && typeof StripChart !== 'undefined') strips[ch.id] = new StripChart(c);
  }
}

function sampleHistory(now) {
  for (const rt of state.rt.values()) {
    const l = rt.live;
    if (!l || !l.ts || (now - l.ts) >= LIVE_MS) continue;   // only sample fresh data
    const twa = (l.cog != null && l.twd != null) ? S.twa(l.cog, l.twd) : l.twa;
    rt.hist.push({ t: now, bsp: l.bsp, cog: l.cog, twa, heel: l.heel, rudder: l.rudder, twd: l.twd, tws: l.tws });
    const cut = now - HIST_MS;
    while (rt.hist.length && rt.hist[0].t < cut) rt.hist.shift();

    if (l.lat != null && l.lon != null) {
      const last = rt.track[rt.track.length - 1];
      const moved = last ? S.rangeBearing(last.lat, last.lon, l.lat, l.lon).rangeM : Infinity;
      if (!last || moved > 0.5 || (now - last.t) > 2000) rt.track.push({ t: now, lat: l.lat, lon: l.lon });
      const tcut = now - TRACK_MS;
      while (rt.track.length && rt.track[0].t < tcut) rt.track.shift();
    }
  }
}

function renderDashboard(now) {
  initDashboard();
  if (!trackMap) return;
  const rts = [...state.rt.values()];
  const boats = rts.map((rt) => ({
    name: rt.def.name, color: rt.color,
    lat: rt.live.lat, lon: rt.live.lon, hdg: rt.live.hdg, cog: rt.live.cog,
    track: rt.track,
  }));

  let range = null, bearing = null;
  const a = boats[0], b = boats[1];
  if (a && b && a.lat != null && a.lon != null && b.lat != null && b.lon != null) {
    const rb = S.rangeBearing(a.lat, a.lon, b.lat, b.lon);
    range = rb.rangeM; bearing = rb.bearingDeg;
    $('rb-range').textContent = `${Math.round(range)} m`;
    $('rb-bearing').textContent = `${String(Math.round(bearing)).padStart(3, '0')}°`;
  } else {
    $('rb-range').textContent = '—';
    $('rb-bearing').textContent = '—';
  }
  if (a && b) $('rb-note').innerHTML = `${a.name} &rarr; ${b.name}`;

  trackMap.setData({ boats, range, bearing });

  for (const ch of CHANNELS) {
    if (strips[ch.id]) {
      const series = rts.map((rt) => ({ color: rt.color, points: rt.hist.map((h) => ({ t: h.t, y: h[ch.key] })) }));
      strips[ch.id].setSeries(series, { now, windowMs: STRIP_WINDOW_MS, angular: ch.angular });
    }
    const valEl = $(`val-${ch.id}`);
    if (valEl) {
      valEl.innerHTML = rts.map((rt) => {
        let v = rt.live[ch.key];
        if (ch.key === 'twa' && rt.live.cog != null && rt.live.twd != null) v = S.twa(rt.live.cog, rt.live.twd);
        const txt = (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(ch.dp);
        return `<span style="color:${rt.color}">${txt}</span>`;
      }).join('<span class="strip__sep">·</span>');
    }
  }
}

/* ---------- roles ---------- */
function setRole(role) {
  state.role = role;
  saveRole(role);
  const badge = $('role-badge');
  badge.hidden = false;
  badge.dataset.role = role;
  badge.textContent = role;
  gateControls();
  for (const seg of $('role-switch').querySelectorAll('.seg')) {
    seg.setAttribute('aria-pressed', String(seg.dataset.role === role));
  }
}
function gateControls() {
  const isMaster = state.role === 'master';
  for (const b of $('tests').querySelectorAll('.test-btn')) b.disabled = !isMaster;
}

/* ---------- settings drawer ---------- */
let editingRole = null;
function openDrawer() {
  editingRole = state.role;
  const rows = $('boat-rows'); rows.innerHTML = '';
  loadBoats().forEach((b) => addRow(b));
  for (const seg of $('role-switch').querySelectorAll('.seg')) {
    seg.setAttribute('aria-pressed', String(seg.dataset.role === state.role));
  }
  renderStatusList(Date.now());
  $('drawer').hidden = false;
}
function closeDrawer() { $('drawer').hidden = true; }
function addRow(def) {
  const row = $('row-template').content.firstElementChild.cloneNode(true);
  row.querySelector('.row__name').value = def ? (def.name || '') : '';
  row.querySelector('.row__url').value = def ? (def.url || '') : '';
  row.querySelector('.row__remove').addEventListener('click', () => row.remove());
  $('boat-rows').appendChild(row);
}
function collectRows() {
  const out = []; let n = 0;
  for (const row of $('boat-rows').querySelectorAll('.row')) {
    const name = row.querySelector('.row__name').value.trim();
    const url = row.querySelector('.row__url').value.trim();
    if (!name && !url) continue;
    n += 1;
    out.push({ id: `boat${n}`, name: name || `Boat ${n}`, url });
  }
  return out;
}
function renderStatusList(now) {
  const list = $('status-list'); list.innerHTML = '';
  for (const rt of state.rt.values()) {
    const st = boatStatus(rt, now);
    const rate = rt.times.filter((t) => t >= now - 1000).length;
    const row = document.createElement('div');
    row.className = 'status-row'; row.dataset.state = st;
    const dot = document.createElement('span'); dot.className = 'pill__dot';
    const name = document.createElement('span'); name.className = 'sname'; name.textContent = rt.def.name;
    const info = document.createElement('span'); info.className = 'sinfo';
    info.textContent = st === 'live' ? `${rate}/s` : st === 'stale' ? 'no data' : st === 'down' ? 'offline' : 'idle';
    row.append(dot, name, info);
    list.appendChild(row);
  }
  if (!state.rt.size) list.textContent = 'No boats configured.';
}

/* ---------- duration modal ---------- */
let pendingTest = null;
function openDuration(type) {
  pendingTest = type;
  $('duration-title').textContent = `${type} test`;
  $('duration-input').value = '5';
  $('duration-modal').hidden = false;
}

/* ---------- test engine (VMG) ---------- */
let chartVMG = null, chartUP = null;

function testBoats() {
  // The VMG comparison uses the first two configured boats.
  return [...state.rt.values()].slice(0, 2).map((rt) => ({
    id: rt.def.id, name: rt.def.name, color: rt.color, rt,
  }));
}

function startVMG(durationSec) {
  const boats = testBoats();
  if (boats.length < 2) { alert('The VMG test compares two boats. Configure both in Settings.'); return; }

  state.test = {
    type: 'VMG', durationSec, startTs: Date.now(), running: true,
    boats, refId: boats[0].id, twdRef: null,
    samples: [],                     // [{ t, p:[{lat,lon,twd},{lat,lon,twd}] }] both boats fixed
    series: { vmg: [], up: [], fwd: [] },
    timer: null,
  };

  $('test-title').textContent = 'VMG test';
  $('test-duration').textContent = mmss(durationSec);
  $('test-status').textContent = 'Running';
  $('test-stop').hidden = false;
  $('test-close').hidden = true;
  $('test-view').hidden = false;

  buildRefSwitch(boats);
  buildTiles();
  if (!chartVMG) chartVMG = new LineChart($('chart-vmg'));
  if (!chartUP) chartUP = new LineChart($('chart-up'));

  clearInterval(state.test.timer);
  state.test.timer = setInterval(sampleVMG, 1000);
  sampleVMG();
}

function buildRefSwitch(boats) {
  const wrap = $('ref-switch'); wrap.innerHTML = '';
  const lab = document.createElement('span'); lab.className = 'ref-switch__label'; lab.textContent = 'Reference';
  wrap.appendChild(lab);
  for (const b of boats) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'seg';
    btn.textContent = b.name;
    btn.style.borderColor = b.color;
    btn.setAttribute('aria-pressed', String(b.id === state.test.refId));
    btn.addEventListener('click', () => {
      const t = state.test; if (!t) return;
      if (t.refId === b.id) return;
      t.refId = b.id;
      for (const s of wrap.querySelectorAll('.seg')) s.setAttribute('aria-pressed', String(s === btn));
      renderVMG();
    });
    wrap.appendChild(btn);
  }
}

const tileEls = {};
function buildTiles() {
  const wrap = $('test-tiles'); wrap.innerHTML = '';
  tileEls.dvmg = tile(wrap, 'delta', 'VMG gain', 'delta');
  tileEls.rate = tile(wrap, 'delta', 'VMG gain / min', 'delta');
  tileEls.dfwd = tile(wrap, 'delta', 'FWD/BACK gain', 'delta');
  tileEls.dup = tile(wrap, 'delta', 'UP/DOWN gain', 'delta');
}
function tile(wrap, boatKey, label, kind) {
  const node = $('tile-template').content.firstElementChild.cloneNode(true);
  node.dataset.boat = boatKey;
  if (kind) node.dataset.kind = kind;
  node.querySelector('.tile__label').textContent = label;
  node.querySelector('.tile__value').textContent = '—';
  wrap.appendChild(node);
  return node;
}

// --- geometry helpers ---
function circMeanDeg(vals) {
  let s = 0, c = 0, n = 0;
  for (const v of vals) { if (v == null) continue; const r = v * Math.PI / 180; s += Math.sin(r); c += Math.cos(r); n++; }
  if (!n) return null;
  return (Math.atan2(s, c) * 180 / Math.PI + 360) % 360;
}
function enu(lat, lon, lat0, lon0) {
  const LAT_M = 111132, lonM = 111320 * Math.cos(lat0 * Math.PI / 180);
  return { e: (lon - lon0) * lonM, n: (lat - lat0) * LAT_M };
}

function sampleVMG() {
  const t = state.test; if (!t || !t.running) return;
  const now = Date.now();
  // Record a paired sample only when BOTH boats have a fresh fix.
  const p = t.boats.map((b) => {
    const l = b.rt.live;
    const fresh = l && (now - (l.ts || 0)) < LIVE_MS;
    return (fresh && l.lat != null && l.lon != null) ? { lat: l.lat, lon: l.lon, twd: l.twd } : null;
  });
  if (p[0] && p[1]) t.samples.push({ t: now, p });
  renderVMG();
  const elapsed = (now - t.startTs) / 1000;
  $('test-elapsed').textContent = mmss(Math.min(elapsed, t.durationSec));
  $('test-progress').style.width = `${Math.min(100, (elapsed / t.durationSec) * 100)}%`;
  if (elapsed >= t.durationSec) finishTest('Complete');
}

// Gains at sample index k, following the written definitions. All three gains are
// the relative displacement ΔD = (ref boat's start→now) − (other boat's start→now)
// projected onto three axes:
//   VMG GAIN      = ΔD · TWD-axis
//   FWD/BACK GAIN = ΔD · average-path axis (start-midpoint → now-midpoint)
//   UP/DOWN GAIN  = ΔD · perpendicular of the average path (windward = +)
function gainsAt(t, refIdx, othIdx, twdRefK, k) {
  const s0 = t.samples[0], sk = t.samples[k];
  const D0 = enu(sk.p[0].lat, sk.p[0].lon, s0.p[0].lat, s0.p[0].lon);
  const D1 = enu(sk.p[1].lat, sk.p[1].lon, s0.p[1].lat, s0.p[1].lon);
  const Dref = refIdx === 0 ? D0 : D1;
  const Doth = othIdx === 0 ? D0 : D1;
  const dE = Dref.e - Doth.e, dN = Dref.n - Doth.n;              // ΔD

  let vmg = null;
  if (twdRefK != null) {
    const wr = twdRefK * Math.PI / 180;
    vmg = dE * Math.sin(wr) + dN * Math.cos(wr);                 // ΔD along TWD axis
  }

  let fwd = null, up = null;
  const aE = (D0.e + D1.e) / 2, aN = (D0.n + D1.n) / 2;          // average-path vector
  const alen = Math.hypot(aE, aN);
  if (alen >= 1) {
    const ux = aE / alen, uy = aN / alen;                        // along average path
    let px = -uy, py = ux;                                       // perpendicular
    if (twdRefK != null) {                                       // orient UP toward the wind
      const wr = twdRefK * Math.PI / 180;
      if (px * Math.sin(wr) + py * Math.cos(wr) < 0) { px = -px; py = -py; }
    }
    fwd = dE * ux + dN * uy;
    up = dE * px + dN * py;
  }
  return { vmg, fwd, up };
}

function renderVMG() {
  const t = state.test; if (!t) return;
  const refIdx = Math.max(0, t.boats.findIndex((b) => b.id === t.refId));
  const othIdx = refIdx === 0 ? 1 : 0;

  const overallTwd = [];
  for (const s of t.samples) { if (s.p[0].twd != null) overallTwd.push(s.p[0].twd); if (s.p[1].twd != null) overallTwd.push(s.p[1].twd); }
  const twdOverall = circMeanDeg(overallTwd);
  t.twdRef = twdOverall;
  $('test-meta').innerHTML =
    `Ref <b style="color:${t.boats[refIdx].color}">${t.boats[refIdx].name}</b> · TWD used ` +
    (twdOverall == null ? '—' : `${String(Math.round(twdOverall)).padStart(3, '0')}°`);

  const dashes = () => { for (const k of ['dvmg', 'rate', 'dfwd', 'dup']) setDelta(k, 0, '', '', 0, true); };
  if (t.samples.length < 2) { dashes(); return; }

  // Walk the samples, keeping the running TWD average up to each moment, and
  // rebuild the plotted series. (Axes are the same regardless of reference, so a
  // reference change simply flips the sign.)
  t.series.vmg = []; t.series.up = []; t.series.fwd = [];
  let sSin = 0, sCos = 0;
  const addTwd = (s) => { for (const b of s.p) if (b.twd != null) { const r = b.twd * Math.PI / 180; sSin += Math.sin(r); sCos += Math.cos(r); } };
  addTwd(t.samples[0]);
  let cur = null;
  for (let k = 1; k < t.samples.length; k++) {
    addTwd(t.samples[k]);
    const twdK = (sSin === 0 && sCos === 0) ? null : (Math.atan2(sSin, sCos) * 180 / Math.PI + 360) % 360;
    const g = gainsAt(t, refIdx, othIdx, twdK, k);
    const x = (t.samples[k].t - t.samples[0].t) / 1000;
    if (g.vmg != null) t.series.vmg.push({ x, y: g.vmg });
    if (g.up != null) t.series.up.push({ x, y: g.up });
    if (g.fwd != null) t.series.fwd.push({ x, y: g.fwd });
    cur = g;
  }

  if (cur) {
    const elapsedMin = (Date.now() - t.startTs) / 60000;
    if (cur.vmg != null) {
      setDelta('dvmg', cur.vmg, 'm', 'sep. on TWD axis, Δ');
      setDelta('rate', elapsedMin > 0 ? cur.vmg / elapsedMin : 0, 'm/min', 'VMG gain ÷ minutes', 1);
    } else { setDelta('dvmg', 0, '', '', 0, true); setDelta('rate', 0, '', '', 0, true); }
    if (cur.fwd != null) setDelta('dfwd', cur.fwd, 'm', 'along average path, Δ'); else setDelta('dfwd', 0, '', '', 0, true);
    if (cur.up != null) setDelta('dup', cur.up, 'm', 'perp. of path, windward +'); else setDelta('dup', 0, '', '', 0, true);
  } else { dashes(); }

  chartVMG.setSeries([{ label: 'VMG gain', color: '#37e0cf', points: t.series.vmg }],
    { xMax: t.durationSec, includeZero: true });
  chartUP.setSeries([
    { label: 'UP/DOWN', color: '#37e0cf', points: t.series.up },
    { label: 'FWD/BACK', color: '#ff8a5b', points: t.series.fwd },
  ], { xMax: t.durationSec, includeZero: true });
}

function setDelta(key, value, unit, sub, dp, blank) {
  const el = tileEls[key]; if (!el) return;
  const v = el.querySelector('.tile__value');
  if (blank) {
    v.textContent = '—';
    v.classList.remove('pos', 'neg');
    el.querySelector('.tile__sub').textContent = '';
    return;
  }
  const num = value.toFixed(dp || 0);
  v.textContent = `${value >= 0 ? '+' : '−'}${Math.abs(+num)} ${unit}`;
  v.classList.toggle('pos', value > 0.5);
  v.classList.toggle('neg', value < -0.5);
  el.querySelector('.tile__sub').textContent = sub;
}

function finishTest(label) {
  const t = state.test; if (!t) return;
  clearInterval(t.timer); t.running = false;
  $('test-status').textContent = label;
  $('test-stop').hidden = true;
  $('test-close').hidden = false;
}
function closeTest() {
  state.test = null;
  $('test-view').hidden = true;
  $('ref-switch').innerHTML = '';
  $('test-meta').innerHTML = '';
  gateControls();
}

function mmss(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/* ---------- wiring ---------- */
$('role-master').addEventListener('click', () => { setRole('master'); $('role-modal').hidden = true; });
$('role-viewer').addEventListener('click', () => { setRole('viewer'); $('role-modal').hidden = true; });

$('btn-vmg').addEventListener('click', () => { if (state.role === 'master') openDuration('VMG'); });
$('btn-vmc').addEventListener('click', () => notYet('VMC'));
$('btn-twa').addEventListener('click', () => notYet('TWA'));
function notYet(type) {
  if (state.role !== 'master') return;
  $('test-title').textContent = `${type} test`;
  $('test-status').textContent = 'Not built yet';
  $('test-duration').textContent = '—';
  $('test-elapsed').textContent = '—';
  $('ref-switch').innerHTML = '';
  $('test-meta').innerHTML = '';
  $('test-tiles').innerHTML = `<div class="tile"><span class="tile__label">${type} test</span><span class="tile__value" style="font-size:15px">Coming next</span><span class="tile__sub">Send the spec (VMC needs a target bearing/mark) and this fills in.</span></div>`;
  $('test-progress').style.width = '0%';
  $('test-stop').hidden = true;
  $('test-close').hidden = false;
  $('test-view').hidden = false;
  state.test = null;
}

$('test-stop').addEventListener('click', () => finishTest('Stopped'));
$('test-close').addEventListener('click', closeTest);

$('duration-start').addEventListener('click', () => {
  const mins = Math.max(1, parseInt($('duration-input').value, 10) || 5);
  $('duration-modal').hidden = true;
  if (pendingTest === 'VMG') startVMG(mins * 60);
});
$('duration-cancel').addEventListener('click', () => { $('duration-modal').hidden = true; });

$('settings-btn').addEventListener('click', openDrawer);
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-scrim').addEventListener('click', closeDrawer);
$('cancel-btn').addEventListener('click', closeDrawer);
$('add-boat').addEventListener('click', () => addRow(null));
for (const seg of $('role-switch').querySelectorAll('.seg')) {
  seg.addEventListener('click', () => {
    editingRole = seg.dataset.role;
    for (const s2 of $('role-switch').querySelectorAll('.seg')) s2.setAttribute('aria-pressed', String(s2 === seg));
  });
}
$('save-btn').addEventListener('click', () => {
  const list = collectRows();
  saveBoats(list);
  applyBoats(list);
  if (editingRole && editingRole !== state.role) setRole(editingRole);
  closeDrawer();
});

/* reveal stream lines when the details section is opened */
document.querySelector('.streams-wrap').addEventListener('toggle', (e) => {
  if (!e.target.open) return;
  for (const rt of state.rt.values()) {
    rt.sbox.list.innerHTML = '';
    for (const item of rt.recent.slice(-40)) appendStreamLine(rt, item.raw, item.ts);
  }
});

/* ---------- init ---------- */
applyBoats(loadBoats());
const savedRole = loadRole();
if (savedRole) { setRole(savedRole); $('role-modal').hidden = true; }
else { $('role-modal').hidden = false; }
gateControls();
