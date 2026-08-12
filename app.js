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
}, 500);

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
  if (!state.test) {
    $('ready-text').textContent = isMaster
      ? 'Select a test to begin.'
      : 'Waiting for the master to start a test.';
  }
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
  // Use the first two configured boats.
  return [...state.rt.values()].slice(0, 2).map((rt, i) => ({
    id: rt.def.id, name: rt.def.name, color: rt.color, rt,
    vmg: 0, up: 0, fwd: 0, key: i === 0 ? 'b1' : 'b2',
    vmgSeries: [], upSeries: [],
  }));
}

function startVMG(durationSec) {
  const boats = testBoats();
  if (!boats.length) { alert('No boats connected. Add them in Settings.'); return; }

  state.test = {
    type: 'VMG', durationSec, startTs: Date.now(), lastTs: Date.now(),
    running: true, boats, timer: null,
  };

  $('test-title').textContent = 'VMG test';
  $('test-duration').textContent = mmss(durationSec);
  $('test-status').textContent = 'Running';
  $('test-stop').hidden = false;
  $('test-close').hidden = true;
  $('ready-state').hidden = true;
  $('test-view').hidden = false;

  buildTiles(boats);
  if (!chartVMG) chartVMG = new LineChart($('chart-vmg'));
  if (!chartUP) chartUP = new LineChart($('chart-up'));
  chartVMG.setSeries([], {});
  chartUP.setSeries([], {});

  clearInterval(state.test.timer);
  state.test.timer = setInterval(sampleVMG, 1000);
  sampleVMG();
}

const tileEls = {};
function buildTiles(boats) {
  const wrap = $('test-tiles'); wrap.innerHTML = '';
  for (const b of boats) {
    for (const m of [['vmg', 'VMG now', 'kn'], ['up', `${b.name} \u2191 windward`, 'm'],
                     ['fwd', `${b.name} sailed`, 'm'], ['rate', `${b.name} VMG/min`, 'm/min']]) {
      tileEls[`${b.id}:${m[0]}`] = tile(wrap, b.key, m[0] === 'vmg' ? `${b.name} VMG` : m[1]);
    }
  }
  if (boats.length >= 2) tileEls.delta = tile(wrap, 'delta', 'Windward gain (B1 \u2212 B2)', 'delta');
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

function sampleVMG() {
  const t = state.test; if (!t || !t.running) return;
  const now = Date.now();
  const elapsed = (now - t.startTs) / 1000;
  const dt = (now - t.lastTs) / 1000;
  t.lastTs = now;

  for (const b of t.boats) {
    const l = b.rt.live;
    if (l && l.sog != null && l.cog != null && l.twd != null && (now - (l.ts || 0)) < LIVE_MS) {
      b.vmg = S.vmg(l.sog, l.cog, l.twd);
      b.up += S.dist(b.vmg, dt);
      b.fwd += S.dist(l.sog, dt);
    }
    b.vmgSeries.push({ x: elapsed, y: b.vmg });
    b.upSeries.push({ x: elapsed, y: b.up });

    setTile(`${b.id}:vmg`, b.vmg.toFixed(2), 'kn');
    setTile(`${b.id}:up`, Math.round(b.up), 'm made good');
    setTile(`${b.id}:fwd`, Math.round(b.fwd), 'm over ground');
    setTile(`${b.id}:rate`, elapsed > 0 ? (b.up / (elapsed / 60)).toFixed(0) : '0', 'm/min');
  }
  if (t.boats.length >= 2 && tileEls.delta) {
    const d = t.boats[0].up - t.boats[1].up;
    setTile('delta', `${d >= 0 ? '+' : ''}${d.toFixed(0)}`, d >= 0 ? `${t.boats[0].name} ahead` : `${t.boats[1].name} ahead`);
  }

  chartVMG.setSeries(t.boats.map((b) => ({ label: b.name, color: b.color, points: b.vmgSeries })),
    { xMax: t.durationSec, includeZero: true });
  chartUP.setSeries(t.boats.map((b) => ({ label: b.name, color: b.color, points: b.upSeries })),
    { xMax: t.durationSec, includeZero: true });

  $('test-elapsed').textContent = mmss(Math.min(elapsed, t.durationSec));
  $('test-progress').style.width = `${Math.min(100, (elapsed / t.durationSec) * 100)}%`;

  if (elapsed >= t.durationSec) finishTest('Complete');
}
function setTile(key, value, sub) {
  const el = tileEls[key]; if (!el) return;
  el.querySelector('.tile__value').textContent = value;
  if (sub != null) el.querySelector('.tile__sub').textContent = sub;
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
  $('ready-state').hidden = false;
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
  $('test-tiles').innerHTML = `<div class="tile"><span class="tile__label">${type} test</span><span class="tile__value" style="font-size:15px">Coming next</span><span class="tile__sub">Send the spec (VMC needs a target bearing/mark) and this fills in.</span></div>`;
  $('test-progress').style.width = '0%';
  $('test-stop').hidden = true;
  $('test-close').hidden = false;
  $('ready-state').hidden = true;
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
