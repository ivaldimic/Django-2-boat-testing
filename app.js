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
const STRIP_WINDOW_MS = 120000;   // default strip window (2 minutes)
const HIST_MS = 1210000;          // keep ~20 min so the 20-minute window works
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
    case 'MWV':
      if (f[2] === 'T') { if (f[1]) live.twa = S.norm180(+f[1]); if (f[3]) live.tws = +f[3]; }
      else if (f[2] === 'R') { if (f[1]) live.awa = S.norm180(+f[1]); if (f[3]) live.aws = +f[3]; }
      break;
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
const ALL_CHANNELS = [
  { key: 'sog', id: 'sog', label: 'SOG', unit: 'kn', angular: false, dp: 1 },
  { key: 'bsp', id: 'bs', label: 'BS', unit: 'kn', angular: false, dp: 1 },
  { key: 'cog', id: 'cog', label: 'COG', unit: '°', angular: true, dp: 0 },
  { key: 'hdg', id: 'hdg', label: 'HDG', unit: '°', angular: true, dp: 0 },
  { key: 'twa', id: 'twa', label: 'TWA', unit: '°', angular: false, dp: 0 },
  { key: 'awa', id: 'awa', label: 'AWA', unit: '°', angular: false, dp: 0 },
  { key: 'twd', id: 'twd', label: 'TWD', unit: '°', angular: true, dp: 0 },
  { key: 'tws', id: 'tws', label: 'TWS', unit: 'kn', angular: false, dp: 1 },
  { key: 'aws', id: 'aws', label: 'AWS', unit: 'kn', angular: false, dp: 1 },
  { key: 'heel', id: 'heel', label: 'HEEL', unit: '°', angular: false, dp: 1 },
  { key: 'rudder', id: 'rudder', label: 'RUDDER', unit: '°', angular: false, dp: 1 },
  { key: 'pitch', id: 'pitch', label: 'PITCH', unit: '°', angular: false, dp: 1 },
];
const chById = (id) => ALL_CHANNELS.find((c) => c.id === id);
const DEFAULT_STRIPS = ['bs', 'cog', 'twa', 'heel', 'rudder', 'twd', 'tws'];
const STRIPS_KEY = 'boat-receiver:strips:v1';
const TF_KEY = 'boat-receiver:stripwin:v1';
function loadStrips() { try { const r = localStorage.getItem(STRIPS_KEY); if (r) return JSON.parse(r); } catch (_) {} return DEFAULT_STRIPS.slice(); }
function saveStrips() { try { localStorage.setItem(STRIPS_KEY, JSON.stringify(state.strips)); } catch (_) {} }
function loadStripWin() { try { const r = localStorage.getItem(TF_KEY); if (r) return +r; } catch (_) {} return STRIP_WINDOW_MS; }
function saveStripWin() { try { localStorage.setItem(TF_KEY, String(state.stripWindowMs)); } catch (_) {} }

state.strips = loadStrips();
state.stripWindowMs = loadStripWin();

let trackMap = null;
const strips = {};   // id -> StripChart
function twaVal(l) { return (l.cog != null && l.twd != null) ? S.twa(l.cog, l.twd) : l.twa; }

function buildStrips() {
  const wrap = $('strips'); if (!wrap) return;
  for (const id of Object.keys(strips)) { try { strips[id].destroy(); } catch (_) {} delete strips[id]; }
  wrap.innerHTML = '';
  for (const id of state.strips) {
    const ch = chById(id); if (!ch) continue;
    const fig = document.createElement('figure');
    fig.className = 'strip'; fig.dataset.id = id;
    fig.innerHTML =
      `<figcaption><span class="strip__name">${ch.label}</span> <span class="strip__unit">${ch.unit}</span>` +
      `<span class="strip__vals" id="val-${id}"></span>` +
      `<button class="strip__del" type="button" title="Remove" aria-label="Remove">&times;</button></figcaption>` +
      `<div class="strip__body"><canvas></canvas><div class="strip__avgbox" id="avg-${id}"></div></div>`;
    wrap.appendChild(fig);
    fig.querySelector('.strip__del').addEventListener('click', () => {
      state.strips = state.strips.filter((x) => x !== id); saveStrips(); buildStrips();
    });
    if (typeof StripChart !== 'undefined') strips[id] = new StripChart(fig.querySelector('canvas'));
  }
}

function initDashboard() {
  if (trackMap || typeof TrackMap === 'undefined') return;
  const mapC = $('map'); if (!mapC) return;
  trackMap = new TrackMap(mapC);
  buildStrips();
}

function sampleHistory(now) {
  for (const rt of state.rt.values()) {
    const l = rt.live;
    if (!l || !l.ts || (now - l.ts) >= LIVE_MS) continue;   // only sample fresh data
    const snap = { t: now, twa: twaVal(l) };
    for (const ch of ALL_CHANNELS) if (ch.key !== 'twa') snap[ch.key] = l[ch.key];
    rt.hist.push(snap);
    const cut = now - HIST_MS;
    while (rt.hist.length && rt.hist[0].t < cut) rt.hist.shift();

    // running per-channel average since the test started
    if (state.test && state.test.running) {
      if (!rt.tavg) rt.tavg = {};
      for (const ch of ALL_CHANNELS) {
        const v = snap[ch.key];
        if (v == null || Number.isNaN(v)) continue;
        const acc = rt.tavg[ch.key] || (rt.tavg[ch.key] = { sum: 0, sin: 0, cos: 0, n: 0 });
        acc.n++; acc.sum += v; const r = v * Math.PI / 180; acc.sin += Math.sin(r); acc.cos += Math.cos(r);
      }
    }

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

  const win = state.stripWindowMs;
  const t0 = now - win;
  for (const id of state.strips) {
    const ch = chById(id); if (!ch) continue;
    if (strips[id]) {
      const series = rts.map((rt) => {
        const pts = rt.hist.filter((h) => h.t >= t0);
        const step = Math.max(1, Math.ceil(pts.length / 600));   // decimate for long windows
        return { color: rt.color, points: pts.filter((_, i) => i % step === 0).map((h) => ({ t: h.t, y: h[ch.key] })) };
      });
      strips[id].setSeries(series, { now, windowMs: win, angular: ch.angular });
    }
    const valEl = $(`val-${id}`);
    if (valEl) {
      valEl.innerHTML = rts.map((rt) => {
        const v = ch.key === 'twa' ? twaVal(rt.live) : rt.live[ch.key];
        const txt = (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(ch.dp);
        return `<span style="color:${rt.color}">${txt}</span>`;
      }).join('<span class="strip__sep">·</span>');
    }
    const avgEl = $(`avg-${id}`);
    if (avgEl) {
      const rows = rts.map((rt) => {
        const acc = state.test && rt.tavg && rt.tavg[ch.key];
        const txt = (!acc || !acc.n) ? '—'
          : (ch.angular ? (Math.atan2(acc.sin, acc.cos) * 180 / Math.PI + 360) % 360 : acc.sum / acc.n).toFixed(ch.dp);
        return `<span class="avgrow"><span class="avgdot" style="background:${rt.color}"></span><span class="avgval" style="color:${rt.color}">${txt}</span></span>`;
      }).join('');
      avgEl.innerHTML = `<span class="avglabel">avg${state.test ? '' : ' · run a test'}</span>${rows}`;
    }
  }
}

/* strip controls: timeframe + add/remove */
function refreshTF() {
  for (const btn of $('tf').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(+btn.dataset.min * 60000 === state.stripWindowMs));
  }
}
for (const btn of $('tf').querySelectorAll('button')) {
  btn.addEventListener('click', () => { state.stripWindowMs = +btn.dataset.min * 60000; saveStripWin(); refreshTF(); });
}
function openStripPicker() {
  const list = $('chan-list'); list.innerHTML = '';
  const avail = ALL_CHANNELS.filter((c) => !state.strips.includes(c.id));
  if (!avail.length) { list.innerHTML = '<p class="modal__hint">All variables are already shown.</p>'; }
  for (const c of avail) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'chan-btn'; btn.textContent = `${c.label} (${c.unit})`;
    btn.addEventListener('click', () => { state.strips.push(c.id); saveStrips(); buildStrips(); $('strip-modal').hidden = true; });
    list.appendChild(btn);
  }
  $('strip-modal').hidden = false;
}
$('add-strip').addEventListener('click', openStripPicker);
$('strip-cancel').addEventListener('click', () => { $('strip-modal').hidden = true; });
refreshTF();

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

/* ---------- setup modal ---------- */
let pendingTest = null;
function openSetup(type) {
  pendingTest = type;
  $('duration-title').textContent = `${type} test`;
  $('duration-input').value = '5';
  const wp = $('wp-fields');
  if (type === 'VMG') { wp.hidden = true; }
  else {
    wp.hidden = false;
    const rt0 = [...state.rt.values()][0];
    const hd = rt0 && rt0.live ? (rt0.live.hdg != null ? rt0.live.hdg : rt0.live.cog) : null;
    $('wp-brg').value = hd != null ? Math.round(hd) : 0;
    $('wp-rng').value = type === 'VMC' ? '20' : '2';
  }
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

function startTest(type, durationSec, wpRngNm, wpBrg) {
  const boats = testBoats();
  if (boats.length < 2) { alert('The test compares two boats. Configure both in Settings.'); return; }

  for (const b of boats) b.rt.tavg = {};   // reset strip averages for this test

  state.test = {
    type, durationSec, startTs: Date.now(), running: true,
    boats, refId: boats[0].id, twdRef: null,
    samples: [], waypoint: null, trimSec: 0, result: null,
    wp: (type === 'VMG') ? null : { rngM: (wpRngNm || (type === 'VMC' ? 20 : 2)) * NM_TO_M, brg: wpBrg || 0 },
    series: { primary: [], up: [], fwd: [] },
    timer: null,
  };

  $('test-title').textContent = `${type} test`;
  $('test-duration').textContent = mmss(durationSec);
  $('test-status').textContent = 'Running';
  $('test-stop').hidden = false;
  $('test-review').hidden = true;
  $('test-view').hidden = false;

  buildRefSwitch(boats);
  buildTiles(type);
  if (!chartVMG) chartVMG = new LineChart($('chart-vmg'));
  if (!chartUP) chartUP = new LineChart($('chart-up'));

  clearInterval(state.test.timer);
  state.test.timer = setInterval(sampleTest, 1000);
  sampleTest();
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
function buildTiles(type) {
  const wrap = $('test-tiles'); wrap.innerHTML = '';
  for (const k of Object.keys(tileEls)) delete tileEls[k];
  const primary = type === 'VMG' ? 'VMG' : (type === 'VMC' ? 'VMC' : 'TWA');
  tileEls.dvmg = tile(wrap, 'delta', `${primary} gain`, 'delta');
  tileEls.rate = tile(wrap, 'delta', `${primary} gain / min`, 'delta');
  if (type === 'VMG') tileEls.dfwd = tile(wrap, 'delta', 'FWD/BACK gain', 'delta');
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

const NM_TO_M = 1852;
function destPoint(lat, lon, brgDeg, distM) {
  const LAT_M = 111132, lonM = 111320 * Math.cos(lat * Math.PI / 180);
  const r = brgDeg * Math.PI / 180;
  return { lat: lat + (distM * Math.cos(r)) / LAT_M, lon: lon + (distM * Math.sin(r)) / lonM };
}
// Working samples after trimming the last trimSec seconds.
function effectiveSamples(t) {
  if (!t.samples.length) return [];
  const cut = t.samples[t.samples.length - 1].t - (t.trimSec || 0) * 1000;
  return t.samples.filter((s) => s.t <= cut);
}

function sampleTest() {
  const t = state.test; if (!t || !t.running) return;
  const now = Date.now();
  const p = t.boats.map((b) => {
    const l = b.rt.live;
    const fresh = l && (now - (l.ts || 0)) < LIVE_MS;
    return (fresh && l.lat != null && l.lon != null) ? { lat: l.lat, lon: l.lon, twd: l.twd } : null;
  });
  if (p[0] && p[1]) {
    t.samples.push({ t: now, p });
    // Create the waypoint(s) at the first paired sample.
    if (!t.waypoints && t.wp && t.samples.length >= 1) {
      const s0 = t.samples[0];
      const rIdx = Math.max(0, t.boats.findIndex((b) => b.id === t.refId));
      if (t.type === 'VMC') {
        // one waypoint from the master (reference) boat's start position
        const rp = s0.p[rIdx];
        t.waypoints = [destPoint(rp.lat, rp.lon, t.wp.brg, t.wp.rngM)];
      } else {
        // TWA: one waypoint per boat, from each boat's own start position
        t.waypoints = s0.p.map((pp) => destPoint(pp.lat, pp.lon, t.wp.brg, t.wp.rngM));
      }
    }
  }
  renderTest();
  const elapsed = (now - t.startTs) / 1000;
  $('test-elapsed').textContent = mmss(Math.min(elapsed, t.durationSec));
  $('test-progress').style.width = `${Math.min(100, (elapsed / t.durationSec) * 100)}%`;
  if (elapsed >= t.durationSec) finishTest('Complete');
}

// Per-type gains, following the spec.
//   VMG:  primary = separation on the TWD axis (sign flips downwind);
//         FWD/BACK & UP/DOWN from the average-path frame.
//   VMC:  primary = separation on the bearing to the single (master) waypoint;
//         UP/DOWN = change in |separation on the perpendicular of that bearing|.
//   TWA:  primary = (other's distance to its waypoint − ref's distance to its
//         waypoint); UP/DOWN = change in |separation on the perpendicular of the
//         target bearing|.  Every GAIN = value(now) − value(start).
function computeGains(t) {
  const work = effectiveSamples(t);
  const refIdx = Math.max(0, t.boats.findIndex((b) => b.id === t.refId));
  const othIdx = refIdx === 0 ? 1 : 0;
  const res = { series: { primary: [], up: [], fwd: [] }, cur: null, twdOverall: null, downwind: false, refIdx, othIdx, type: t.type };
  if (work.length < 1) return res;

  const origin = work[0].p[0];
  const P = (s, i) => enu(s.p[i].lat, s.p[i].lon, origin.lat, origin.lon);
  const wpE = t.waypoints ? t.waypoints.map((w) => enu(w.lat, w.lon, origin.lat, origin.lon)) : null;

  const pos0 = [P(work[0], 0), P(work[0], 1)];
  const sep0 = { e: pos0[refIdx].e - pos0[othIdx].e, n: pos0[refIdx].n - pos0[othIdx].n };
  const mid0 = { e: (pos0[0].e + pos0[1].e) / 2, n: (pos0[0].n + pos0[1].n) / 2 };

  // VMG downwind sign (overall track vs the wind)
  let vmgSign = 1;
  if (t.type === 'VMG') {
    const allTwd = []; for (const s of work) for (const b of s.p) if (b.twd != null) allTwd.push(b.twd);
    const twdAll = circMeanDeg(allTwd);
    if (twdAll != null) {
      const r = twdAll * Math.PI / 180;
      const lm = { e: (P(work[work.length - 1], 0).e + P(work[work.length - 1], 1).e) / 2, n: (P(work[work.length - 1], 0).n + P(work[work.length - 1], 1).n) / 2 };
      if ((lm.e - mid0.e) * Math.sin(r) + (lm.n - mid0.n) * Math.cos(r) < 0) vmgSign = -1;
    }
  }
  res.downwind = vmgSign < 0;
  const brgRad = (t.wp ? t.wp.brg : 0) * Math.PI / 180;
  const brgAxis = { x: Math.sin(brgRad), y: Math.cos(brgRad) };

  let sSin = 0, sCos = 0;
  const addTwd = (s) => { for (const b of s.p) if (b.twd != null) { const r = b.twd * Math.PI / 180; sSin += Math.sin(r); sCos += Math.cos(r); } };

  // returns { adv, perpAbs, fwd, up } for sample k (adv/perpAbs are absolute values, not gains)
  function calc(k) {
    const posk = [P(work[k], 0), P(work[k], 1)];
    const sepk = { e: posk[refIdx].e - posk[othIdx].e, n: posk[refIdx].n - posk[othIdx].n };
    const midk = { e: (posk[0].e + posk[1].e) / 2, n: (posk[0].n + posk[1].n) / 2 };

    if (t.type === 'VMG') {
      const twdK = (sSin === 0 && sCos === 0) ? null : (Math.atan2(sSin, sCos) * 180 / Math.PI + 360) % 360;
      res.twdOverall = twdK;
      let adv = null, ax = null;
      if (twdK != null) { const r = twdK * Math.PI / 180; ax = { x: Math.sin(r) * vmgSign, y: Math.cos(r) * vmgSign }; adv = sepk.e * ax.x + sepk.n * ax.y; }
      let fwd = null, up = null;
      const aE = midk.e - mid0.e, aN = midk.n - mid0.n, al = Math.hypot(aE, aN);
      if (al >= 1) {
        const ux = aE / al, uy = aN / al; let px = -uy, py = ux;
        if (ax && (px * ax.x + py * ax.y) < 0) { px = -px; py = -py; }
        const dE = sepk.e - sep0.e, dN = sepk.n - sep0.n;
        fwd = dE * ux + dN * uy; up = dE * px + dN * py;
      }
      return { adv, fwd, up, isDelta: true };   // fwd/up already are deltas
    }

    if (t.type === 'VMC') {
      if (!wpE) return { adv: null, perpAbs: null };
      const wp = wpE[0], vx = wp.e - midk.e, vy = wp.n - midk.n, l = Math.hypot(vx, vy);
      if (l < 1e-6) return { adv: null, perpAbs: null };
      const ax = { x: vx / l, y: vy / l };
      const adv = sepk.e * ax.x + sepk.n * ax.y;
      const perpAbs = Math.abs(sepk.e * (-ax.y) + sepk.n * ax.x);
      return { adv, perpAbs };
    }

    // TWA
    if (!wpE) return { adv: null, perpAbs: null };
    const dRef = Math.hypot(wpE[refIdx].e - posk[refIdx].e, wpE[refIdx].n - posk[refIdx].n);
    const dOth = Math.hypot(wpE[othIdx].e - posk[othIdx].e, wpE[othIdx].n - posk[othIdx].n);
    const adv = dOth - dRef;   // ref closer to its target ⇒ positive
    const perpAbs = Math.abs(sepk.e * (-brgAxis.y) + sepk.n * brgAxis.x);
    return { adv, perpAbs };
  }

  addTwd(work[0]);
  const base = calc(0);
  const adv0 = base.adv != null ? base.adv : 0;
  const perp0 = base.perpAbs != null ? base.perpAbs : 0;

  let cur = null;
  for (let k = 1; k < work.length; k++) {
    addTwd(work[k]);
    const c = calc(k);
    const x = (work[k].t - work[0].t) / 1000;
    let primary = null, up = null, fwd = null;
    if (c.adv != null) primary = c.adv - adv0;
    if (t.type === 'VMG') { fwd = c.fwd; up = c.up; }
    else if (c.perpAbs != null) up = c.perpAbs - perp0;
    if (primary != null) res.series.primary.push({ x, y: primary });
    if (up != null) res.series.up.push({ x, y: up });
    if (fwd != null) res.series.fwd.push({ x, y: fwd });
    cur = { primary, up, fwd, t: work[k].t };
  }
  res.cur = cur;
  return res;
}

function renderTest() {
  const t = state.test; if (!t) return;
  const g = computeGains(t);
  const ref = t.boats[g.refIdx], other = t.boats[g.othIdx];
  const primaryLabel = t.type === 'VMG' ? 'VMG' : (t.type === 'VMC' ? 'VMC' : 'TWA');

  let meta = `Ref <b style="color:${ref.color}">${ref.name}</b>`;
  if (t.type === 'VMG') meta += ` · TWD used ${g.twdOverall == null ? '—' : String(Math.round(g.twdOverall)).padStart(3, '0') + '°'}` + (g.downwind ? ' · downwind' : ' · upwind');
  else if (t.wp) meta += ` · WP ${String(Math.round(t.wp.brg)).padStart(3, '0')}° / ${(t.wp.rngM / NM_TO_M).toFixed(1)} nm` + (t.type === 'TWA' ? ' (per boat)' : ' (from master)');
  $('test-meta').innerHTML = meta;

  const blank = (k) => setDelta(k, 0, '', '', 0, true);
  if (!g.cur) { ['dvmg', 'rate', 'dfwd', 'dup'].forEach(blank); t.result = null; }
  else {
    const cur = g.cur;
    const mins = (cur.t - effectiveSamples(t)[0].t) / 60000;
    if (cur.primary != null) {
      setDelta('dvmg', cur.primary, 'm', g.downwind ? `${primaryLabel} gain (downwind)` : `${primaryLabel} gain`);
      setDelta('rate', mins > 0 ? cur.primary / mins : 0, 'm/min', `${primaryLabel} gain ÷ min`, 1);
    } else { blank('dvmg'); blank('rate'); }
    if (t.type === 'VMG') { if (cur.fwd != null) setDelta('dfwd', cur.fwd, 'm', 'along average path'); else blank('dfwd'); }
    if (cur.up != null) setDelta('dup', cur.up, 'm', t.type === 'VMG' ? 'perp of avg path' : 'perp of WP bearing'); else blank('dup');

    const winner = (cur.primary == null || Math.abs(cur.primary) < 0.05) ? '—' : (cur.primary > 0 ? ref.name : other.name);
    t.result = {
      type: t.type, startTs: t.startTs,
      durationSec: Math.round((cur.t - effectiveSamples(t)[0].t) / 1000),
      winner, primaryLabel,
      rate: (cur.primary != null && mins > 0) ? cur.primary / mins : null,
      fwd: cur.fwd, up: cur.up,
    };
  }

  if (chartVMG) chartVMG.setSeries([{ label: `${primaryLabel} gain`, color: '#37e0cf', points: g.series.primary }], { xMax: t.durationSec, includeZero: true });
  if (chartUP) {
    const s = [{ label: 'UP/DOWN', color: '#37e0cf', points: g.series.up }];
    if (t.type === 'VMG') s.push({ label: 'FWD/BACK', color: '#ff8a5b', points: g.series.fwd });
    chartUP.setSeries(s, { xMax: t.durationSec, includeZero: true });
  }
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
  $('test-review').hidden = false;
  $('trim-sec').value = '0';
  renderTest();
}
function applyTrim() {
  const t = state.test; if (!t) return;
  t.trimSec = Math.max(0, parseInt($('trim-sec').value, 10) || 0);
  $('test-status').textContent = t.trimSec > 0 ? `Trimmed −${t.trimSec}s` : 'Stopped';
  renderTest();
}
function saveTest() {
  const t = state.test; if (!t) return;
  renderTest();
  if (t.result) {
    t.result.avg = computeTestAverages(t);
    t.result.boats = t.boats.map((b) => b.name);
    history.unshift(t.result); saveHistory(); renderHistory();
  }
  closeTest();
}
function closeTest() {
  if (state.test) clearInterval(state.test.timer);
  state.test = null;
  $('test-view').hidden = true;
  $('test-review').hidden = true;
  $('ref-switch').innerHTML = '';
  $('test-meta').innerHTML = '';
  gateControls();
}

// Whole-test average of each channel, per boat, over the (trimmed) test window.
const AVG_CH = [
  { key: 'bsp', label: 'BS', angular: false, dp: 1 },
  { key: 'tws', label: 'TWS', angular: false, dp: 1 },
  { key: 'twd', label: 'TWD', angular: true, dp: 0 },
  { key: 'hdg', label: 'HDG', angular: true, dp: 0 },
  { key: 'cog', label: 'COG', angular: true, dp: 0 },
  { key: 'sog', label: 'SOG', angular: false, dp: 1 },
  { key: 'heel', label: 'HEEL', angular: false, dp: 1 },
  { key: 'rudder', label: 'RUD', angular: false, dp: 1 },
];
function computeTestAverages(t) {
  const eff = effectiveSamples(t);
  const endT = eff.length ? eff[eff.length - 1].t : Date.now();
  return t.boats.map((b) => {
    const hist = (b.rt.hist || []).filter((h) => h.t >= t.startTs && h.t <= endT);
    const o = {};
    for (const ch of AVG_CH) {
      let s = 0, c = 0, sum = 0, n = 0;
      for (const h of hist) { const v = h[ch.key]; if (v == null || Number.isNaN(v)) continue; n++; sum += v; const r = v * Math.PI / 180; s += Math.sin(r); c += Math.cos(r); }
      o[ch.key] = n ? (ch.angular ? (Math.atan2(s, c) * 180 / Math.PI + 360) % 360 : sum / n) : null;
    }
    return o;
  });
}

/* ---------- test history ---------- */
const HISTORY_KEY = 'boat-receiver:history:v1';
let history = [];
function loadHistory() { try { const r = localStorage.getItem(HISTORY_KEY); if (r) history = JSON.parse(r); } catch (_) { history = []; } }
function saveHistory() { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 200))); } catch (_) {} }
function clearHistory() {
  if (!history.length) return;
  if (!confirm('Clear all saved test results?')) return;
  history = []; saveHistory(); renderHistory();
}
function fmtDateTime(ts) { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function num(v, dp) { return (v == null || Number.isNaN(v)) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(+v.toFixed(dp)); }
function avgCell(r, key, dp) {
  if (!r.avg) return '—';
  const f = (x) => (x == null || Number.isNaN(x)) ? '—' : (+x).toFixed(dp);
  return `${f(r.avg[0] && r.avg[0][key])}/${f(r.avg[1] && r.avg[1][key])}`;
}
function renderHistory() {
  const body = $('history-body'); if (!body) return;
  body.innerHTML = '';
  $('history').hidden = history.length === 0;
  for (const r of history) {
    const tr = document.createElement('tr');
    const cells = [
      fmtDateTime(r.startTs), r.type, mmss(r.durationSec), r.winner,
      r.rate == null ? '—' : `${num(r.rate, 1)} m/min`,
      num(r.fwd, 0), num(r.up, 0),
      ...AVG_CH.map((ch) => avgCell(r, ch.key, ch.dp)),
    ];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    body.appendChild(tr);
  }
}
function exportCSV() {
  const head = ['Date', 'Type', 'Duration', 'Winner', 'Gain rate (m/min)', 'FWD/BACK (m)', 'UP/DOWN (m)'];
  for (const bi of [0, 1]) for (const ch of AVG_CH) head.push(`Boat${bi + 1} avg ${ch.label}`);
  head.push('Boat1 name', 'Boat2 name');
  const val = (x, dp) => (x == null || Number.isNaN(x)) ? '' : (+x).toFixed(dp);
  const rows = history.map((r) => {
    const row = [
      fmtDateTime(r.startTs), r.type, mmss(r.durationSec), r.winner,
      r.rate == null ? '' : r.rate.toFixed(1),
      r.fwd == null ? '' : r.fwd.toFixed(0),
      r.up == null ? '' : r.up.toFixed(0),
    ];
    for (const bi of [0, 1]) for (const ch of AVG_CH) row.push(val(r.avg && r.avg[bi] && r.avg[bi][ch.key], ch.dp));
    row.push((r.boats && r.boats[0]) || '', (r.boats && r.boats[1]) || '');
    return row;
  });
  const csv = [head, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `boat-tests-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function mmss(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/* ---------- wiring ---------- */
$('role-master').addEventListener('click', () => { setRole('master'); $('role-modal').hidden = true; });
$('role-viewer').addEventListener('click', () => { setRole('viewer'); $('role-modal').hidden = true; });

$('btn-vmg').addEventListener('click', () => { if (state.role === 'master') openSetup('VMG'); });
$('btn-vmc').addEventListener('click', () => { if (state.role === 'master') openSetup('VMC'); });
$('btn-twa').addEventListener('click', () => { if (state.role === 'master') openSetup('TWA'); });

$('test-stop').addEventListener('click', () => finishTest('Stopped'));
$('trim-apply').addEventListener('click', applyTrim);
$('test-discard').addEventListener('click', closeTest);
$('test-save').addEventListener('click', saveTest);
$('export-csv').addEventListener('click', exportCSV);
$('clear-history').addEventListener('click', clearHistory);

$('duration-start').addEventListener('click', () => {
  const mins = Math.max(1, parseInt($('duration-input').value, 10) || 5);
  $('duration-modal').hidden = true;
  let rng = null, brg = null;
  if (pendingTest !== 'VMG') {
    rng = parseFloat($('wp-rng').value) || (pendingTest === 'VMC' ? 20 : 2);
    brg = ((parseFloat($('wp-brg').value) || 0) % 360 + 360) % 360;
  }
  startTest(pendingTest, mins * 60, rng, brg);
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
loadHistory();
renderHistory();
const savedRole = loadRole();
if (savedRole) { setRole(savedRole); $('role-modal').hidden = true; }
else { $('role-modal').hidden = false; }
gateControls();
