#!/usr/bin/env node
/*
 * Prepare the shipped demo scan: STL → decimated + Draco-compressed GLB.
 *
 * The user's raw scan (`vintage-car-frontend.stl`, ~1 GB ASCII STL) is too
 * large to ship. We:
 *   1. Load the STL via three.js's STLLoader (handles ASCII + binary).
 *   2. Center + scale the mesh so it's near the sim's origin at inch units
 *      (EinScan exports are in mm). NOT rotated — visitor still runs the
 *      alignment wizard to fine-tune orientation.
 *   3. Export as a temporary GLB via GLTFExporter.
 *   4. Pipe through gltfpack to decimate to ~5–10 % of triangles and Draco
 *      compress. Output goes to public/demo-scan.glb.
 *
 * Usage: node scripts/prep-scan.mjs <input.stl> [outPath] [simplifyRatio]
 * Default: outPath = public/demo-scan.glb, simplifyRatio = 0.08
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// mm → inches (sim units)
const MM_TO_IN = 1 / 25.4;

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('usage: node scripts/prep-scan.mjs <input.stl> [out.glb] [simplifyRatio]');
    process.exit(1);
  }
  const outPath = resolve(process.argv[3] || resolve(PROJECT_ROOT, 'public/demo-scan.glb'));
  const simplifyRatio = parseFloat(process.argv[4] || '0.08');

  console.log(`reading ${inputPath} (${(statSync(inputPath).size / 1e9).toFixed(2)} GB)...`);
  const buffer = readFileSync(inputPath);
  console.log('parsing STL...');
  const loader = new STLLoader();
  // STLLoader expects an ArrayBuffer
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const geometry = loader.parse(arrayBuffer);
  const posAttr = geometry.getAttribute('position');
  const triCount = posAttr.count / 3;
  console.log(`  triangles: ${triCount.toLocaleString()}`);

  // Center + scale to inches (mm → in). Sim's frame is arbitrary; visitor
  // will run alignment wizard for exact placement.
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const center = bbox.getCenter(new THREE.Vector3());
  console.log(`  bounds (mm): min=${bbox.min.toArray().map(n=>n.toFixed(0)).join(',')} max=${bbox.max.toArray().map(n=>n.toFixed(0)).join(',')}`);
  const scaleMatrix = new THREE.Matrix4().makeScale(MM_TO_IN, MM_TO_IN, MM_TO_IN);
  const centerMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
  geometry.applyMatrix4(centerMatrix);
  geometry.applyMatrix4(scaleMatrix);
  geometry.computeBoundingBox();
  const bboxIn = geometry.boundingBox;
  console.log(`  bounds (in, centered): ${bboxIn.getSize(new THREE.Vector3()).toArray().map(n=>n.toFixed(1)).join(' × ')}`);

  // Write GLB directly — trivial for a positions-only mesh, and skips the
  // three.js GLTFExporter which relies on a browser FileReader.
  console.log('writing temporary GLB...');
  const positions = posAttr.array;   // Float32Array of xyz triples
  const posBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  const N = posAttr.count;
  const bboxMin = bboxIn.min, bboxMax = bboxIn.max;
  const gltf = {
    asset: { version: '2.0', generator: 'clr-suspension-builder/prep-scan' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    accessors: [{
      bufferView: 0, componentType: 5126, count: N, type: 'VEC3',
      max: [bboxMax.x, bboxMax.y, bboxMax.z],
      min: [bboxMin.x, bboxMin.y, bboxMin.z],
    }],
    bufferViews: [{ buffer: 0, byteLength: posBytes.byteLength, target: 34962 }],
    buffers: [{ byteLength: posBytes.byteLength }],
  };
  const jsonStr = JSON.stringify(gltf);
  // JSON chunk needs padding to a multiple of 4 bytes with spaces (0x20)
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (posBytes.length % 4)) % 4;
  const totalLen = 12 + 8 + jsonBytes.length + jsonPad + 8 + posBytes.length + binPad;
  const glb = new Uint8Array(totalLen);
  const dv = new DataView(glb.buffer);
  // header
  dv.setUint32(0, 0x46546C67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);
  // JSON chunk
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, 0x4E4F534A, true); // "JSON"
  glb.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) glb[20 + jsonBytes.length + i] = 0x20;
  // BIN chunk
  const binOffset = 20 + jsonBytes.length + jsonPad;
  dv.setUint32(binOffset, posBytes.length + binPad, true);
  dv.setUint32(binOffset + 4, 0x004E4942, true); // "BIN\0"
  glb.set(posBytes, binOffset + 8);
  const tmpDir = mkdtempSync(join(tmpdir(), 'prep-scan-'));
  const tmpGlb = join(tmpDir, 'raw.glb');
  writeFileSync(tmpGlb, glb);
  console.log(`  temp GLB: ${(statSync(tmpGlb).size / 1e6).toFixed(1)} MB`);

  console.log(`running gltfpack (simplify=${simplifyRatio}, meshopt compression)...`);
  execSync(`npx gltfpack -i ${tmpGlb} -o ${outPath} -si ${simplifyRatio} -cc -noq`, {
    stdio: 'inherit',
  });
  rmSync(tmpDir, { recursive: true, force: true });

  const sz = statSync(outPath).size;
  console.log(`\nwrote ${outPath}`);
  console.log(`  size: ${(sz / 1e6).toFixed(2)} MB`);
  if (sz > 15 * 1e6) {
    console.warn('  WARNING: output > 15 MB. Try a smaller simplifyRatio (e.g. 0.04).');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
