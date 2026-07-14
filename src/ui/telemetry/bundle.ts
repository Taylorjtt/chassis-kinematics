/*
 * Session-bundle loader for the racing-telemetry-app export format.
 *
 * Bundle layout (produced by SessionBundleExporter on Android):
 *   session_<id>.zip
 *     metadata.json  — session, track, sensors, laps
 *     data.db        — SQLite; session_data(timestamp, lap_number, data_json, lat, lon, speed)
 *
 * data_json per row: [{s: <sensorMetadataId>, d: [<values>]}, ...]
 *   s=<gpsId>   → d = [lat, lon, speedMs, gforceX, gforceY, gforceZ, iTOW, ...]
 *   s=<shockId> → d = [rawValue]    (calibrated = raw * scale + offset, units per meta)
 *
 * sql.js is dynamically imported so its ~1MB WASM only loads when the user
 * actually opens Replay mode.
 */

import JSZip from 'jszip';

export interface SensorMeta {
  id: number;
  sensorType: string;      // 'gps' | 'shock_0' | ...
  macAddress: string;
  deviceName: string;
  sensorName: string;      // user-assigned: 'LF', 'RF', 'LR', 'RR', 'GPS', ...
  units: string;           // 'in', 'mm', 'V', 'm/s', ...
  calibrationOffset: number;
  calibrationScale: number;
  dataFormat: string[];    // ["rawValue"] or ["latitude","longitude",...]
}

export interface LapMeta {
  id: number;
  lapNumber: number;
  lapTimeMs: number;
  isValid: boolean;
}

export interface SessionMeta {
  sessionId: string;
  startTime: number;       // Unix epoch ms
  endTime: number;
  durationMs: number;
  trackName: string | null;
  totalLaps: number;
  bestLapTimeMs: number;
}

/** Per-sensor role in the sim. `invert` flips sign at ingest. */
export interface SensorMapping {
  flMac?: string; flInvert?: boolean;
  frMac?: string; frInvert?: boolean;
}

/** Samples for one lap, packed into parallel Float32Arrays for fast playback. */
export interface LapFrames {
  /** seconds from lap start */
  tSec: Float32Array;
  /** front-left shock travel, inches, compression positive. NaN when unmapped. */
  shockL: Float32Array;
  /** front-right shock travel */
  shockR: Float32Array;
  /** GPS samples — sparser than shocks; NaN entries mean "no GPS at this row" */
  lat: Float32Array;
  lon: Float32Array;
  /** speed in mph (converted from raw m/s) */
  speedMph: Float32Array;
  /** total lap duration in seconds — for the timeline scrubber */
  durationSec: number;
}

/** Per-sensor ride-height reference (in the sensor's natural units, after
 *  calibration but before unit conversion). Subtracted from raw calibrated
 *  values so 0 ≈ installed ride. */
export interface RideReference {
  /** sensor MAC → mean calibrated value at rest (speed ≈ 0) */
  refByMac: Record<string, number>;
  /** number of samples used to compute each reference */
  countByMac: Record<string, number>;
  /** how the reference was chosen — 'stopped' means from speed≈0 samples,
   *  'median' fallback when no stopped samples were available */
  source: 'stopped' | 'median' | 'user';
}

/** Session-wide speed timeline (subsampled) for the "pick your ride point"
 *  chart in the mapping UI. */
export interface SessionSpeed {
  tSec: Float32Array;    // seconds from session start
  mph: Float32Array;
}

export interface Bundle {
  session: SessionMeta;
  sensors: SensorMeta[];
  laps: LapMeta[];
  /** Session-wide ride reference — the sensor readings when the car sat
   *  still. Everything downstream subtracts this so 0 ≈ ride. */
  rideRef: RideReference;
  /** Session-wide speed trace, subsampled for chart display. */
  sessionSpeed: SessionSpeed;
  fetchLap(lapNumber: number, mapping: SensorMapping): LapFrames;
  /** Recompute the ride reference from a specific time window in the session
   *  (e.g., a user-picked "car at rest here" moment). */
  setRideRefFromWindow(centerSec: number, halfWindowSec: number): void;
  /** Free the in-memory SQLite DB. Call when done with the bundle. */
  close(): void;
}

/** Cached sql.js Database class after first init. */
let SqlJsPromise: Promise<any> | null = null;

async function initSqlJs(): Promise<any> {
  if (SqlJsPromise) return SqlJsPromise;
  SqlJsPromise = (async () => {
    const [{ default: initSqlJs }, wasmUrl] = await Promise.all([
      import('sql.js'),
      // Vite bundles the .wasm as a static asset and gives us a URL for it
      import('sql.js/dist/sql-wasm.wasm?url').then((m) => m.default),
    ]);
    return initSqlJs({ locateFile: () => wasmUrl });
  })();
  return SqlJsPromise;
}

interface MetadataFile {
  sessionId: string;
  session: {
    sessionId: string; startTime: number; endTime: number; durationMs: number;
    totalLaps: number; bestLapTimeMs: number;
  };
  track: { name: string | null } | null;
  sensors: Array<Omit<SensorMeta, 'dataFormat'> & { dataFormat: string }>;
  laps: Array<{ id: number; lapNumber: number; lapTimeMs: number; isValid: number }>;
}

/** Load a .zip session bundle. */
export async function loadBundle(file: File | Blob): Promise<Bundle> {
  const zip = await JSZip.loadAsync(file);
  const metaFile = zip.file('metadata.json');
  const dbFile = zip.file('data.db');
  if (!metaFile || !dbFile) {
    throw new Error('bundle must contain metadata.json and data.db');
  }
  const [metaText, dbBytes] = await Promise.all([
    metaFile.async('string'),
    dbFile.async('uint8array'),
  ]);
  const meta = JSON.parse(metaText) as MetadataFile;

  const SQL = await initSqlJs();
  const db = new SQL.Database(dbBytes);

  const sensors: SensorMeta[] = meta.sensors.map((s) => ({
    ...s,
    dataFormat: safeJsonArray(s.dataFormat),
  }));
  const laps: LapMeta[] = meta.laps.map((l) => ({
    id: l.id, lapNumber: l.lapNumber, lapTimeMs: l.lapTimeMs, isValid: l.isValid === 1,
  }));
  const session: SessionMeta = {
    sessionId: meta.session.sessionId,
    startTime: meta.session.startTime,
    endTime: meta.session.endTime,
    durationMs: meta.session.durationMs,
    trackName: meta.track?.name ?? null,
    totalLaps: meta.session.totalLaps,
    bestLapTimeMs: meta.session.bestLapTimeMs,
  };

  const rideRef = computeRideReference(db, sensors);
  const sessionSpeed = computeSessionSpeed(db, session.durationMs);
  const bundle: Bundle = {
    session, sensors, laps, rideRef, sessionSpeed,
    fetchLap: (n, m) => queryLap(db, sensors, n, m, bundle.rideRef),
    setRideRefFromWindow: (centerSec, halfWindowSec) => {
      bundle.rideRef = refFromWindow(db, sensors, centerSec, halfWindowSec);
    },
    close: () => db.close(),
  };
  return bundle;
}

/** Downsample the session's speed trace for chart display. session_data has
 *  ~1 row every ~2ms — we bin into ~800 slots so the chart renders instantly. */
function computeSessionSpeed(db: any, durationMs: number): SessionSpeed {
  const N = 800;
  const binWidth = Math.max(1, durationMs / N);
  const sums = new Float64Array(N);
  const counts = new Int32Array(N);
  const stmt = db.prepare('SELECT timestamp, speed FROM session_data WHERE speed >= 0');
  while (stmt.step()) {
    const [ts, spd] = stmt.get() as [number, number];
    const t = Number(ts);
    if (t < 0 || t > durationMs) continue;
    const bin = Math.min(N - 1, Math.floor(t / binWidth));
    sums[bin] += spd;
    counts[bin] += 1;
  }
  stmt.free();
  const tSec = new Float32Array(N);
  const mph = new Float32Array(N);
  const MPS_TO_MPH = 2.23694;
  for (let i = 0; i < N; i++) {
    tSec[i] = (i * binWidth) / 1000;
    mph[i] = counts[i] > 0 ? (sums[i] / counts[i]) * MPS_TO_MPH : NaN;
  }
  return { tSec, mph };
}

/** Ride reference from a specific time window (user click on the session
 *  speed chart). Timestamps are in session-relative seconds. */
function refFromWindow(
  db: any, sensors: SensorMeta[], centerSec: number, halfWindowSec: number,
): RideReference {
  const shocks = sensors.filter((s) => s.sensorType.startsWith('shock'));
  const shockIds = new Set<number>(shocks.map((s) => s.id));
  const idToMeta = new Map<number, SensorMeta>();
  const macById = new Map<number, string>();
  for (const s of shocks) { idToMeta.set(s.id, s); macById.set(s.id, s.macAddress); }

  const t0Ms = Math.max(0, (centerSec - halfWindowSec) * 1000);
  const t1Ms = (centerSec + halfWindowSec) * 1000;
  const sums = new Map<number, number>();
  const counts = new Map<number, number>();
  const stmt = db.prepare(
    'SELECT data_json FROM session_data WHERE timestamp BETWEEN $a AND $b',
  );
  stmt.bind({ $a: t0Ms, $b: t1Ms });
  while (stmt.step()) {
    const [dj] = stmt.get() as [string];
    if (!dj) continue;
    try {
      const arr = JSON.parse(dj) as Array<{ s: number; d: number[] }>;
      for (const it of arr) {
        if (!shockIds.has(it.s)) continue;
        const meta = idToMeta.get(it.s)!;
        const cal = it.d[0] * (meta.calibrationScale ?? 1) + (meta.calibrationOffset ?? 0);
        if (!isFinite(cal)) continue;
        sums.set(it.s, (sums.get(it.s) ?? 0) + cal);
        counts.set(it.s, (counts.get(it.s) ?? 0) + 1);
      }
    } catch { /* skip */ }
  }
  stmt.free();

  const refByMac: Record<string, number> = {};
  const countByMac: Record<string, number> = {};
  for (const [id, sum] of sums) {
    const cnt = counts.get(id) ?? 0;
    if (cnt > 0) {
      const mac = macById.get(id);
      if (mac) { refByMac[mac] = sum / cnt; countByMac[mac] = cnt; }
    }
  }
  return { refByMac, countByMac, source: 'user' };
}

/** Compute per-sensor ride reference by averaging shock readings from the
 *  slowest samples in the session. Preference order:
 *  1. Samples with speed < 1 mph (car at rest — pit, pre-race, cool-down).
 *  2. If none exist, samples with speed < 5 mph (slow pit-lane roll).
 *  3. Otherwise, the median across the whole session (v1 fallback).
 *
 *  Values are stored in the sensor's calibrated space (post scale+offset,
 *  pre unit-conversion, pre invert). fetchLap subtracts before converting
 *  to inches, so the sim gets travel-from-ride cleanly. */
function computeRideReference(db: any, sensors: SensorMeta[]): RideReference {
  const shocks = sensors.filter((s) => s.sensorType.startsWith('shock'));
  const shockIds = new Set<number>(shocks.map((s) => s.id));
  const idToMeta = new Map<number, SensorMeta>();
  const macById = new Map<number, string>();
  for (const s of shocks) { idToMeta.set(s.id, s); macById.set(s.id, s.macAddress); }

  const collect = (whereSpeed: string, limit: number): { sums: Map<number, number>; counts: Map<number, number> } => {
    const sums = new Map<number, number>();
    const counts = new Map<number, number>();
    const stmt = db.prepare(
      `SELECT data_json FROM session_data WHERE ${whereSpeed} LIMIT ${limit}`,
    );
    while (stmt.step()) {
      const [dj] = stmt.get() as [string];
      if (!dj) continue;
      try {
        const arr = JSON.parse(dj) as Array<{ s: number; d: number[] }>;
        for (const it of arr) {
          if (!shockIds.has(it.s)) continue;
          const meta = idToMeta.get(it.s)!;
          const cal = it.d[0] * (meta.calibrationScale ?? 1) + (meta.calibrationOffset ?? 0);
          if (!isFinite(cal)) continue;
          sums.set(it.s, (sums.get(it.s) ?? 0) + cal);
          counts.set(it.s, (counts.get(it.s) ?? 0) + 1);
        }
      } catch { /* skip */ }
    }
    stmt.free();
    return { sums, counts };
  };

  // GPS speed is in m/s. 1 mph ≈ 0.447 m/s, 5 mph ≈ 2.24 m/s.
  let { sums, counts } = collect('speed >= 0 AND speed < 0.5', 5000);
  let source: RideReference['source'] = 'stopped';
  if (counts.size === 0) {
    ({ sums, counts } = collect('speed >= 0 AND speed < 2.24', 5000));
  }
  if (counts.size === 0) {
    // desperate fallback: whole-session median (rough approximation)
    source = 'median';
    ({ sums, counts } = collect('1=1', 20000));
  }

  const refByMac: Record<string, number> = {};
  const countByMac: Record<string, number> = {};
  for (const [id, sum] of sums) {
    const cnt = counts.get(id) ?? 0;
    if (cnt > 0) {
      const mac = macById.get(id);
      if (mac) { refByMac[mac] = sum / cnt; countByMac[mac] = cnt; }
    }
  }
  return { refByMac, countByMac, source };
}

function safeJsonArray(s: string): string[] {
  try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** Convert a calibrated per-sensor reading from its stored units into inches. */
function toInches(value: number, units: string): number {
  const u = units.toLowerCase();
  if (u === 'in' || u === 'inch' || u === 'inches') return value;
  if (u === 'mm') return value / 25.4;
  if (u === 'cm') return value / 2.54;
  if (u === 'm') return value * 39.3701;
  // 'V' or '%' or anything else: pass through and let the mapping UI warn
  return value;
}

/** Run one lap-worth of rows through the parser + calibration + typed-array pack. */
function queryLap(
  db: any, sensors: SensorMeta[], lapNumber: number, mapping: SensorMapping,
  rideRef: RideReference,
): LapFrames {
  const flMeta = mapping.flMac ? sensors.find((s) => s.macAddress === mapping.flMac) : undefined;
  const frMeta = mapping.frMac ? sensors.find((s) => s.macAddress === mapping.frMac) : undefined;
  const flId = flMeta?.id ?? -1, frId = frMeta?.id ?? -1;
  const flInv = mapping.flInvert ? -1 : 1;
  const frInv = mapping.frInvert ? -1 : 1;
  // Session-wide ride reference — subtract before inverting so the reference
  // is always "sensor's natural value at rest".
  const flRef = flMeta ? (rideRef.refByMac[flMeta.macAddress] ?? 0) : 0;
  const frRef = frMeta ? (rideRef.refByMac[frMeta.macAddress] ?? 0) : 0;
  const gpsMeta = sensors.find((s) => s.sensorType === 'gps');
  const gpsId = gpsMeta?.id ?? -1;

  const stmt = db.prepare(
    'SELECT timestamp, latitude, longitude, speed, data_json '
    + 'FROM session_data WHERE lap_number = $lap ORDER BY timestamp',
  );
  stmt.bind({ $lap: lapNumber });

  // First pass: gather row objects (small footprint since one lap is ~10k rows)
  interface Row { t: number; shL: number; shR: number; lat: number; lon: number; spd: number }
  const rows: Row[] = [];
  let t0 = -1;
  while (stmt.step()) {
    const [tsRaw, lat, lon, spd, dataJson] = stmt.get() as [number, number, number, number, string];
    const ts = Number(tsRaw);
    if (t0 < 0) t0 = ts;
    const row: Row = { t: ts - t0, shL: NaN, shR: NaN, lat: NaN, lon: NaN, spd: NaN };
    // GPS values are on lat/lon columns for rows that carry a GPS sample.
    // Non-GPS rows have (0, 0, 0) — filter those.
    if (lat !== 0 || lon !== 0) { row.lat = lat; row.lon = lon; row.spd = spd; }
    // Parse data_json to extract shock values for the mapped sensor IDs
    if (dataJson && dataJson.length > 2) {
      try {
        const arr = JSON.parse(dataJson) as Array<{ s: number; d: number[] }>;
        for (const item of arr) {
          if (item.s === flId) {
            const raw = item.d[0];
            const cal = raw * (flMeta!.calibrationScale ?? 1) + (flMeta!.calibrationOffset ?? 0);
            // subtract ride reference in calibrated space, then to inches, then invert
            row.shL = toInches(cal - flRef, flMeta!.units) * flInv;
          } else if (item.s === frId) {
            const raw = item.d[0];
            const cal = raw * (frMeta!.calibrationScale ?? 1) + (frMeta!.calibrationOffset ?? 0);
            row.shR = toInches(cal - frRef, frMeta!.units) * frInv;
          } else if (item.s === gpsId && isNaN(row.lat)) {
            // fallback if lat/lon column happened to be zero: pull from data_json
            const d = item.d;
            row.lat = d[0]; row.lon = d[1]; row.spd = d[2];   // speed in m/s
          }
        }
      } catch { /* skip malformed row */ }
    }
    rows.push(row);
  }
  stmt.free();

  // Forward-fill shock values so playback interpolation sees a dense signal
  // (individual rows only carry the sensors that just updated). Rows are
  // sorted by timestamp so the last-seen value is always the most recent.
  let lastL = NaN, lastR = NaN;
  for (const r of rows) {
    if (isFinite(r.shL)) lastL = r.shL; else r.shL = lastL;
    if (isFinite(r.shR)) lastR = r.shR; else r.shR = lastR;
  }

  const n = rows.length;
  const tSec = new Float32Array(n);
  const shockL = new Float32Array(n);
  const shockR = new Float32Array(n);
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const speedMph = new Float32Array(n);
  const MS_TO_S = 1 / 1000, MPS_TO_MPH = 2.23694;
  for (let i = 0; i < n; i++) {
    tSec[i] = rows[i].t * MS_TO_S;
    shockL[i] = rows[i].shL;
    shockR[i] = rows[i].shR;
    lat[i] = rows[i].lat;
    lon[i] = rows[i].lon;
    speedMph[i] = rows[i].spd * MPS_TO_MPH;
  }
  // Ride reference is already baked into `row.shL`/`row.shR` above (subtracted
  // in calibrated space by queryLap using bundle.rideRef). No per-lap centering
  // needed — every lap's shock trace is in the same "travel from installed
  // ride height" frame.
  return {
    tSec, shockL, shockR, lat, lon, speedMph,
    durationSec: n > 0 ? tSec[n - 1] : 0,
  };
}

/** Format lap time (ms) as "MM:SS.mmm" for the UI. */
export function formatLapTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const min = Math.floor(total / 60000);
  const sec = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${min}:${String(sec).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
