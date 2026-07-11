/*
 * 3D scan import: load a whole-car scan (EinScan etc.), align it into the
 * app's frame (x fwd, y right, z up, origin = front-axle center on the
 * ground), then click points on it to fill measurement fields.
 *
 * Big-scan handling: point clouds are subsampled to a display budget, mesh
 * raycasts go through three-mesh-bvh (BVH accelerated), and the scan gets a
 * provisional fit-to-view transform so a millimeter-unit car doesn't land
 * 100x off screen before alignment.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

/* eslint-disable @typescript-eslint/no-explicit-any */
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;

const MAX_POINTS = 2_000_000;

export type ScanUnits = 'mm' | 'cm' | 'm' | 'in';
export const UNIT_TO_INCHES: Record<ScanUnits, number> = {
  mm: 1 / 25.4, cm: 1 / 2.54, m: 39.3701, in: 1,
};

/**
 * Chassis-point alignment (world coords). Designed for a car scanned on
 * stands at full droop with the wheels off: every reference is bolted to
 * the frame, so suspension position is irrelevant.
 */
export interface ChassisPicks {
  lf: THREE.Vector3;   // LEFT lower arm front pivot
  lr: THREE.Vector3;   // LEFT lower arm rear pivot
  rf: THREE.Vector3;   // RIGHT lower arm front pivot
  rr: THREE.Vector3;   // RIGHT lower arm rear pivot
  hub: THREE.Vector3;  // either hub/spindle center — fore/aft station only
}

export interface ChassisAlignResult {
  frontSpanIn: number;                       // LF<->RF pivot distance, inches
  pivots: { lf: T3; lr: T3; rf: T3; rr: T3 } // car-frame coords, auto-fill
}
type T3 = [number, number, number];

interface StoredAlign { sig: string; matrix: number[] }
const ALIGN_KEY = 'clrScanAlign';

export class ScanManager {
  readonly group = new THREE.Group();
  private markers = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private fileSig = '';
  loaded = false;
  aligned = false;
  info = '';

  constructor() {
    this.group.matrixAutoUpdate = false;
    this.group.add(this.markers);
    this.markers.matrixAutoUpdate = true;
    (this.raycaster as any).firstHitOnly = true;
  }

  async load(file: File): Promise<void> {
    this.clear();
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    const buf = await file.arrayBuffer();
    let obj: THREE.Object3D;
    let note = '';
    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await new GLTFLoader().parseAsync(buf, '');
      obj = gltf.scene;
    } else if (ext === 'obj') {
      obj = new OBJLoader().parse(new TextDecoder().decode(buf));
    } else if (ext === 'stl') {
      obj = new THREE.Mesh(new STLLoader().parse(buf));
    } else if (ext === 'ply') {
      const geo = new PLYLoader().parse(buf);
      obj = geo.getIndex() ? new THREE.Mesh(geo) : new THREE.Points(geo);
    } else if (ext === 'asc' || ext === 'xyz' || ext === 'txt') {
      obj = new THREE.Points(parseASC(new TextDecoder().decode(buf)));
    } else {
      throw new Error(`unsupported scan format .${ext} — use GLB, OBJ, STL, PLY, or ASC`);
    }

    let tris = 0, pts = 0;
    obj.traverse((o) => {
      if (o instanceof THREE.Points) {
        const before = o.geometry.getAttribute('position').count;
        if (before > MAX_POINTS) {
          o.geometry = subsample(o.geometry, MAX_POINTS);
          note = ` (${(before / 1e6).toFixed(1)}M pts → showing ${(MAX_POINTS / 1e6).toFixed(1)}M)`;
        }
        pts += o.geometry.getAttribute('position').count;
        o.material = new THREE.PointsMaterial({
          size: 0.25, sizeAttenuation: true,
          vertexColors: !!o.geometry.getAttribute('color'),
          color: o.geometry.getAttribute('color') ? 0xffffff : 0x9fb2c5,
        });
      } else if (o instanceof THREE.Mesh) {
        const g = o.geometry as THREE.BufferGeometry;
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        (g as any).computeBoundsTree({ maxLeafTris: 16 });
        tris += (g.getIndex() ? g.getIndex()!.count : g.getAttribute('position').count) / 3;
        const mat = o.material as THREE.MeshStandardMaterial;
        if (!mat?.map) {
          o.material = new THREE.MeshStandardMaterial({
            color: 0x8fa1b3, roughness: 0.9, metalness: 0.05,
            side: THREE.DoubleSide, transparent: true, opacity: 0.85,
          });
        } else {
          mat.transparent = true;
        }
      }
    });

    // provisional fit: center on origin, ground the bbox, keep aspect —
    // a mm-unit whole car would otherwise be 100x the grid
    const bb = new THREE.Box3().setFromObject(obj);
    const size = bb.getSize(new THREE.Vector3()).length() || 1;
    const s = 140 / size;
    const c = bb.getCenter(new THREE.Vector3());
    this.group.matrix.identity()
      .premultiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
      .premultiply(new THREE.Matrix4().makeScale(s, s, s))
      .premultiply(new THREE.Matrix4().makeTranslation(0, 0, (bb.max.z - bb.min.z) * s * 0.0));
    this.group.add(obj);
    this.loaded = true;
    this.aligned = false;
    this.fileSig = `${file.name}:${file.size}`;
    this.info = (tris ? `${(tris / 1e6).toFixed(1)}M tris` : `${(pts / 1e6).toFixed(2)}M points`) + note;

    // same file seen before? re-apply its stored alignment
    const stored = this.loadStoredAlign();
    if (stored) {
      this.group.matrix.fromArray(stored.matrix);
      this.aligned = true;
    }
  }

  clear(): void {
    const doomed = this.group.children.filter((c) => c !== this.markers);
    doomed.forEach((c) => {
      c.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
          (o.geometry as any).disposeBoundsTree?.();
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((mm) => mm.dispose());
        }
      });
      this.group.remove(c);
    });
    this.clearMarkers();
    this.loaded = false;
    this.aligned = false;
    this.info = '';
  }

  setOpacity(op: number): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        const m = o.material as THREE.Material & { opacity: number };
        m.transparent = true;
        m.opacity = op;
        m.needsUpdate = true;
      }
    });
  }

  /** Raycast the scan at normalized device coords; world-space hit or null. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): THREE.Vector3 | null {
    if (!this.loaded) return null;
    this.group.updateMatrixWorld(true);
    // Points threshold is interpreted in object-local units — compensate for
    // the group scale so the pick tolerance is ~0.6" on screen regardless
    const ws = new THREE.Vector3();
    this.group.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), ws);
    this.raycaster.params.Points!.threshold = 0.6 / ((ws.x + ws.y + ws.z) / 3);
    this.raycaster.setFromCamera(ndc, camera);
    const targets = this.group.children.filter((c) => c !== this.markers);
    const hits = this.raycaster.intersectObjects(targets, true);
    return hits.length ? hits[0].point.clone() : null;
  }

  addMarker(worldPt: THREE.Vector3, color = 0xffd23f): void {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 12, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    // markers live under the transformed group — store in group-local coords
    this.group.updateMatrixWorld(true);
    const inv = this.group.matrixWorld.clone().invert();
    m.position.copy(worldPt.clone().applyMatrix4(inv));
    // keep marker size ~constant in world units despite group scale
    const ws = new THREE.Vector3();
    this.group.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), ws);
    const s = 1 / ((ws.x + ws.y + ws.z) / 3);
    m.scale.set(s, s, s);
    this.markers.add(m);
  }

  clearMarkers(): void {
    [...this.markers.children].forEach((c) => {
      (c as THREE.Mesh).geometry.dispose();
      ((c as THREE.Mesh).material as THREE.Material).dispose();
      this.markers.remove(c);
    });
  }

  /**
   * Align from the four lower-arm chassis pivots + one hub center.
   * - Level: the plane through the four pivots is level at ride (pivots sit
   *   at equal heights on the frame).
   * - Centerline (y=0): midway between the left and right pivot pairs.
   * - Forward (+x): from the rear-pivot midpoint toward the front-pivot
   *   midpoint (picks are labeled, so no extra disambiguation pick).
   * - Fore/aft origin (x=0): the picked hub center's station. Droop barely
   *   moves a hub fore/aft (the arm swings about an ~fore/aft axis), so this
   *   is safe on a drooped scan.
   * - Ground (z=0): `pivotHeightIn` = how high the lower pivots sit above
   *   the ground at ride — "the bottom", one tape measurement.
   * Scale: scan unit preset, or a known LF<->RF pivot distance in inches.
   */
  applyChassisAlignment(
    p: ChassisPicks,
    opts: { unitToInches?: number; actualFrontSpanIn?: number; pivotHeightIn: number },
  ): ChassisAlignResult {
    this.group.updateMatrixWorld(true);
    const ws = new THREE.Vector3();
    this.group.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), ws);
    const worldScale = (ws.x + ws.y + ws.z) / 3;   // scan units -> current world
    const frontSpanWorld = p.lf.distanceTo(p.rf);
    const f = opts.actualFrontSpanIn
      ? opts.actualFrontSpanIn / frontSpanWorld
      : (opts.unitToInches ?? 1) / worldScale;

    const leftMid = p.lf.clone().add(p.lr).multiplyScalar(0.5);
    const rightMid = p.rf.clone().add(p.rr).multiplyScalar(0.5);
    const frontMid = p.lf.clone().add(p.rf).multiplyScalar(0.5);
    const rearMid = p.lr.clone().add(p.rr).multiplyScalar(0.5);
    const mid = leftMid.clone().add(rightMid).multiplyScalar(0.5);
    const a = rightMid.clone().sub(leftMid);           // ~right
    const b = frontMid.clone().sub(rearMid);           // ~forward
    const z = b.clone().cross(a).normalize();          // fwd × right = up
    const x = b.clone().sub(z.clone().multiplyScalar(z.dot(b))).normalize();
    const y = z.clone().cross(x).normalize();

    const R = new THREE.Matrix4().makeBasis(x, y, z).transpose();
    const T0 = new THREE.Matrix4().makeScale(f, f, f)
      .multiply(R)
      .multiply(new THREE.Matrix4().makeTranslation(-mid.x, -mid.y, -mid.z));
    // shift so the hub sets x=0 and the pivot plane sits at the ride height
    const hub0 = p.hub.clone().applyMatrix4(T0);
    const pivZ = [p.lf, p.lr, p.rf, p.rr]
      .map((q) => q.clone().applyMatrix4(T0).z)
      .reduce((s2, v) => s2 + v, 0) / 4;
    const A = new THREE.Matrix4()
      .makeTranslation(-hub0.x, 0, opts.pivotHeightIn - pivZ)
      .multiply(T0);

    this.group.matrix.premultiply(A);
    this.group.updateMatrixWorld(true);
    this.aligned = true;
    this.clearMarkers();
    if (this.fileSig) {
      const rec: StoredAlign = { sig: this.fileSig, matrix: this.group.matrix.toArray() };
      try { localStorage.setItem(ALIGN_KEY, JSON.stringify(rec)); } catch { /* storage full — realign next time */ }
    }
    const out = (q: THREE.Vector3): T3 => {
      const w = q.clone().applyMatrix4(A);
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      return [r3(w.x), r3(w.y), r3(w.z)];
    };
    return {
      frontSpanIn: frontSpanWorld * f,
      pivots: { lf: out(p.lf), lr: out(p.lr), rf: out(p.rf), rr: out(p.rr) },
    };
  }

  private loadStoredAlign(): StoredAlign | null {
    try {
      const rec = JSON.parse(localStorage.getItem(ALIGN_KEY) ?? 'null') as StoredAlign | null;
      return rec && rec.sig === this.fileSig ? rec : null;
    } catch { return null; }
  }
}

export function subsample(geo: THREE.BufferGeometry, max: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const col = geo.getAttribute('color');
  const n = pos.count;
  const stride = Math.ceil(n / max);
  const m = Math.floor(n / stride);
  const p = new Float32Array(m * 3);
  const c = col ? new Float32Array(m * 3) : null;
  for (let i = 0; i < m; i++) {
    const j = i * stride;
    p[i * 3] = pos.getX(j); p[i * 3 + 1] = pos.getY(j); p[i * 3 + 2] = pos.getZ(j);
    if (c && col) { c[i * 3] = col.getX(j); c[i * 3 + 1] = col.getY(j); c[i * 3 + 2] = col.getZ(j); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(p, 3));
  if (c) out.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geo.dispose();
  return out;
}

/** EXScan .asc / generic .xyz point cloud: "x y z [r g b]" per line. */
export function parseASC(text: string): THREE.BufferGeometry {
  const xyz: number[] = [], rgb: number[] = [];
  let hasColor = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    const parts = t.split(/[\s,;]+/).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((v) => !isFinite(v))) continue;
    xyz.push(parts[0], parts[1], parts[2]);
    if (parts.length >= 6 && parts.slice(3, 6).every(isFinite)) {
      hasColor = true;
      const scale = parts[3] > 1 || parts[4] > 1 || parts[5] > 1 ? 1 / 255 : 1;
      rgb.push(parts[3] * scale, parts[4] * scale, parts[5] * scale);
    } else {
      rgb.push(0.6, 0.7, 0.8);
    }
  }
  if (!xyz.length) throw new Error('no points found in ASC file');
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(xyz), 3));
  if (hasColor) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rgb), 3));
  return geo;
}
