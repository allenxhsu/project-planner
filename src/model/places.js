// Home or work, from where this device is.
//
// Three signals, strongest first: the Wi-Fi network's name (the Mac app can
// read it), the internet address the sync server sees, and a point on the
// map. A place — home, or work — is remembered as the names, addresses and
// points it has been recognised by; a new network is asked about once and
// then added to whichever it turned out to be.

/** How close a point has to be to one of a place's to count as there, in metres. */
export const NEAR_METRES = 300;
/** A fix vaguer than this says little about which building someone is in. */
const USABLE_ACCURACY = 1000;

/** Great-circle distance in metres. */
export function metresBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

const usablePoint = (pos) => !!pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng) && (pos.accuracy ?? 0) <= USABLE_ACCURACY;

/**
 * Which place these signals say this is: `{ kind, by }` — by 'wifi', 'address'
 * or 'location' — or null when none of them is known.
 * @param {Array<{kind: 'home'|'work', ssids?: string[], ips?: string[], points?: Array<{lat: number, lng: number}>}>} places
 * @param {{ ssid?: string|null, ip?: string|null, pos?: {lat: number, lng: number, accuracy?: number}|null }} signals
 */
export function matchPlace(places, { ssid = null, ip = null, pos = null } = {}) {
  if (ssid) {
    const hit = places.find((p) => (p.ssids || []).includes(ssid));
    if (hit) return { kind: hit.kind, by: 'wifi' };
  }
  if (ip) {
    const hit = places.find((p) => (p.ips || []).includes(ip));
    if (hit) return { kind: hit.kind, by: 'address' };
  }
  if (usablePoint(pos)) {
    let best = null;
    for (const p of places) {
      for (const q of p.points || []) {
        const d = metresBetween(pos, q);
        if (d <= NEAR_METRES + Math.min(pos.accuracy ?? 0, 300) && (!best || d < best.d)) best = { kind: p.kind, d };
      }
    }
    if (best) return { kind: best.kind, by: 'location' };
  }
  return null;
}

/**
 * The places once these signals are taught as `kind`: added to that place
 * (made if it did not exist) and taken off the other one, so the same network
 * is never both.
 */
export function teachPlace(places, kind, { ssid = null, ip = null, pos = null } = {}) {
  const other = kind === 'home' ? 'work' : 'home';
  const find = (k) => places.find((p) => p.kind === k) || { kind: k, ssids: [], ips: [], points: [] };
  const here = find(kind);
  const there = find(other);
  const next = {
    kind,
    ssids: ssid ? [...new Set([...(here.ssids || []), ssid])] : [...(here.ssids || [])],
    ips: ip ? [...new Set([...(here.ips || []), ip])] : [...(here.ips || [])],
    points: [...(here.points || [])],
  };
  if (usablePoint(pos) && !next.points.some((q) => metresBetween(pos, q) < NEAR_METRES / 2)) {
    next.points.push({ lat: Math.round(pos.lat * 1e5) / 1e5, lng: Math.round(pos.lng * 1e5) / 1e5 });
  }
  const rest = {
    kind: other,
    ssids: (there.ssids || []).filter((x) => x !== ssid),
    ips: (there.ips || []).filter((x) => x !== ip),
    points: (there.points || []).filter((q) => !usablePoint(pos) || metresBetween(pos, q) > NEAR_METRES),
  };
  return [next, rest];
}

/** A short name for what these signals are, for asking about them: the Wi-Fi name, else the address. */
export function describeSignals({ ssid = null, ip = null, pos = null } = {}) {
  if (ssid) return `the Wi-Fi network “${ssid}”`;
  if (ip) return `this internet connection (${ip})`;
  if (usablePoint(pos)) return 'this location';
  return 'this network';
}

/** A key per network, so the same one is not asked about twice in a row. */
export const signalsKey = ({ ssid = null, ip = null, pos = null } = {}) =>
  ssid || ip || (usablePoint(pos) ? `${pos.lat.toFixed(3)},${pos.lng.toFixed(3)}` : '');
