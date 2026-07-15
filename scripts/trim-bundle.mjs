#!/usr/bin/env node
/*
 * Trim a full session bundle down to a "hero" demo bundle for fast web load.
 *
 * Keeps:
 *   - Pre-race window (from t=0 to first row where speed > threshold),
 *     so the ride-reference auto-detection and click-to-pick chart work.
 *   - Best lap ± 1 lap on either side (3 racing laps).
 *
 * Preserves the SQLite schema of session_data / lap_times / sensor_metadata /
 * sessions / tracks so the sim's Bundle loader treats the trimmed output
 * identically to the original.
 *
 * Usage:  node scripts/trim-bundle.mjs <source.zip> [outPath]
 * Default output: public/demo-lap.zip
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Pre-race is samples where speed <= this (m/s). 2.24 m/s ~= 5 mph.
const PRE_RACE_SPEED_MS = 2.24;
// How many laps around the best lap (best ± N).
const LAP_RADIUS = 1;

async function main() {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: node scripts/trim-bundle.mjs <source.zip> [out.zip]');
    process.exit(1);
  }
  const outPath = process.argv[3]
    || resolve(PROJECT_ROOT, 'public/demo-lap.zip');

  console.log(`reading ${src}...`);
  const inputZip = await JSZip.loadAsync(readFileSync(src));
  const metaFile = inputZip.file('metadata.json');
  const dbFile = inputZip.file('data.db');
  if (!metaFile || !dbFile) throw new Error('bundle missing metadata.json or data.db');

  const meta = JSON.parse(await metaFile.async('string'));
  const dbBytes = await dbFile.async('uint8array');
  console.log(`  session ${meta.sessionId} · ${meta.session.totalLaps} laps · ${(dbBytes.length / 1e6).toFixed(1)} MB db`);

  const SQL = await initSqlJs();
  const srcDb = new SQL.Database(dbBytes);

  // Pick laps: best lap ± LAP_RADIUS
  const laps = meta.laps.filter(l => l.isValid === 1);
  const bestLap = laps.reduce((a, b) => (a.lapTimeMs > 0 && a.lapTimeMs <= b.lapTimeMs ? a : b));
  console.log(`  best lap: L${bestLap.lapNumber} @ ${bestLap.lapTimeMs}ms`);
  const keepLapNums = new Set();
  for (let n = bestLap.lapNumber - LAP_RADIUS; n <= bestLap.lapNumber + LAP_RADIUS; n++) {
    if (laps.some(l => l.lapNumber === n)) keepLapNums.add(n);
  }
  console.log(`  keeping laps: ${[...keepLapNums].sort((a, b) => a - b).join(', ')}`);

  // Find the pre-race cutoff (first timestamp with speed > threshold)
  const preRaceEndStmt = srcDb.prepare(
    'SELECT MIN(timestamp) AS t FROM session_data WHERE speed > ?',
  );
  preRaceEndStmt.bind([PRE_RACE_SPEED_MS]);
  preRaceEndStmt.step();
  const preRaceEnd = preRaceEndStmt.getAsObject().t;
  preRaceEndStmt.free();
  console.log(`  pre-race window: 0..${preRaceEnd} ms (${((preRaceEnd || 0) / 1000).toFixed(1)} s)`);

  // Build the trimmed DB: same schema, filtered rows
  const outDb = new SQL.Database();
  // dump schema of every table from src
  const tables = srcDb.exec(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )[0].values;
  for (const [name, sql] of tables) {
    outDb.run(sql);
    console.log(`  schema: ${name}`);
  }

  // Copy every non-session_data table verbatim (small, structural).
  const copyAll = ['android_metadata', 'sessions', 'lap_times', 'sensor_metadata', 'tracks'];
  for (const t of copyAll) {
    const res = srcDb.exec(`SELECT * FROM ${t}`);
    if (!res.length) continue;
    const cols = res[0].columns;
    const rows = res[0].values;
    const placeholders = cols.map(() => '?').join(',');
    const insert = outDb.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${placeholders})`);
    for (const row of rows) insert.run(row);
    insert.free();
    console.log(`  copied ${rows.length} rows: ${t}`);
  }

  // session_data: pre-race window OR lap_number in the kept set
  const keepArr = [...keepLapNums];
  const lapPlaceholders = keepArr.map(() => '?').join(',');
  const sqlWhere = `(timestamp <= ${preRaceEnd || 0}) OR (lap_number IN (${lapPlaceholders}))`;
  const sdRes = srcDb.exec(`SELECT * FROM session_data WHERE ${sqlWhere}`, keepArr);
  if (sdRes.length) {
    const cols = sdRes[0].columns;
    const rows = sdRes[0].values;
    const placeholders = cols.map(() => '?').join(',');
    const insert = outDb.prepare(`INSERT INTO session_data (${cols.join(',')}) VALUES (${placeholders})`);
    for (const row of rows) insert.run(row);
    insert.free();
    console.log(`  copied ${rows.length} rows: session_data (filtered)`);
  }

  // Rebuild metadata.json: keep the same shape but narrow the lap list.
  const trimmedMeta = {
    ...meta,
    sessionDataRowCount: undefined,
    laps: meta.laps.filter(l => keepLapNums.has(l.lapNumber)),
    timestampRange: {
      minMs: 0,
      maxMs: Math.max(preRaceEnd || 0, ...meta.laps.filter(l => keepLapNums.has(l.lapNumber)).map(l => l.finishTime || 0)),
    },
  };
  // strip undefined keys
  for (const k of Object.keys(trimmedMeta)) if (trimmedMeta[k] === undefined) delete trimmedMeta[k];

  // Export the trimmed DB and zip it up
  const outBytes = outDb.export();
  outDb.close();
  srcDb.close();

  const outZip = new JSZip();
  outZip.file('metadata.json', JSON.stringify(trimmedMeta, null, 2));
  outZip.file('data.db', outBytes);
  const zipBuf = await outZip.generateAsync({
    type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 },
  });
  writeFileSync(outPath, zipBuf);

  console.log(`\nwrote ${outPath}`);
  console.log(`  db: ${(outBytes.length / 1e6).toFixed(2)} MB`);
  console.log(`  zip: ${(zipBuf.length / 1e6).toFixed(2)} MB`);
}

main().catch((err) => { console.error(err); process.exit(1); });
