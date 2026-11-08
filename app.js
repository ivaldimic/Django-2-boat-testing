'use strict';

/* Boat data receiver — app logic.
 * Connections (one WebSocket per boat), the live dashboard, master/viewer
 * roles, and the test view. The tests themselves run on the server
 * (testengine.js in the relay, bridge or simulator): the master sends it
 * commands and every client shows the state it broadcasts. */

const BOATS_KEY = 'boat-receiver:boats:v1';
const ROLE_KEY = 'boat-receiver:role:v1';
const MAX_LINES = 120;
const LIVE_MS = 3000;
const RECONNECT_MAX_MS = 8000;
const COLORS = ['#0d9488', '#ea580c', '#7c3aed', '#0369a1'];
const STRIP_WINDOW_MS = 120000;   // default strip window (2 minutes)
const HIST_MS = 1210000;          // keep ~20 min so the 20-minute window works
const TRACK_MS = 600000;          // keep up to 10 minutes of track
const SAMPLE_MS = 500;            // history sample + dashboard redraw cadence

const S = globalThis.SailMath;
const FP = globalThis.FeedParse;
const $ = (id) => document.getElementById(id);

const state = {
  role: null,
  boats: [],              // [{id,name,url}]
  rt: new Map(),          // id -> runtime
  test: null,              // mirror of the server's test (see onTestState)
  testSeq: -1, testBoot: null,
  sep: null,               // last boat separation from the server
  refId: loadRef(),
};

/* ---------- persistence ---------- */
function loadBoats() {
  try { const r = localStorage.getItem(BOATS_KEY); if (r) return JSON.parse(r); } catch (_) {}
  return (window.DEFAULT_BOATS || []).map((b) => ({ ...b }));
}
function saveBoats(list) { try { localStorage.setItem(BOATS_KEY, JSON.stringify(list)); } catch (_) {} }
function loadRole() { try { return localStorage.getItem(ROLE_KEY); } catch (_) { return null; } }
function saveRole(r) { try { localStorage.setItem(ROLE_KEY, r); } catch (_) {} }
// Reference boat: each user picks their own (not synced); range/bearing, map
// range lines and test gains are all measured from it to the other boat(s).
const REF_KEY = 'boat-receiver:ref:v1';
function loadRef() { try { return localStorage.getItem(REF_KEY); } catch (_) { return null; } }
function saveRef(id) { try { localStorage.setItem(REF_KEY, id); } catch (_) {} }

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
  buildDashRefSwitch();
}

/* ---------- reference boat ---------- */
// The saved choice if that boat still exists, otherwise the first boat.
function currentRefId() {
  if (state.rt.has(state.refId)) return state.refId;
  const first = state.rt.keys().next();
  return first.done ? null : first.value;
}
// A test compares two boats; use the user's reference if it is one of them.
function testRefId(boats) {
  const id = currentRefId();
  return boats.some((b) => b.id === id) ? id : boats[0].id;
}
function setRef(id) {
  state.refId = id; saveRef(id);
  for (const s of document.querySelectorAll('#rb-ref .seg')) s.setAttribute('aria-pressed', String(s.dataset.id === currentRefId()));
  if (state.test) { updateRefSwitchPressed(); renderTest(); }
  renderDashboard(Date.now());
}
function buildDashRefSwitch() {
  const wrap = $('rb-ref'); if (!wrap) return;
  wrap.innerHTML = '';
  const ref = currentRefId();
  for (const rt of state.rt.values()) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'seg';
    btn.textContent = rt.def.name;
    btn.style.borderColor = rt.color;
    btn.dataset.id = rt.def.id;
    btn.setAttribute('aria-pressed', String(rt.def.id === ref));
    btn.addEventListener('click', () => setRef(rt.def.id));
    wrap.appendChild(btn);
  }
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
  ws.onopen = () => { rt.retry = 0; rt.conn = 'open'; rt.badToken = false; };
  ws.onmessage = (ev) => handleFrame(rt, ev.data);
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
  ws.onclose = (ev) => {
    rt.ws = null; rt.conn = 'closed'; rt.badToken = ev.code === 4001;   // 4001: relay rejected the token
    rt.srv = null; gateControls();
    scheduleReconnect(rt);
  };
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
  // Control messages (channel names, server test state) arrive as single JSON frames.
  const trimmed = data.trim();
  if (trimmed.startsWith('{')) {
    try {
      const m = JSON.parse(trimmed);
      if (m && m.ctl) { if (m.kind === 'channels') setExpChannels(m.channels); else handleControl(rt, m); return; }
    } catch (_) {}
  }
  const ts = Date.now();
  for (const line of FP.splitLines(data)) onLine(rt, line, ts);
}
function onLine(rt, raw, ts) {
  rt.count += 1;
  rt.lastTs = ts;
  rt.times.push(ts);
  const cut = ts - 5000;
  while (rt.times.length && rt.times[0] < cut) rt.times.shift();
  FP.parseLine(raw, rt.live);
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

/* ---------- Expedition channels ---------- */
// Parsing lives in feedparse.js (shared with the servers); these are display hints.
const EXP_UNITS = { 9: '°', 10: '°', 11: '°', 12: 'kn', 17: 'm', 21: '°', 24: '°', 31: 'kn', 32: '°/s', 55: 'kn', 92: 'kn', 93: '°', 94: '°', 95: 'kn', 282: '°', 283: '°', 284: '°' };

// Channel names come from the bridge (Expedition's channels.xml), kept on this
// device so the dashboard keeps its labels before the bridge has sent them.
const EXPCH_KEY = 'boat-receiver:expchannels:v1';
const expDefs = new Map();   // ch number -> { name, prec }
try { for (const c of JSON.parse(localStorage.getItem(EXPCH_KEY) || '[]')) expDefs.set(c.id, c); } catch (_) {}
function setExpChannels(list) {
  if (!Array.isArray(list) || !list.length) return;
  let changed = false;
  for (const c of list) {
    if (!c || !Number.isFinite(c.id) || !c.name) continue;
    const old = expDefs.get(c.id);
    if (!old || old.name !== c.name || old.prec !== c.prec) { expDefs.set(c.id, { id: c.id, name: String(c.name), prec: c.prec }); changed = true; }
  }
  if (!changed) return;
  try { localStorage.setItem(EXPCH_KEY, JSON.stringify([...expDefs.values()])); } catch (_) {}
  if (state.strips.some((id) => id[0] === 'x')) buildStrips();   // pick up the new labels
}

/* ---------- status refresh ---------- */
function boatStatus(rt, now) {
  if (!rt.def.url) return 'idle';
  if (rt.badToken) return 'badtoken';
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
      st === 'live' ? 'Live' : st === 'stale' ? 'No data' : st === 'badtoken' ? 'Bad token' : st === 'down' ? 'Offline' : 'Idle';
    rt.pill.querySelector('.pill__rate').textContent = `${rate}/s`;
  }
  if (!$('drawer').hidden) renderStatusList(now);
  if (!$('strip-modal').hidden) updatePickerVals();
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
// Built-in channel, or an Expedition channel by its "x<number>" id.
function chById(id) {
  const c = ALL_CHANNELS.find((x) => x.id === id);
  if (c || !/^x\d+$/.test(id)) return c;
  const n = +id.slice(1), d = expDefs.get(n);
  return {
    key: id, id, num: n, label: d ? d.name : `Ch ${n}`, unit: EXP_UNITS[n] || '',
    angular: FP.isAngular(id), dp: d && Number.isFinite(d.prec) ? d.prec : 2,
  };
}
const escHTML = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
const twaVal = FP.twaVal;

function buildStrips() {
  const wrap = $('strips'); if (!wrap) return;
  for (const id of Object.keys(strips)) { try { strips[id].destroy(); } catch (_) {} delete strips[id]; }
  wrap.innerHTML = '';
  for (const id of state.strips) {
    const ch = chById(id); if (!ch) continue;
    const fig = document.createElement('figure');
    fig.className = 'strip'; fig.dataset.id = id;
    fig.innerHTML =
      `<figcaption><span class="strip__name">${escHTML(ch.label)}</span> <span class="strip__unit">${escHTML(ch.unit)}</span>` +
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
    for (const k in l) if (k[0] === 'x') snap[k] = l[k];   // Expedition channels
    rt.hist.push(snap);
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

  // Range & bearing from the reference boat to each other boat, as computed by
  // the server (it only knows the two test boats).
  const refIdx = Math.max(0, rts.findIndex((rt) => rt.def.id === currentRefId()));
  const ref = boats[refIdx];
  const links = [];
  const pairs = boats.map((b, i) => {
    if (i === refIdx) return '';
    let range = '—', bearing = '—';
    const rb = serverRangeBearing(refIdx, i, now);
    if (rb) {
      range = `${Math.round(rb.rangeM)} m`;
      bearing = `${String(Math.round(rb.bearingDeg) % 360).padStart(3, '0')}°`;
      links.push({ from: refIdx, to: i, range: rb.rangeM, bearing: rb.bearingDeg });
    }
    return `<div class="rb__pair">` +
      `<div class="rb__item"><span class="rb__label">Range</span><span class="rb__value">${range}</span></div>` +
      `<div class="rb__item"><span class="rb__label">Bearing</span><span class="rb__value">${bearing}</span></div>` +
      `<div class="rb__note"><span style="color:${ref.color}">${escHTML(ref.name)}</span> &rarr; <span style="color:${b.color}">${escHTML(b.name)}</span></div></div>`;
  }).join('');
  $('rb-pairs').innerHTML = pairs || '<div class="rb__note">Add a second boat in Settings.</div>';

  const marks = [];
  const t = state.test;
  if (t && t.waypoints) {
    if (t.type === 'VMC') { const w = t.waypoints[0]; if (w) marks.push({ name: 'VMC WP', lat: w.lat, lon: w.lon }); }
    else t.waypoints.forEach((w, k) => { const b = testBoatForSrv(k); if (w && b) marks.push({ name: b.name, lat: w.lat, lon: w.lon, color: b.color }); });
  }
  trackMap.setData({ boats, links, refIdx, marks });

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
      const rows = rts.map((rt, i) => {
        const v = testAvg(i, ch.key);
        const txt = v == null ? '—' : (+v).toFixed(ch.dp);
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
// Every channel that can be charted: the built-in ones, plus each Expedition
// channel some boat is sending (or that is already on the dashboard).
function availableChannels() {
  const nums = new Set();
  for (const rt of state.rt.values()) for (const k in rt.live) if (k[0] === 'x') nums.add(+k.slice(1));
  for (const id of state.strips) if (id[0] === 'x') nums.add(+id.slice(1));
  const exp = [...nums].sort((a, b) => a - b).map((n) => chById(`x${n}`));
  return { std: ALL_CHANNELS, exp };
}
function liveText(ch) {
  return [...state.rt.values()].map((rt) => {
    const v = ch.key === 'twa' ? twaVal(rt.live) : rt.live[ch.key];
    const txt = (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(ch.dp);
    return `<span style="color:${rt.color}">${txt}</span>`;
  }).join(' ');
}
function renderStripPicker() {
  const list = $('chan-list'); list.innerHTML = '';
  const q = $('chan-search').value.trim().toLowerCase();
  const match = (c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || (c.num != null && String(c.num) === q);
  const { std, exp } = availableChannels();
  const group = (title, chans) => {
    chans = chans.filter(match);
    if (!chans.length) return;
    const h = document.createElement('div'); h.className = 'chan-group'; h.textContent = title;
    list.appendChild(h);
    for (const c of chans) {
      const on = state.strips.includes(c.id);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'chan-btn'; btn.dataset.id = c.id;
      btn.setAttribute('aria-pressed', String(on));
      btn.innerHTML = `<span class="chan-btn__check" aria-hidden="true">${on ? '✓' : '+'}</span>` +
        `<span class="chan-btn__name">${escHTML(c.label)}${c.unit ? ` <span class="chan-btn__unit">${escHTML(c.unit)}</span>` : ''}</span>` +
        (c.num != null ? `<span class="chan-btn__num">#${c.num}</span>` : '') +
        `<span class="chan-btn__vals">${liveText(c)}</span>`;
      btn.addEventListener('click', () => {
        state.strips = on ? state.strips.filter((x) => x !== c.id) : [...state.strips, c.id];
        saveStrips(); buildStrips(); renderStripPicker();
      });
      list.appendChild(btn);
    }
  };
  group('Standard', std);
  group('Expedition channels', exp);
  const note = q ? (list.children.length ? '' : 'No channel matches.')
    : (exp.length ? '' : 'No Expedition channels received yet. They appear here once a boat sends Expedition-format data.');
  if (note) list.insertAdjacentHTML('beforeend', `<p class="modal__hint">${note}</p>`);
}
function updatePickerVals() {
  for (const btn of $('chan-list').querySelectorAll('.chan-btn')) {
    const c = chById(btn.dataset.id), el = btn.querySelector('.chan-btn__vals');
    if (c && el) el.innerHTML = liveText(c);
  }
}
function openStripPicker() {
  $('chan-search').value = '';
  renderStripPicker();
  $('strip-modal').hidden = false;
  if (matchMedia('(pointer: fine)').matches) $('chan-search').focus();   // no pop-up keyboard on tablets
}
$('chan-search').addEventListener('input', renderStripPicker);
$('add-strip').addEventListener('click', openStripPicker);
$('strip-cancel').addEventListener('click', () => { $('strip-modal').hidden = true; });
$('map-in').addEventListener('click', () => trackMap && trackMap.zoomAt(trackMap.W / 2, trackMap.H / 2, 1.3));
$('map-out').addEventListener('click', () => trackMap && trackMap.zoomAt(trackMap.W / 2, trackMap.H / 2, 1 / 1.3));
$('map-fit').addEventListener('click', () => trackMap && trackMap.fit());
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
  const engine = !!engineConn();   // a connected server that can run tests
  for (const b of $('tests').querySelectorAll('.test-btn')) {
    b.disabled = !isMaster || !engine;
    b.title = isMaster && !engine ? 'Waiting for a server that sees both boats' : '';
  }
  if (state.test) renderTest();    // the master's Stop / review controls
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
    info.textContent = st === 'live' ? `${rate}/s` : st === 'stale' ? 'no data' : st === 'badtoken' ? 'bad token' : st === 'down' ? 'offline' : 'idle';
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

/* ---------- tests (run on the server) ---------- */
// The server that sees both boats (relay, simulator, or a bridge with a peer)
// runs the test; see testengine.js. The master sends it commands, and every
// client, master included, shows the state the server broadcasts.
let chartVMG = null, chartUP = null;
const NM_TO_M = 1852;

function testBoats() {
  // Tests compare the first two configured boats.
  return [...state.rt.values()].slice(0, 2).map((rt) => ({
    id: rt.def.id, name: rt.def.name, color: rt.color, rt,
  }));
}
// Server boat index -> our test boat index. The connection a message came in on
// carries server boat `you`; the other server boat is our other test boat.
function srvMap(rt, you) {
  const i = testBoats().findIndex((b) => b.rt === rt);
  if (i < 0 || (you !== 0 && you !== 1)) return null;
  const map = []; map[you] = i; map[1 - you] = 1 - i;
  return map;
}
function testBoatForSrv(k) {
  const t = state.test;
  return t && t.map ? testBoats()[t.map[k]] || null : null;
}
// Server-computed test average of `key` for our boat i (null when none).
function testAvg(i, key) {
  const t = state.test; if (!t || !t.avg || !t.map) return null;
  const k = t.map.indexOf(i); if (k < 0) return null;
  const v = t.avg[k] && t.avg[k][key];
  return (v == null || Number.isNaN(v)) ? null : v;
}
// Server-computed range/bearing from our boat `from` to our boat `to`.
function serverRangeBearing(from, to, now) {
  const s = state.sep;
  if (!s || s.rangeM == null || now - s.ts > LIVE_MS) return null;
  const kf = s.map.indexOf(from), kt = s.map.indexOf(to);
  if (kf < 0 || kt < 0) return null;
  return { rangeM: s.rangeM, bearingDeg: s.brg[kf] };   // brg[0] is 0→1, brg[1] is 1→0
}

// The connection to send test commands on: the server running the current
// test, otherwise the first boat whose server can run tests.
function engineConn() {
  const open = (rt) => rt && rt.srv && rt.srv.engine && rt.ws && rt.ws.readyState === 1;
  const t = state.test;
  if (t && open(t.via)) return t.via;
  return testBoats().map((b) => b.rt).find(open) || null;
}
function sendTestCmd(op, extra) {
  if (state.role !== 'master') return false;   // only the master runs tests
  const rt = engineConn();
  if (!rt) { alert('No connected server can run tests. It has to see both boats: the cloud relay, the simulator, or a bridge with "peer" set.'); return false; }
  try { rt.ws.send(JSON.stringify({ ctl: 1, kind: 'testcmd', op, ...extra })); } catch (_) { return false; }
  return true;
}
// Our reference boat, as the server sees it from connection rt: 'self' or 'other'.
function refFor(rt) {
  const boats = testBoats();
  const self = boats.find((b) => b.rt === rt);
  return self && self.id === testRefId(boats) ? 'self' : 'other';
}
let snapReqTs = 0;
function requestSnapshot(rt) {
  if (Date.now() - snapReqTs < 1000 || !rt.ws || rt.ws.readyState !== 1) return;
  snapReqTs = Date.now();
  try { rt.ws.send(JSON.stringify({ ctl: 1, kind: 'testcmd', op: 'snapshot' })); } catch (_) {}
}

function startTest(type, durationSec, wpRngNm, wpBrg) {
  const boats = testBoats();
  if (boats.length < 2) { alert('The test compares two boats. Configure both in Settings.'); return; }
  const rt = engineConn();
  const self = boats.find((b) => b.rt === rt), other = boats.find((b) => b.rt !== rt);
  sendTestCmd('start', {
    type, durationSec, wpRngNm, wpBrg,
    ref: refFor(rt), names: self ? [self.name, other.name] : undefined,
  });
}
function applyTrim() { sendTestCmd('trim', { sec: Math.max(0, parseInt($('trim-sec').value, 10) || 0) }); }
function saveTest() { if (state.test) sendTestCmd('save', { ref: refFor(engineConn()) }); }
function discardTest() { sendTestCmd('discard'); }

/* ---------- server → app messages ---------- */
function handleControl(rt, m) {
  switch (m.kind) {
    case 'hello': rt.srv = { engine: !!m.engine }; gateControls(); break;
    case 'test': onTestState(rt, m); break;
    case 'sep': onSep(rt, m); break;
    case 'result': addResult(m.result); break;
    case 'history': for (const r of m.results || []) addResult(r); break;
  }
}
function onSep(rt, m) {
  const map = srvMap(rt, m.you); if (!map) return;
  state.sep = { rangeM: m.rangeM, brg: m.brg, map, ts: Date.now() };
}
// Test state broadcasts are numbered (seq). With two connections to the same
// server each one arrives twice, so older/equal ones are dropped; a gap (or a
// restarted server, new boot) asks for a full snapshot.
function onTestState(rt, m) {
  if (m.boot !== state.testBoot) {
    if (!m.snap) { requestSnapshot(rt); return; }
    state.testBoot = m.boot; state.testSeq = -1;
  }
  if (m.snap ? m.seq < state.testSeq : m.seq <= state.testSeq) return;
  if (!m.snap && m.seq !== state.testSeq + 1) { requestSnapshot(rt); return; }
  const T = m.test;
  if (!T) { state.testSeq = m.seq; if (state.test) closeTestView(); return; }
  const map = srvMap(rt, m.you); if (!map) return;
  const s = T.series;
  let t = state.test;
  if (!t || t.id !== T.id) {
    if (s.from !== 0) { requestSnapshot(rt); return; }
    t = openTestView(T);
  }
  if (s.from > t.rows.length) { requestSnapshot(rt); return; }
  state.testSeq = m.seq;
  t.rows.length = s.from;
  for (const r of s.rows) t.rows.push(r);
  for (const k of ['type', 'names', 'startTs', 'durationSec', 'running', 'status', 'label', 'trimSec',
    'elapsedSec', 'wp', 'waypoints', 'twdOverall', 'downwind', 'antisym', 'cur', 'avg']) t[k] = T[k];
  t.map = map; t.via = rt; t.lastMsg = Date.now();
  renderTest();
}

/* ---------- test view ---------- */
function openTestView(T) {
  state.test = { id: T.id, type: T.type, rows: [], map: null };
  $('test-title').textContent = `${T.type} test`;
  $('test-review').hidden = true;
  $('test-view').hidden = false;
  buildRefSwitch();
  buildTiles(T.type);
  if (!chartVMG) chartVMG = new LineChart($('chart-vmg'));
  if (!chartUP) chartUP = new LineChart($('chart-up'));
  return state.test;
}
function closeTestView() {
  state.test = null;
  $('test-view').hidden = true;
  $('test-review').hidden = true;
  $('ref-switch').innerHTML = '';
  $('test-meta').innerHTML = '';
  gateControls();
}

function buildRefSwitch() {
  const wrap = $('ref-switch'); wrap.innerHTML = '';
  const lab = document.createElement('span'); lab.className = 'ref-switch__label'; lab.textContent = 'Reference';
  wrap.appendChild(lab);
  const boats = testBoats(), ref = testRefId(boats);
  for (const b of boats) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'seg';
    btn.textContent = b.name;
    btn.style.borderColor = b.color;
    btn.dataset.id = b.id;
    btn.setAttribute('aria-pressed', String(b.id === ref));
    btn.addEventListener('click', () => setRef(b.id));   // same per-user setting as the dashboard
    wrap.appendChild(btn);
  }
}
function updateRefSwitchPressed() {
  if (!state.test) return;
  const ref = testRefId(testBoats());
  for (const s of $('ref-switch').querySelectorAll('.seg')) s.setAttribute('aria-pressed', String(s.dataset.id === ref));
}

const tileEls = {};
function buildTiles(type) {
  const wrap = $('test-tiles'); wrap.innerHTML = '';
  for (const k of Object.keys(tileEls)) delete tileEls[k];
  tileEls.dvmg = tile(wrap, 'delta', `${type} gain`, 'delta');
  tileEls.rate = tile(wrap, 'delta', `${type} gain / min`, 'delta');
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

function fmtLatLon(wp) {
  const ll = (v, pos, neg, deg) => {
    const h = v >= 0 ? pos : neg; const a = Math.abs(v);
    const d = Math.floor(a); const m = (a - d) * 60;
    return `${String(d).padStart(deg, '0')}°${m.toFixed(3)}′${h}`;
  };
  return `${ll(wp.lat, 'N', 'S', 2)} ${ll(wp.lon, 'E', 'W', 3)}`;
}

// Draw the server's test state. The server measures gains from its boat 0;
// when our reference is its boat 1 the antisymmetric gains change sign.
function renderTest() {
  const t = state.test; if (!t || !t.map) return;
  const boats = testBoats(); if (boats.length < 2) return;
  const refI = Math.max(0, boats.findIndex((b) => b.id === testRefId(boats)));
  const ref = boats[refI];
  const flip = t.map.indexOf(refI) !== 0;
  const sign = (metric) => (flip && t.antisym && t.antisym[metric] ? -1 : 1);
  const primaryLabel = t.type;

  $('test-title').textContent = `${t.type} test`;
  $('test-duration').textContent = mmss(t.durationSec);
  $('test-elapsed').textContent = mmss(t.elapsedSec);
  $('test-progress').style.width = `${Math.min(100, (t.elapsedSec / t.durationSec) * 100)}%`;
  $('test-status').textContent = t.label;

  // Only the master gets controls: Stop while running, then trim / save / discard.
  const isMaster = state.role === 'master';
  $('test-stop').hidden = !(isMaster && t.running);
  const review = isMaster && !t.running;
  if (review && $('test-review').hidden) $('trim-sec').value = String(t.trimSec || 0);
  $('test-review').hidden = !review;

  let meta = `Ref <b style="color:${ref.color}">${escHTML(ref.name)}</b>`;
  if (t.type === 'VMG') meta += ` · TWD used ${t.twdOverall == null ? '—' : String(Math.round(t.twdOverall)).padStart(3, '0') + '°'}` + (t.downwind ? ' · downwind' : ' · upwind');
  else if (t.wp) meta += ` · WP ${String(Math.round(t.wp.brg)).padStart(3, '0')}° / ${(t.wp.rngM / NM_TO_M).toFixed(1)} nm` + (t.type === 'TWA' ? ' (per boat)' : ' (from master)');
  $('test-meta').innerHTML = meta;

  const wpEl = $('test-waypoints');
  if (wpEl) {
    if (t.type === 'VMC' && t.waypoints && t.waypoints[0]) {
      wpEl.innerHTML = `<span class="wp-item"><span class="wp-tag">VMC waypoint</span> <span class="wp-ll">${fmtLatLon(t.waypoints[0])}</span></span>`;
    } else if (t.type === 'TWA' && t.waypoints) {
      wpEl.innerHTML = t.waypoints.map((w, k) => {
        const b = testBoatForSrv(k);
        return w && b ? `<span class="wp-item"><span class="wp-tag" style="color:${b.color}">Waypoint ${escHTML(b.name)}</span> <span class="wp-ll">${fmtLatLon(w)}</span></span>` : '';
      }).join('');
    } else wpEl.innerHTML = '';
  }

  const blank = (k) => setDelta(k, 0, '', '', 0, true);
  const cur = t.cur;
  if (!cur) ['dvmg', 'rate', 'dfwd', 'dup'].forEach(blank);
  else {
    if (cur.primary != null) {
      setDelta('dvmg', sign('primary') * cur.primary, 'm', t.downwind ? `${primaryLabel} gain (downwind)` : `${primaryLabel} gain`);
      setDelta('rate', cur.rate != null ? sign('primary') * cur.rate : 0, 'm/min', `${primaryLabel} gain ÷ min`, 1);
    } else { blank('dvmg'); blank('rate'); }
    if (t.type === 'VMG') { if (cur.fwd != null) setDelta('dfwd', sign('fwd') * cur.fwd, 'm', 'along average path'); else blank('dfwd'); }
    if (cur.up != null) setDelta('dup', sign('up') * cur.up, 'm', t.type === 'VMG' ? 'perp of avg path' : 'perp of WP bearing'); else blank('dup');
  }

  // series rows: [x, primary, up, fwd]
  const pts = (col, metric) => t.rows.filter((r) => r[col] != null).map((r) => ({ x: r[0], y: sign(metric) * r[col] }));
  if (chartVMG) chartVMG.setSeries([{ label: `${primaryLabel} gain`, color: '#0d9488', points: pts(1, 'primary') }], { xMax: t.durationSec, includeZero: true });
  if (chartUP) {
    const s = [{ label: 'UP/DOWN', color: '#0d9488', points: pts(2, 'up') }];
    if (t.type === 'VMG') s.push({ label: 'FWD/BACK', color: '#ea580c', points: pts(3, 'fwd') });
    chartUP.setSeries(s, { xMax: t.durationSec, includeZero: true });
  }

  renderTestAverages(boats);
}

// A row of boxes with each variable's average over the test (per boat).
function renderTestAverages(boats) {
  const el = $('test-averages'); if (!el) return;
  el.innerHTML = AVG_CH.map((ch) => {
    const cells = boats.map((b, i) => {
      const v = testAvg(i, ch.key);
      const txt = v == null ? '—' : (+v).toFixed(ch.dp);
      return `<span class="tavg__v" style="color:${b.color}">${txt}</span>`;
    }).join('<span class="tavg__sep">/</span>');
    return `<div class="tavg__box"><span class="tavg__label">${ch.label}</span><div class="tavg__vals">${cells}</div></div>`;
  }).join('');
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

// Flag a test view whose server has gone quiet (it keeps the last state shown).
setInterval(() => {
  const t = state.test;
  if (t && Date.now() - (t.lastMsg || 0) > 6000) $('test-status').textContent = 'No update from the server';
}, 1500);

// Columns of the test averages row and the history table (the server averages every channel).
const AVG_CH = [
  { key: 'bsp', label: 'BS', dp: 1 },
  { key: 'tws', label: 'TWS', dp: 1 },
  { key: 'twd', label: 'TWD', dp: 0 },
  { key: 'twa', label: 'TWA', dp: 0 },
  { key: 'hdg', label: 'HDG', dp: 0 },
  { key: 'cog', label: 'COG', dp: 0 },
  { key: 'sog', label: 'SOG', dp: 1 },
  { key: 'heel', label: 'HEEL', dp: 1 },
  { key: 'rudder', label: 'RUD', dp: 1 },
];

/* ---------- test history ---------- */
// Results are computed and kept by the server, which sends them as they are
// saved and again to every client that connects; each device keeps its copy.
const HISTORY_KEY = 'boat-receiver:history:v1';
const HISTCLEAR_KEY = 'boat-receiver:histclear:v1';   // results up to this start time were cleared here
let history = [];
let histClearedAt = 0;
function loadHistory() {
  try { const r = localStorage.getItem(HISTORY_KEY); if (r) history = JSON.parse(r); } catch (_) { history = []; }
  try { histClearedAt = +localStorage.getItem(HISTCLEAR_KEY) || 0; } catch (_) {}
}
function saveHistory() { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 200))); } catch (_) {} }
function clearHistory() {
  if (!history.length) return;
  if (!confirm('Clear all saved test results?')) return;
  histClearedAt = Math.max(Date.now(), ...history.map((r) => r.startTs || 0));
  try { localStorage.setItem(HISTCLEAR_KEY, String(histClearedAt)); } catch (_) {}
  history = []; saveHistory(); renderHistory();
}
function addResult(r) {
  if (!r || !r.startTs || r.startTs <= histClearedAt) return;
  if (history.some((h) => h.startTs === r.startTs && h.type === r.type)) return;   // dedupe
  if (!r.colors && Array.isArray(r.boats)) {
    // colour each boat as this device does (matched by name)
    r.colors = r.boats.map((n, i) => { const rt = [...state.rt.values()].find((x) => x.def.name === n); return rt ? rt.color : COLORS[i % COLORS.length]; });
  }
  history.push(r);
  history.sort((a, b) => b.startTs - a.startTs);
  saveHistory(); renderHistory();
}
function fmtDateTime(ts) { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function num(v, dp) { return (v == null || Number.isNaN(v)) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(+v.toFixed(dp)); }
function avgCellHTML(r, key, dp) {
  const c = r.colors || ['#8fb0c4', '#8fb0c4'];
  const f = (x) => (x == null || Number.isNaN(x)) ? '—' : (+x).toFixed(dp);
  const v0 = f(r.avg && r.avg[0] && r.avg[0][key]);
  const v1 = f(r.avg && r.avg[1] && r.avg[1][key]);
  return `<span style="color:${c[0]}">${v0}</span><span class="avgsep">/</span><span style="color:${c[1]}">${v1}</span>`;
}
function renderHistory() {
  const body = $('history-body'); if (!body) return;
  body.innerHTML = '';
  $('history').hidden = history.length === 0;
  // legend from the most recent row
  const leg = $('history-legend');
  if (leg) {
    const r0 = history[0];
    if (r0 && r0.boats) {
      const c = r0.colors || ['#8fb0c4', '#8fb0c4'];
      leg.innerHTML = r0.boats.map((n, i) => `<span class="legdot" style="background:${c[i]}"></span>${n}`).join('<span class="leggap"></span>');
    } else leg.innerHTML = '';
  }
  for (const r of history) {
    const tr = document.createElement('tr');
    const winnerColor = r.colors && r.boats ? (r.winner === r.boats[0] ? r.colors[0] : r.winner === r.boats[1] ? r.colors[1] : '') : '';
    const add = (html) => { const td = document.createElement('td'); td.innerHTML = html; tr.appendChild(td); };
    const esc = (s) => String(s).replace(/</g, '&lt;');
    add(esc(fmtDateTime(r.startTs)));
    add(esc(r.type));
    add(esc(mmss(r.durationSec)));
    add(winnerColor ? `<b style="color:${winnerColor}">${esc(r.winner)}</b>` : esc(r.winner));
    add(r.ref ? esc(r.ref) : '—');
    add(r.rate == null ? '—' : `${num(r.rate, 1)} m/min`);
    add(num(r.fwd, 0));
    add(num(r.up, 0));
    for (const ch of AVG_CH) add(avgCellHTML(r, ch.key, ch.dp));
    body.appendChild(tr);
  }
}
function exportCSV() {
  const head = ['Date', 'Type', 'Duration', 'Winner', 'Reference', 'Gain rate (m/min)', 'FWD/BACK (m)', 'UP/DOWN (m)'];
  for (const bi of [0, 1]) for (const ch of AVG_CH) head.push(`Boat${bi + 1} avg ${ch.label}`);
  head.push('Boat1 name', 'Boat2 name');
  const val = (x, dp) => (x == null || Number.isNaN(x)) ? '' : (+x).toFixed(dp);
  const rows = history.map((r) => {
    const row = [
      fmtDateTime(r.startTs), r.type, mmss(r.durationSec), r.winner, r.ref || '',
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

/* ---------- clock ---------- */
function tickClock() {
  const el = $('clock'); if (!el) return;
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
tickClock();
setInterval(tickClock, 1000);

/* ---------- wiring ---------- */
$('role-master').addEventListener('click', () => { setRole('master'); $('role-modal').hidden = true; });
$('role-viewer').addEventListener('click', () => { setRole('viewer'); $('role-modal').hidden = true; });

$('btn-vmg').addEventListener('click', () => { if (state.role === 'master') openSetup('VMG'); });
$('btn-vmc').addEventListener('click', () => { if (state.role === 'master') openSetup('VMC'); });
$('btn-twa').addEventListener('click', () => { if (state.role === 'master') openSetup('TWA'); });

$('test-stop').addEventListener('click', () => sendTestCmd('stop'));
$('trim-apply').addEventListener('click', applyTrim);
$('test-discard').addEventListener('click', discardTest);
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

/* ---------- cloud config via URL (?relay=…&room=…&token=…&role=viewer) -------
 * Lets you share one link that connects a viewer straight to the cloud relay.
 * With no ?relay, defaults to this page's own origin (so hosting the app on the
 * relay itself needs only ?role & ?token). */
function applyCloudParams() {
  const q = new URLSearchParams(location.search);
  const hasRelay = q.has('relay') || q.has('token') || q.has('room');
  if (hasRelay) {
    let base = q.get('relay');
    if (!base) base = location.origin.replace(/^http/, 'ws');   // same host as the app
    base = base.replace(/^http/, 'ws').replace(/\/+$/, '');
    const room = q.get('room') || 'default';
    const token = q.get('token') || '';
    const mk = (boat) => `${base}/ws?role=view&room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}&boat=${boat}`;
    const boats = loadBoats();
    if (boats[0]) boats[0] = { ...boats[0], url: mk('1') };
    if (boats[1]) boats[1] = { ...boats[1], url: mk('2') };
    saveBoats(boats);
  }
  const role = (q.get('role') || '').toLowerCase();
  if (role === 'viewer' || role === 'view') saveRole('viewer');
  else if (role === 'master') saveRole('master');
}

/* ---------- init ---------- */
applyCloudParams();
applyBoats(loadBoats());
loadHistory();
renderHistory();
const savedRole = loadRole();
if (savedRole) { setRole(savedRole); $('role-modal').hidden = true; }
else { $('role-modal').hidden = false; }
gateControls();
