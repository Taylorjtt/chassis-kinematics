/*
 * Sensor-name → FL/FR auto-mapping. Racers name their BLE shocks things like
 * "LF Shock", "LF", "Left Front"; we regex-match to identify which sensor
 * belongs to which corner. Mapping persists per-MAC in localStorage so a
 * user's sensors auto-map across sessions without asking.
 */
import type { SensorMeta, SensorMapping } from './bundle';

const STORE_KEY = 'clrTelemetryMap';

// Compiled patterns — high-confidence forms first so "left rear" doesn't
// accidentally match a plain "L".
const FL_PATTERNS = [
  /\b(?:lf|left[\s_-]*front|front[\s_-]*left|fl)\b/i,
];
const FR_PATTERNS = [
  /\b(?:rf|right[\s_-]*front|front[\s_-]*right|fr)\b/i,
];

function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(name));
}

/** Try to identify the FL and FR sensors from user-assigned names. Ambiguous
 *  sensors are left unmapped — the UI shows a dropdown for those. */
export function autoMapSensors(sensors: SensorMeta[]): SensorMapping {
  const shocks = sensors.filter((s) => s.sensorType.startsWith('shock'));
  const flCandidates = shocks.filter((s) => matchesAny(s.sensorName, FL_PATTERNS));
  const frCandidates = shocks.filter((s) => matchesAny(s.sensorName, FR_PATTERNS));
  const out: SensorMapping = {};
  if (flCandidates.length === 1) out.flMac = flCandidates[0].macAddress;
  if (frCandidates.length === 1) out.frMac = frCandidates[0].macAddress;
  return out;
}

interface StoredMapping {
  /** MAC → role. Persists across bundles so the racer maps once per weekend. */
  roles: Record<string, 'fl' | 'fr'>;
  /** MAC → invert flag */
  invert: Record<string, boolean>;
}

function readStore(): StoredMapping {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { roles: {}, invert: {} };
    const p = JSON.parse(raw);
    return {
      roles: (p.roles && typeof p.roles === 'object') ? p.roles : {},
      invert: (p.invert && typeof p.invert === 'object') ? p.invert : {},
    };
  } catch { return { roles: {}, invert: {} }; }
}

function writeStore(s: StoredMapping): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* full */ }
}

/** Layered mapping resolver: user's saved mapping wins over name auto-detection. */
export function resolveMapping(sensors: SensorMeta[]): SensorMapping {
  const auto = autoMapSensors(sensors);
  const store = readStore();
  const out: SensorMapping = { ...auto };
  // apply stored per-MAC roles, overriding auto-detection
  for (const s of sensors) {
    const role = store.roles[s.macAddress];
    if (role === 'fl') out.flMac = s.macAddress;
    if (role === 'fr') out.frMac = s.macAddress;
  }
  // invert flags
  if (out.flMac && store.invert[out.flMac]) out.flInvert = true;
  if (out.frMac && store.invert[out.frMac]) out.frInvert = true;
  return out;
}

/** Save a user's explicit role assignment for one sensor MAC. */
export function saveRole(mac: string, role: 'fl' | 'fr' | 'none'): void {
  const s = readStore();
  // clear any other MAC that had the same role (roles are unique)
  if (role !== 'none') {
    for (const m of Object.keys(s.roles)) {
      if (s.roles[m] === role && m !== mac) delete s.roles[m];
    }
    s.roles[mac] = role;
  } else {
    delete s.roles[mac];
  }
  writeStore(s);
}

/** Save an invert flag for a sensor. */
export function saveInvert(mac: string, invert: boolean): void {
  const s = readStore();
  if (invert) s.invert[mac] = true; else delete s.invert[mac];
  writeStore(s);
}

/** Human-readable role label for the mapping UI. */
export function currentRole(mac: string, mapping: SensorMapping): 'fl' | 'fr' | null {
  if (mapping.flMac === mac) return 'fl';
  if (mapping.frMac === mac) return 'fr';
  return null;
}
