/* Boat feed parsing, shared by the app and the servers so both read the data
 * the same way. Works in the browser (globalThis.FeedParse, after sailmath.js)
 * and in Node (require). Turns raw NMEA 0183 or Expedition lines into a flat
 * `live` object: lat, lon, cog, sog, hdg, bsp, twa, awa, twd, tws, aws, heel,
 * pitch, rudder, plus x<ch> for every other Expedition channel. */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const api = factory(isNode ? require('./sailmath') : root.SailMath);
  if (isNode) module.exports = api;
  root.FeedParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S) {
  /* ---------- NMEA 0183 ---------- */
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

  /* ---------- Expedition ---------- */
  // "#<boat>,<ch>,<value>,<ch>,<value>,…*<checksum>". The bridge checks the
  // checksum and keeps only this connection's boat. Channels with a usual key
  // land on it (so tests work as with NMEA); every other channel is kept as
  // live.x<ch>.
  const EXP_CORE = { 1: 'bsp', 2: 'awa', 3: 'aws', 4: 'twa', 5: 'tws', 6: 'twd', 13: 'hdg', 18: 'heel', 19: 'pitch', 20: 'rudder', 48: 'lat', 49: 'lon', 50: 'cog', 51: 'sog' };
  // Expedition channels that are compass directions (averaged on the circle).
  const EXP_ANGULAR = new Set([9, 11, 94, 102, 106, 109, 112, 272, 304, 312, 369, 411, 412]);
  function parseExpedition(raw, live) {
    const star = raw.indexOf('*');
    const f = (star >= 0 ? raw.slice(1, star) : raw.slice(1)).split(',');
    for (let i = 1; i + 1 < f.length; i += 2) {
      const id = parseInt(f[i], 10), v = parseFloat(f[i + 1]);
      if (!Number.isFinite(id) || !Number.isFinite(v)) continue;
      live[EXP_CORE[id] || `x${id}`] = EXP_CORE[id] === 'twa' || EXP_CORE[id] === 'awa' ? S.norm180(v) : v;
    }
  }

  /* ---------- helpers ---------- */
  function parseLine(raw, live) {
    if (raw[0] === '#') parseExpedition(raw, live); else parseNMEA(raw, live);
  }
  // Split one received frame into its trimmed, non-empty lines.
  function splitLines(text) {
    const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines : [String(text).trim()];
  }
  // TWA from course and wind when both are known, otherwise the instrument TWA.
  function twaVal(l) { return (l.cog != null && l.twd != null) ? S.twa(l.cog, l.twd) : l.twa; }
  // Keys whose values are compass directions (averaged on the circle).
  const ANGULAR_KEYS = new Set(['cog', 'hdg', 'twd']);
  function isAngular(key) {
    if (ANGULAR_KEYS.has(key)) return true;
    return /^x\d+$/.test(key) && EXP_ANGULAR.has(+key.slice(1));
  }

  return { parseNMEA, parseExpedition, parseLine, splitLines, twaVal, isAngular, EXP_CORE, EXP_ANGULAR };
});
