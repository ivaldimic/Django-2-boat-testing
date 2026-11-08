'use strict';

/*
 * Server-side test engine, shared by the relay, the bridge and the simulator.
 * --------------------------------------------------------------------------
 * A TestHub watches the two boats' raw feeds and runs the two-boat tests
 * (VMG / VMC / TWA) for every connected app, so all viewers see exactly the
 * same numbers. It computes:
 *   - the test gains and their series (definitions in README.md),
 *   - the per-boat averages over the (trimmed) test window,
 *   - the live boat separation (range and bearing both ways),
 *   - the saved test summary, plus an in-memory history of saved results.
 * It also creates the VMC/TWA waypoints and hands them to the host to send to
 * each boat's Expedition.
 *
 * Boats are indexed 0 and 1. Each host decides which boat a client connection
 * "carries" (relay: boat=1 → 0, boat=2 → 1; simulator: port order; bridge:
 * its own boat is 0, its peer 1) and passes that as `connIdx`. Every message
 * to a client carries it as `you`, so the app can line the server's boats up
 * with its own.
 *
 * Messages are JSON control frames ({ctl: 1, kind: …}):
 *   app → server  kind 'testcmd': op 'start' | 'stop' | 'trim' | 'save' |
 *                 'discard' | 'snapshot'. 'self'/'other' in `ref` and the
 *                 order of `names` are relative to the connection used.
 *   server → app  'hello' {engine}, 'test' {boot, seq, snap, test|null},
 *                 'sep' {rangeM, brg:[0→1, 1→0]}, 'result' {result},
 *                 'history' {results}.
 * Live gains are relative to boat 0; `antisym` says which ones change sign
 * when the other boat is the reference (the app applies that flip). Series
 * rows are [x s, primary m, up m, fwd m], sent as deltas: `from` is where the
 * rows replace the client's copy. `seq` orders the broadcasts; a client that
 * misses one asks for a snapshot.
 */

const S = require('./sailmath');
const FP = require('./feedparse');

const LIVE_MS = 3000;        // a boat's data counts as fresh for this long
const TICK_MS = 1000;        // gain sampling + broadcast cadence
const AVG_MS = 500;          // averages sampling cadence
const NM_TO_M = 1852;
const HISTORY_MAX = 200;
const REVIEW_MAX_MS = 3600000;   // a stopped test nobody saves or discards is dropped after an hour
const TYPES = ['VMG', 'VMC', 'TWA'];

/* ---------- geometry (same maths the app used to run) ---------- */
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

// Per-type gains, following the spec. Every value is refIdx relative to the other boat.
//   VMG:  primary = separation on the TWD axis (sign flips downwind);
//         FWD/BACK & UP/DOWN from the average-path frame.
//   VMC:  primary = separation on the bearing to the single (master) waypoint;
//         UP/DOWN = change in |separation on the perpendicular of that bearing|.
//   TWA:  primary = (other's distance to its waypoint − ref's distance to its
//         waypoint); UP/DOWN = change in |separation on the perpendicular of the
//         target bearing|.  Every GAIN = value(now) − value(start).
function computeGains(t, refIdx) {
  const work = effectiveSamples(t);
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
  if (cur) {
    const mins = (cur.t - work[0].t) / 60000;
    cur.sec = (cur.t - work[0].t) / 1000;
    cur.rate = (cur.primary != null && mins > 0) ? cur.primary / mins : null;
  }
  return res;
}

// Whole-test average of every channel, per boat, over the (trimmed) test window.
function computeAverages(t) {
  const eff = effectiveSamples(t);
  const endT = eff.length ? eff[eff.length - 1].t : Date.now();
  return t.avgSamples.map((list) => {
    const acc = {};
    for (const h of list) {
      if (h.t < t.startTs || h.t > endT) continue;
      for (const key in h.v) {
        const v = h.v[key];
        const a = acc[key] || (acc[key] = { sum: 0, sin: 0, cos: 0, n: 0 });
        a.n++; a.sum += v; const r = v * Math.PI / 180; a.sin += Math.sin(r); a.cos += Math.cos(r);
      }
    }
    const o = {};
    for (const key in acc) {
      const a = acc[key];
      o[key] = round(FP.isAngular(key) ? (Math.atan2(a.sin, a.cos) * 180 / Math.PI + 360) % 360 : a.sum / a.n, 3);
    }
    return o;
  });
}

function round(v, dp) { if (v == null || !Number.isFinite(v)) return null; const f = 10 ** dp; return Math.round(v * f) / f; }
function clampNum(v, lo, hi, dflt) { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; }
function wrap360(d) { return ((d % 360) + 360) % 360; }
function fresh(l, now) { return l && l.ts && (now - l.ts) < LIVE_MS; }

// The series rows sent to clients, rounded to 0.1 (the charts don't need more).
function packRows(g) {
  const byX = new Map();
  const row = (x) => { let r = byX.get(x); if (!r) { r = [round(x, 1), null, null, null]; byX.set(x, r); } return r; };
  for (const p of g.series.primary) row(p.x)[1] = round(p.y, 1);
  for (const p of g.series.up) row(p.x)[2] = round(p.y, 1);
  for (const p of g.series.fwd) row(p.x)[3] = round(p.y, 1);
  return [...byX.values()].sort((a, b) => a[0] - b[0]);
}
function sameRow(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0; while (i < n && sameRow(a[i], b[i])) i++;
  return i;
}

/* ---------- framing helpers for the hosts ---------- */
function frame(obj, you) { return JSON.stringify({ ctl: 1, ...obj, you }); }
// Send obj to every open client; idxOf(client) gives its connIdx (null = skip).
function fanout(clients, obj, idxOf) {
  const cache = new Map();
  for (const c of clients) {
    if (c.readyState !== 1) continue;
    const you = idxOf(c); if (you == null) continue;
    let s = cache.get(you); if (!s) { s = frame(obj, you); cache.set(you, s); }
    try { c.send(s); } catch (_) {}
  }
}
// What a host that can't see both boats tells its clients.
function noEngineHello() { return { kind: 'hello', engine: false }; }

/* ---------- the hub ---------- */
class TestHub {
  // broadcast(obj): send to every app client (the host adds `you` per client).
  // sendWaypoint(idx, {name, lat, lon}): forward to that boat's Expedition.
  constructor({ broadcast, sendWaypoint, log } = {}) {
    this.broadcastFn = broadcast || (() => {});
    this.sendWaypoint = sendWaypoint || (() => {});
    this.log = log || (() => {});
    this.live = [{}, {}];
    this.test = null;
    this.history = [];
    this.seq = 0;
    this.boot = Math.random().toString(36).slice(2, 10);   // lets clients spot a restarted server
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.avgTimer = setInterval(() => this.sampleAverages(), AVG_MS);
  }
  dispose() { clearInterval(this.timer); clearInterval(this.avgTimer); }

  // Raw text from boat idx (one or more NMEA / Expedition lines).
  feed(idx, text, ts = Date.now()) {
    const live = this.live[idx]; if (!live) return;
    for (const line of FP.splitLines(text)) if (line) FP.parseLine(line, live);
    live.ts = ts;
  }

  // Everything a newly connected client needs to catch up.
  welcome(reply) {
    reply({ kind: 'hello', engine: true });
    reply(this.sepMsg(Date.now()));
    reply(this.testMsg(true));
    if (this.history.length) reply({ kind: 'history', results: this.history });
  }

  command(m, connIdx, reply) {
    const t = this.test;
    const pick = (ref) => (ref === 'other' ? 1 - connIdx : connIdx);
    switch (m.op) {
      case 'start': this.start(m, connIdx, pick(m.ref)); break;
      case 'stop': if (t && t.running) this.finish(t, 'stopped'); break;
      case 'trim':
        if (!t || t.running) return;
        t.trimSec = Math.round(clampNum(m.sec, 0, 86400, 0)); t.dirty = true;
        break;
      case 'save': if (t && !t.running) this.save(t, pick(m.ref)); break;
      case 'discard': if (t) this.close(); break;
      case 'snapshot': reply(this.testMsg(true)); return;
      default: return;
    }
    this.broadcastTest();
  }

  start(m, connIdx, refIdx) {
    const type = TYPES.includes(m.type) ? m.type : null;
    if (!type) return;
    const names = ['Boat 1', 'Boat 2'];
    if (Array.isArray(m.names)) {
      if (m.names[0]) names[connIdx] = String(m.names[0]).slice(0, 40);
      if (m.names[1]) names[1 - connIdx] = String(m.names[1]).slice(0, 40);
    }
    const now = Date.now();
    this.test = {
      id: `${now}-${this.boot}`, type, names, startTs: now,
      durationSec: Math.round(clampNum(m.durationSec, 60, 86400, 300)),
      running: true, status: 'running', stoppedAt: null, trimSec: 0,
      wpRef: refIdx,   // VMC waypoint is laid from this boat's start position
      wp: type === 'VMG' ? null : { rngM: clampNum(m.wpRngNm, 0.01, 1000, type === 'VMC' ? 20 : 2) * NM_TO_M, brg: wrap360(clampNum(m.wpBrg, -36000, 36000, 0)) },
      waypoints: null, samples: [], avgSamples: [[], []],
      dirty: true, cache: null, sentRows: [],
    };
    this.log(`test start ${type} ${this.test.durationSec}s`);
    this.sampleAverages();
    this.samplePair(this.test, now);
  }

  finish(t, status) {
    t.running = false; t.status = status; t.stoppedAt = Date.now(); t.dirty = true;
    this.log(`test ${status}`);
  }

  save(t, refIdx) {
    const r = this.result(t, refIdx);
    if (r) {
      this.history.unshift(r);
      if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
      this.broadcastFn({ kind: 'result', result: r });
      this.log(`test saved: ${r.type} winner ${r.winner}`);
    }
    this.close();
  }

  close() { this.test = null; }

  // The saved summary row, measured from refIdx.
  result(t, refIdx) {
    const g = computeGains(t, refIdx);
    if (!g.cur) return null;
    const cur = g.cur, oth = 1 - refIdx;
    const winner = (cur.primary == null || Math.abs(cur.primary) < 0.05) ? '—' : (cur.primary > 0 ? t.names[refIdx] : t.names[oth]);
    return {
      type: t.type, startTs: t.startTs, durationSec: Math.round(cur.sec),
      winner, primaryLabel: t.type, ref: t.names[refIdx],
      rate: round(cur.rate, 2), fwd: round(cur.fwd, 1), up: round(cur.up, 1),
      boats: t.names.slice(), avg: this.computed(t).avg,
    };
  }

  /* ---- sampling ---- */
  samplePair(t, now) {
    const p = this.live.map((l) => (fresh(l, now) && l.lat != null && l.lon != null) ? { lat: l.lat, lon: l.lon, twd: l.twd } : null);
    if (!p[0] || !p[1]) return;
    t.samples.push({ t: now, p });
    t.dirty = true;
    // Lay the waypoint(s) at the first paired sample.
    if (!t.waypoints && t.wp) {
      const s0 = t.samples[0];
      if (t.type === 'VMC') {
        // one waypoint from the reference boat's start position, sent to both boats
        const rp = s0.p[t.wpRef];
        t.waypoints = [destPoint(rp.lat, rp.lon, t.wp.brg, t.wp.rngM)];
        for (const i of [0, 1]) this.sendWaypoint(i, { name: 'VMC', ...t.waypoints[0] });
      } else {
        // TWA: one waypoint per boat, from each boat's own start position
        t.waypoints = s0.p.map((pp) => destPoint(pp.lat, pp.lon, t.wp.brg, t.wp.rngM));
        t.waypoints.forEach((w, i) => this.sendWaypoint(i, { name: `TWA_${t.names[i]}`.replace(/\s+/g, '_'), ...w }));
      }
    }
  }

  sampleAverages() {
    const t = this.test; if (!t || !t.running) return;
    const now = Date.now();
    this.live.forEach((l, i) => {
      if (!fresh(l, now)) return;
      const v = {};
      for (const k in l) {
        if (k === 'ts' || k === 'lat' || k === 'lon' || k === 'twa') continue;
        if (typeof l[k] === 'number' && Number.isFinite(l[k])) v[k] = l[k];
      }
      const twa = FP.twaVal(l);
      if (twa != null && Number.isFinite(twa)) v.twa = twa;
      t.avgSamples[i].push({ t: now, v });
    });
    t.dirty = true;
  }

  tick() {
    const now = Date.now();
    this.broadcastFn(this.sepMsg(now));
    const t = this.test; if (!t) return;
    if (t.running) {
      this.samplePair(t, now);
      if ((now - t.startTs) / 1000 >= t.durationSec) this.finish(t, 'complete');
    } else if (now - t.stoppedAt > REVIEW_MAX_MS) {
      this.log('stopped test expired without being saved');
      this.close();
    }
    this.broadcastTest();
  }

  /* ---- messages ---- */
  sepMsg(now) {
    const [a, b] = this.live;
    if (!(fresh(a, now) && fresh(b, now) && a.lat != null && b.lat != null)) return { kind: 'sep', rangeM: null };
    const ab = S.rangeBearing(a.lat, a.lon, b.lat, b.lon);
    const ba = S.rangeBearing(b.lat, b.lon, a.lat, a.lon);
    return { kind: 'sep', rangeM: round(ab.rangeM, 1), brg: [round(ab.bearingDeg, 1), round(ba.bearingDeg, 1)] };
  }

  computed(t) {
    if (t.dirty || !t.cache) {
      const g = computeGains(t, 0);
      t.cache = { g, rows: packRows(g), avg: computeAverages(t) };
      t.dirty = false;
    }
    return t.cache;
  }

  broadcastTest() {
    this.seq++;
    const t = this.test;
    let from = 0;
    if (t) {
      const rows = this.computed(t).rows;
      from = firstDiff(t.sentRows, rows);
      if (from < t.sentRows.length) from = 0;   // anything but an append: resend it all
      t.sentRows = rows;
    }
    this.broadcastFn(this.testMsg(false, from));
  }

  // snap = full state for one client (welcome / on request); otherwise the
  // broadcast delta whose series starts at `from`.
  testMsg(snap, from = 0) {
    const t = this.test;
    const base = { kind: 'test', boot: this.boot, seq: this.seq, snap };
    if (!t) return { ...base, test: null };
    const { g } = this.computed(t);
    const rows = snap ? t.sentRows : t.sentRows.slice(from);
    const end = t.running ? Date.now() : t.stoppedAt;
    const cur = g.cur;
    return {
      ...base,
      test: {
        id: t.id, type: t.type, names: t.names, startTs: t.startTs, durationSec: t.durationSec,
        running: t.running, status: t.status, trimSec: t.trimSec,
        label: t.trimSec > 0 && !t.running ? `Trimmed −${t.trimSec}s` : ({ running: 'Running', complete: 'Complete', stopped: 'Stopped' })[t.status],
        elapsedSec: Math.round(Math.min((end - t.startTs) / 1000, t.durationSec)),
        wp: t.wp, waypoints: t.waypoints,
        twdOverall: round(g.twdOverall, 1), downwind: g.downwind,
        antisym: { primary: true, fwd: true, up: t.type === 'VMG' },
        cur: cur ? { primary: round(cur.primary, 2), up: round(cur.up, 2), fwd: round(cur.fwd, 2), rate: round(cur.rate, 2), sec: round(cur.sec, 1) } : null,
        avg: this.computed(t).avg,
        series: { from: snap ? 0 : from, rows },
      },
    };
  }
}

module.exports = { TestHub, frame, fanout, noEngineHello, computeGains, computeAverages, effectiveSamples, LIVE_MS };
