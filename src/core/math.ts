/*
 * Core math for the suspension solver. Ported from suspension_sim.html (v4) —
 * the solver there is validated; keep numeric behavior identical.
 * No three.js dependency: the core must stay renderer-free so it can grow
 * into the full-car sim (rear 4-link, DAQ replay) without dragging in a UI.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Serializable 3-tuple used in part specs / setup files. */
export type T3 = [number, number, number];

export class Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  clone(): Vec3 { return new Vec3(this.x, this.y, this.z); }
  set(x: number, y: number, z: number): this { this.x = x; this.y = y; this.z = z; return this; }
  copy(v: Vec3): this { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  add(v: Vec3): this { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v: Vec3): this { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  multiplyScalar(s: number): this { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v: Vec3): number { return this.x * v.x + this.y * v.y + this.z * v.z; }
  /** this = this × v (THREE.Vector3 semantics, which v4 relies on) */
  cross(v: Vec3): this {
    const ax = this.x, ay = this.y, az = this.z;
    this.x = ay * v.z - az * v.y;
    this.y = az * v.x - ax * v.z;
    this.z = ax * v.y - ay * v.x;
    return this;
  }
  lengthSq(): number { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length(): number { return Math.sqrt(this.lengthSq()); }
  normalize(): this {
    const l = this.length();
    if (l > 1e-30) this.multiplyScalar(1 / l);
    return this;
  }
  distanceTo(v: Vec3): number {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  lerp(v: Vec3, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }
  applyQuaternion(q: Quat): this {
    // v' = q v q*
    const { x, y, z } = this;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  toArray(): T3 { return [this.x, this.y, this.z]; }
}

export const V = (x: number, y: number, z: number) => new Vec3(x, y, z);
export const Va = (a: T3 | number[]) => new Vec3(a[0], a[1], a[2]);

export class Quat {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}

  clone(): Quat { return new Quat(this.x, this.y, this.z, this.w); }

  /** axis must be normalized */
  setFromAxisAngle(axis: Vec3, angle: number): this {
    const h = angle / 2, s = Math.sin(h);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s;
    this.w = Math.cos(h);
    return this;
  }

  /** shortest-arc rotation mapping unit vector `from` onto unit vector `to` (THREE semantics) */
  setFromUnitVectors(from: Vec3, to: Vec3): this {
    let r = from.dot(to) + 1;
    if (r < 1e-12) {
      // 180°: pick any axis perpendicular to `from`
      r = 0;
      if (Math.abs(from.x) > Math.abs(from.z)) {
        this.x = -from.y; this.y = from.x; this.z = 0; this.w = r;
      } else {
        this.x = 0; this.y = -from.z; this.z = from.y; this.w = r;
      }
    } else {
      this.x = from.y * to.z - from.z * to.y;
      this.y = from.z * to.x - from.x * to.z;
      this.z = from.x * to.y - from.y * to.x;
      this.w = r;
    }
    return this.normalize();
  }

  /** this = this * q (THREE.Quaternion#multiply semantics) */
  multiply(q: Quat): this {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  /** conjugate — inverse for unit quaternions */
  invert(): this { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }

  normalize(): this {
    const l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    if (l < 1e-30) { this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
    else { this.x /= l; this.y /= l; this.z /= l; this.w /= l; }
    return this;
  }
}

/** Rotate point p about the axis through axisPt with direction axisDir by ang radians. */
export function rotAboutAxis(p: Vec3, axisPt: Vec3, axisDir: Vec3, ang: number): Vec3 {
  const q = new Quat().setFromAxisAngle(axisDir.clone().normalize(), ang);
  return p.clone().sub(axisPt).applyQuaternion(q).add(axisPt);
}

/*
 * 1-D root finder, ported verbatim from v4: Newton with numeric derivative,
 * clamped to [lo,hi]; if that fails, a 240-step bracket scan + bisection,
 * preferring the root nearest the warm start x0.
 */
export function solveRoot(f: (x: number) => number, x0: number, lo: number, hi: number): number {
  let x = x0;
  for (let i = 0; i < 24; i++) {
    const fx = f(x);
    if (Math.abs(fx) < 1e-7) return x;
    const d = (f(x + 1e-5) - fx) / 1e-5;
    if (!isFinite(d) || Math.abs(d) < 1e-10) break;
    let nx = x - fx / d;
    if (nx < lo) nx = lo;
    if (nx > hi) nx = hi;
    if (Math.abs(nx - x) < 1e-9) { x = nx; break; }
    x = nx;
  }
  if (Math.abs(f(x)) < 1e-4) return x;
  const N = 240, step = (hi - lo) / N;
  let best: number | null = null, bd = 1e9, pX = lo, pF = f(lo);
  for (let s = lo + step; s <= hi + 1e-9; s += step) {
    const cf = f(s);
    if (isFinite(pF) && isFinite(cf) && pF * cf <= 0) {
      let a = pX, b = s, fa = pF;
      for (let k = 0; k < 60; k++) {
        const m = (a + b) / 2, fm = f(m);
        if (fa * fm <= 0) b = m; else { a = m; fa = fm; }
      }
      const r = (a + b) / 2, dd = Math.abs(r - x0);
      if (dd < bd) { bd = dd; best = r; }
    }
    pX = s; pF = cf;
  }
  return best !== null ? best : x;
}

/** Intersection of infinite lines P1P2 and P3P4 in 2D; null if parallel. */
export function intersect2D(
  P1: [number, number], P2: [number, number],
  P3: [number, number], P4: [number, number],
): [number, number] | null {
  const x1 = P1[0], y1 = P1[1], x2 = P2[0], y2 = P2[1];
  const x3 = P3[0], y3 = P3[1], x4 = P4[0], y4 = P4[1];
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}
