/* Shared sailing math. Works in the browser (globalThis.SailMath) and in Node
 * (require). All angles in degrees, speeds in knots, distances in metres. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SailMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KN_TO_MS = 0.514444;      // 1 knot in m/s
  const D2R = Math.PI / 180;

  // Normalise an angle to (-180, 180]
  function norm180(d) {
    d = ((d + 180) % 360 + 360) % 360 - 180;
    return d === -180 ? 180 : d;
  }

  // Signed true wind angle from course and wind direction.
  // 0 = pointing straight upwind, +/-180 = dead downwind, sign = side.
  function twa(cog, twd) {
    return norm180(cog - twd);
  }

  // Velocity made good toward the wind (kn). Positive upwind, negative downwind.
  function vmg(sog, cog, twd) {
    return sog * Math.cos(twa(cog, twd) * D2R);
  }

  // Velocity made good on course toward a bearing (kn).
  function vmc(sog, cog, bearing) {
    return sog * Math.cos(norm180(cog - bearing) * D2R);
  }

  // Distance (m) covered at a given speed (kn) over dt seconds.
  function dist(speedKn, dtSec) {
    return speedKn * KN_TO_MS * dtSec;
  }

  return { KN_TO_MS, norm180, twa, vmg, vmc, dist };
});
