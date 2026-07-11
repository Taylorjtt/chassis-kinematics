/*
 * Assembly solver (spec §4). Bolts the parts together per corner and solves
 * the constrained kinematics. The solver chain is ported from v4 (validated):
 *
 *   1. lower-arm angle θ rotates the LBJ about the pickup axis
 *   2. upper-arm angle φ root-solved so |UBJ - LBJ| = spindle.height
 *   3. upright pose: rigid transform anchored at the LBJ — quaternion maps
 *      reference kingpin dir -> current, then rotate ψ about current kingpin
 *   4. ψ root-solved so |TRO(ψ) - TRI| = tie-rod effective length; TRI from
 *      the pitman / center-link / idler 4-bar
 *   5. ride trim (trim.ts): θ root-solved through the FULL chain (ψ included
 *      — v4 lesson) so the wheel center lands on the ride target
 *   6. wheel located off the spindle pin
 *
 * Sign/coordinate invariants (hard-won — regression tests must stay):
 *   frame x fwd, z up, +y = the driver's LEFT (right-handed: x×y=z). Sides
 *   are labeled from the DRIVER's perspective. Left geometry is real, never
 *   implicitly mirrored. Any rotation built from a side-symmetric quantity
 *   (camber!) must carry the side sign — v4 had a left-camber sign bug.
 *   Toe-in positive. Camber negative = top in. Shock compression positive.
 */

import {
  DEG, RAD, Quat, T3, V, Va, Vec3, rotAboutAxis, solveRoot,
} from './math';
import {
  ArmSeat, Chassis, ChassisSide, CornerParts, CornerSetup, FrontEnd, Setup,
  Side, Spindle, SteeringArmPart, WheelTire,
  effectiveLegLength, effectiveTieRodLength,
} from './parts';

export class AssemblyError extends Error {
  constructor(message: string, public side?: Side, public armFixable = false) {
    super(message);
  }
}

/* ============================================================ RIGID ARM
 * A control arm is rigid: attachments are stored in arm-local coordinates
 * {axial a0 along the pivot axis from the front pivot, radial vector r0
 * perpendicular to it} and transported by the arm angle θ.
 */
export interface ArmAttachment { a0: number; r0: Vec3 }

export interface RigidArm {
  pf: Vec3;                // front pivot (adjusted, world)
  dir: Vec3;               // pivot axis unit, front -> rear
  r0dir: Vec3;             // radial reference at θ=0: horizontal, outboard
  n0dir: Vec3;             // completes the basis, z-positive ("up")
  point(att: ArmAttachment, theta: number): Vec3;
}

export function makeRigidArm(pf: Vec3, pr: Vec3, side: Side): RigidArm {
  const sign = side === 'L' ? 1 : -1;   // +y = LEFT (driver side)
  const dir = pr.clone().sub(pf).normalize();
  const out = V(0, sign, 0);
  const r0dir = out.clone().sub(dir.clone().multiplyScalar(dir.dot(out))).normalize();
  if (r0dir.length() < 0.5) throw new AssemblyError('lower/upper pivot axis is vertical-lateral; cannot orient arm');
  let n0dir = dir.clone().cross(r0dir).normalize();
  if (n0dir.z < 0) n0dir = n0dir.multiplyScalar(-1);
  return {
    pf, dir, r0dir, n0dir,
    point(att: ArmAttachment, theta: number): Vec3 {
      const c = this.pf.clone().add(this.dir.clone().multiplyScalar(att.a0));
      return rotAboutAxis(c.clone().add(att.r0), c, this.dir, theta);
    },
  };
}

/** Build an attachment from a seat spec: radial out + drop down at θ=0. */
export function seatAttachment(arm: RigidArm, seat: ArmSeat): ArmAttachment {
  const r0 = arm.r0dir.clone().multiplyScalar(seat.radial)
    .add(arm.n0dir.clone().multiplyScalar(-seat.drop));
  return { a0: seat.axial, r0 };
}

/* ============================================================ KINGPIN FRAME
 * The spindle's own coordinate system, side-aware so one part card means
 * the same thing on either side of the car:
 *   k = kingpin unit, LBJ -> UBJ
 *   f = forward unit, +x projected perpendicular to k
 *   o = OUTBOARD unit = (k × f) * sideSign
 * Locals are stored as [k, f, o] components (T3).
 */
export interface KingpinFrame { origin: Vec3; k: Vec3; f: Vec3; o: Vec3 }

export function kingpinFrame(LBJ: Vec3, UBJ: Vec3, side: Side): KingpinFrame {
  const sign = side === 'L' ? 1 : -1;   // +y = LEFT (driver side)
  const k = UBJ.clone().sub(LBJ).normalize();
  const x = V(1, 0, 0);
  const f = x.clone().sub(k.clone().multiplyScalar(k.dot(x))).normalize();
  const o = k.clone().cross(f).multiplyScalar(sign);
  return { origin: LBJ.clone(), k, f, o };
}

export function fromKingpinLocal(fr: KingpinFrame, local: T3): Vec3 {
  return fr.origin.clone()
    .add(fr.k.clone().multiplyScalar(local[0]))
    .add(fr.f.clone().multiplyScalar(local[1]))
    .add(fr.o.clone().multiplyScalar(local[2]));
}

export function dirFromKingpinLocal(fr: KingpinFrame, local: T3): Vec3 {
  return fr.k.clone().multiplyScalar(local[0])
    .add(fr.f.clone().multiplyScalar(local[1]))
    .add(fr.o.clone().multiplyScalar(local[2]));
}

export function toKingpinLocal(fr: KingpinFrame, world: Vec3): T3 {
  const d = world.clone().sub(fr.origin);
  return [d.dot(fr.k), d.dot(fr.f), d.dot(fr.o)];
}

export function dirToKingpinLocal(fr: KingpinFrame, dir: Vec3): T3 {
  return [dir.dot(fr.k), dir.dot(fr.f), dir.dot(fr.o)];
}

/* ---- spindle machined geometry -> kingpin locals ------------------------ */

export interface SpindleLocals {
  pinDir: T3;    // wheel spin axis, unit, kingpin-local (points outboard)
  wcLocal: T3;   // wheel center rel. LBJ
  troLocal: T3;  // tie-rod outer rel. LBJ
}

export function steeringArmLocal(arm: SteeringArmPart): T3 {
  const sw = arm.sweepDeg * DEG;
  const fore = arm.side === 'front' ? 1 : -1;
  // k, f, o components
  return [
    -arm.drop,
    fore * arm.length * Math.cos(sw),
    arm.length * Math.sin(sw),
  ];
}

export function spindleLocals(spindle: Spindle, wheel: WheelTire): SpindleLocals {
  const cal = spindle.calibrated;
  let pinDir: T3 | null = cal?.pinDir ?? null;
  if (!pinDir && spindle.pin) {
    const p = spindle.pin;
    const inc = p.inclinationDeg * DEG, sw = p.sweepDeg * DEG;
    // pin drops `inc` below the plane perpendicular to the kingpin and
    // sweeps `sw` toward forward; components are [k, f, o]
    pinDir = [
      -Math.sin(inc),
      Math.cos(inc) * Math.sin(sw),
      Math.cos(inc) * Math.cos(sw),
    ];
  }

  // wheel center priority: explicit calibrated wc -> scan-measured hub face
  // + wheel offset along the pin -> pin card geometry
  let wcLocal: T3 | null = cal?.wcLocal ?? null;
  if (!wcLocal && cal?.hubFaceLocal && pinDir) {
    const h = cal.hubFaceLocal, off = wheel.offsetToHubFace;
    wcLocal = [h[0] + pinDir[0] * off, h[1] + pinDir[1] * off, h[2] + pinDir[2] * off];
  }
  if (!wcLocal && spindle.pin && pinDir) {
    const p = spindle.pin;
    const reach = p.snoutLength + wheel.offsetToHubFace;
    wcLocal = [
      p.heightAboveLBJ + pinDir[0] * reach,
      pinDir[1] * reach,
      pinDir[2] * reach,
    ];
  }
  if (!pinDir || !wcLocal) {
    throw new AssemblyError(
      `spindle "${spindle.name}": pin geometry unknown — measure it from the scan, fill in the pin card, or run calibration (§5)`,
    );
  }
  const troLocal = cal?.troLocal ?? steeringArmLocal(spindle.steeringArm);
  return { pinDir, wcLocal, troLocal };
}

/* ============================================================ CORNER STATIC
 * The calibrated, adjusted reference assembly for one corner — the
 * equivalent of v4's buildStatic() output. All reference geometry is in
 * ground coordinates with the chassis at its setup pose.
 */
export interface CornerStatic {
  side: number;                 // +1 left (driver side, +y), -1 right
  sideKey: Side;
  // adjusted pickup points (world)
  lowerFront: Vec3; lowerRear: Vec3;
  upperFront: Vec3; upperRear: Vec3;
  lowArm: RigidArm;
  upArm: RigidArm;
  attLBJ: ArmAttachment;
  attUBJ: ArmAttachment;
  attSpringLow: ArmAttachment;
  attShockLow: ArmAttachment;
  springUpper0: Vec3;
  shockUpper0: Vec3;
  uprLen: number;               // spindle height, rigid
  // reference assembly state (θ=0) used to anchor the upright transform
  LBJ0: Vec3; UBJ0: Vec3; WC0: Vec3; TRO0: Vec3;
  wheelAxis0: Vec3;             // wheel spin axis at reference, world
  kf0: KingpinFrame;            // reference kingpin frame
  tieLen: number;               // physical tie rod, base + turns/TPI
  rideTarget: number;           // wheel-center height over ground at ride
  wheel: WheelTire;
  // solver warm-start / trim state (mutated by solves)
  phi: number; psi: number;
  trimTheta: number;
  shockLenTrim: number;
  headAng0: number;
  static?: CornerSolution;
}

function applyFramePose(p: Vec3, setup: Setup): Vec3 {
  // chassis pose over ground = setup; rake/roll TODO when the whole-car sim
  // needs them — keep the transform in one place so that lands here.
  return p.clone().add(V(0, 0, setup.frameRaise));
}

function chassisSidePoints(cs: ChassisSide, setup: Setup, corner: CornerSetup, side: Side) {
  const sign = side === 'L' ? 1 : -1;   // +y = LEFT (driver side)
  const io = (v: number) => V(0, sign * v, 0);   // + = toward the wheel
  const a = corner.slugs;
  const P = (t: T3) => applyFramePose(Va(t), setup);
  return {
    lowerFront: P(cs.lowerFront).add(io(a.lio)).add(V(0, 0, a.lud)),
    lowerRear: P(cs.lowerRear).add(io(a.lio)).add(V(0, 0, a.lud)),
    upperFront: P(cs.upperFront).add(io(a.uio + a.ucs)).add(V(0, 0, a.uud)),
    upperRear: P(cs.upperRear).add(io(a.uio - a.ucs)).add(V(0, 0, a.uud)),
    springPocketUpper: P(cs.springPocketUpper),
    shockMountUpper: P(cs.shockMountUpper),
  };
}

/** Triangulate the upper BJ from the two heim leg lengths (spec §3). */
export function upperBJAttachment(
  arm: RigidArm, pickupDist: number, legFrontLen: number, legRearLen: number, bjDrop: number,
): ArmAttachment {
  const d = pickupDist;
  if (d < 1e-6) throw new AssemblyError('upper arm pickups coincide');
  const a = (legFrontLen * legFrontLen + d * d - legRearLen * legRearLen) / (2 * d);
  const rho2 = legFrontLen * legFrontLen - a * a;
  if (rho2 <= 1e-9) {
    throw new AssemblyError('upper arm legs cannot reach: leg lengths do not triangulate over the pickup span');
  }
  const rho = Math.sqrt(rho2);
  const r0 = arm.r0dir.clone().multiplyScalar(rho)
    .add(arm.n0dir.clone().multiplyScalar(-bjDrop));
  return { a0: a, r0 };
}

/* ============================================================ DIAGNOSTICS
 * When a corner won't assemble, the racer needs to SEE the mismatch, not a
 * dead end: what the arms can reach vs what the spindle needs, in inches.
 */
export interface CornerDiagnostics {
  side: Side;
  ok: boolean;
  error?: string;
  spindleHeight: number;
  legFront: number;
  legRear: number;
  reachMin?: number;   // |UBJ(φ) − LBJ0| over the solver's φ range
  reachMax?: number;
  LBJ0?: Vec3;
  UBJ0?: Vec3;         // UBJ at the φ that comes closest to the spindle height
  pickups?: { lowerFront: Vec3; lowerRear: Vec3; upperFront: Vec3; upperRear: Vec3 };
}

export function cornerDiagnostics(
  chassis: Chassis, parts: CornerParts, setup: Setup, side: Side,
): CornerDiagnostics {
  const corner = setup.corners[side];
  const h = parts.spindle.height;
  const legFront = effectiveLegLength(parts.upperArm.legFront, corner.heimTurnsFront);
  const legRear = effectiveLegLength(parts.upperArm.legRear, corner.heimTurnsRear);
  const base = { side, spindleHeight: h, legFront, legRear };
  try {
    const pts = chassisSidePoints(chassis.sides[side], setup, corner, side);
    const lowArm = makeRigidArm(pts.lowerFront, pts.lowerRear, side);
    const upArm = makeRigidArm(pts.upperFront, pts.upperRear, side);
    const la = parts.lowerArm;
    const attLBJ = seatAttachment(lowArm, { axial: la.bjAxial, radial: la.length, drop: la.bjDrop });
    const LBJ0 = lowArm.point(attLBJ, 0);
    const pickups = {
      lowerFront: pts.lowerFront, lowerRear: pts.lowerRear,
      upperFront: pts.upperFront, upperRear: pts.upperRear,
    };
    let attUBJ: ArmAttachment;
    try {
      attUBJ = upperBJAttachment(
        upArm, pts.upperFront.distanceTo(pts.upperRear), legFront, legRear, parts.upperArm.bjDrop,
      );
    } catch (e) {
      return { ...base, ok: false, LBJ0, pickups, error: (e as Error).message };
    }
    let reachMin = Infinity, reachMax = -Infinity, bestPhi = 0, bestErr = Infinity;
    for (let i = 0; i <= 48; i++) {
      const phi = -0.9 + (1.8 * i) / 48;
      const d = upArm.point(attUBJ, phi).distanceTo(LBJ0);
      if (d < reachMin) reachMin = d;
      if (d > reachMax) reachMax = d;
      if (Math.abs(d - h) < bestErr) { bestErr = Math.abs(d - h); bestPhi = phi; }
    }
    const ok = h >= reachMin - 1e-3 && h <= reachMax + 1e-3;
    return {
      ...base, ok, LBJ0, pickups,
      reachMin, reachMax, UBJ0: upArm.point(attUBJ, bestPhi),
      error: ok ? undefined
        : `spindle ${h.toFixed(2)}" vs arm reach ${reachMin.toFixed(2)}"–${reachMax.toFixed(2)}" `
          + `(${h > reachMax ? (h - reachMax).toFixed(2) + '" too tall' : (reachMin - h).toFixed(2) + '" too short'})`,
    };
  } catch (e) {
    return { ...base, ok: false, error: (e as Error).message };
  }
}

/**
 * Smallest equal change to both upper leg base lengths that lets the corner
 * assemble at reference (per-corner only — trim/steering judged separately).
 */
export function fitUpperLegsToSpindle(
  chassis: Chassis, parts: CornerParts, setup: Setup, side: Side, maxDelta = 6,
): number | null {
  for (let i = 0; i <= Math.round(maxDelta / 0.05); i++) {
    for (const d of i === 0 ? [0] : [i * 0.05, -i * 0.05]) {
      const trial: CornerParts = JSON.parse(JSON.stringify(parts));
      trial.upperArm.legFront.baseLength += d;
      trial.upperArm.legRear.baseLength += d;
      try {
        buildCornerStatic(chassis, trial, setup, side);
        return d;
      } catch { /* keep searching */ }
    }
  }
  return null;
}

export function buildCornerStatic(
  chassis: Chassis, parts: CornerParts, setup: Setup, side: Side,
): CornerStatic {
  const sign = side === 'L' ? 1 : -1;   // +y = LEFT (driver side)
  const corner = setup.corners[side];
  const pts = chassisSidePoints(chassis.sides[side], setup, corner, side);

  const lowArm = makeRigidArm(pts.lowerFront, pts.lowerRear, side);
  const upArm = makeRigidArm(pts.upperFront, pts.upperRear, side);

  const la = parts.lowerArm;
  const attLBJ = seatAttachment(lowArm, { axial: la.bjAxial, radial: la.length, drop: la.bjDrop });
  const attSpringLow = seatAttachment(lowArm, la.springSeat);
  const attShockLow = seatAttachment(lowArm, la.shockSeat);

  const ua = parts.upperArm;
  let attUBJ: ArmAttachment;
  try {
    attUBJ = upperBJAttachment(
      upArm,
      pts.upperFront.distanceTo(pts.upperRear),
      effectiveLegLength(ua.legFront, corner.heimTurnsFront),
      effectiveLegLength(ua.legRear, corner.heimTurnsRear),
      ua.bjDrop,
    );
  } catch (e) {
    throw new AssemblyError(`${side}: ${(e as Error).message}`, side, true);
  }

  // ---- reference state: lower arm at θ=0, upper arm solved to spindle height
  const LBJ0 = lowArm.point(attLBJ, 0);
  const uprLen = parts.spindle.height;
  const fRef = (phi: number) => upArm.point(attUBJ, phi).distanceTo(LBJ0) - uprLen;
  const phi0 = solveRoot(fRef, 0, -0.9, 0.9);
  if (Math.abs(fRef(phi0)) > 1e-3) {
    throw new AssemblyError(
      `${side}: cannot assemble — spindle height ${uprLen.toFixed(2)}" unreachable by the arms`,
      side, true,
    );
  }
  const UBJ0 = upArm.point(attUBJ, phi0);

  const kf0 = kingpinFrame(LBJ0, UBJ0, side);
  const locals = spindleLocals(parts.spindle, parts.wheel);
  const WC0 = fromKingpinLocal(kf0, locals.wcLocal);
  const TRO0 = fromKingpinLocal(kf0, locals.troLocal);
  const wheelAxis0 = dirFromKingpinLocal(kf0, locals.pinDir).normalize();

  return {
    side: sign, sideKey: side,
    lowerFront: pts.lowerFront, lowerRear: pts.lowerRear,
    upperFront: pts.upperFront, upperRear: pts.upperRear,
    lowArm, upArm, attLBJ, attUBJ, attSpringLow, attShockLow,
    springUpper0: pts.springPocketUpper, shockUpper0: pts.shockMountUpper,
    uprLen, LBJ0, UBJ0, WC0, TRO0, wheelAxis0, kf0,
    tieLen: effectiveTieRodLength(parts.tieRod, corner.tieRodTurns),
    rideTarget: corner.rideTargetWCz ?? parts.wheel.radius,
    wheel: parts.wheel,
    phi: phi0, psi: 0, trimTheta: 0, shockLenTrim: 0, headAng0: 0,
  };
}

/* ============================================================ SOLVER CHAIN
 * Direct port of v4 solveUBJ / uprightXform / solveCorner.
 */
export function solveUBJ(stat: CornerStatic, LBJ: Vec3, warm: number) {
  const f = (phi: number) => stat.upArm.point(stat.attUBJ, phi).distanceTo(LBJ) - stat.uprLen;
  const phi = solveRoot(f, warm, -0.9, 0.9);
  return { phi, UBJ: stat.upArm.point(stat.attUBJ, phi) };
}

export interface UprightXform {
  xf(p0: Vec3): Vec3;
  xfDir(d0: Vec3): Vec3;
  invDir(dw: Vec3): Vec3;
}

export function uprightXform(stat: CornerStatic, LBJ: Vec3, UBJ: Vec3, psi: number): UprightXform {
  const e1 = stat.UBJ0.clone().sub(stat.LBJ0).normalize();
  const f1 = UBJ.clone().sub(LBJ).normalize();
  const R0 = new Quat().setFromUnitVectors(e1, f1);
  const Rp = new Quat().setFromAxisAngle(f1, psi);
  const R = Rp.clone().multiply(R0);
  const Rinv = R.clone().invert();
  return {
    xf: (p0: Vec3) => p0.clone().sub(stat.LBJ0).applyQuaternion(R).add(LBJ),
    xfDir: (d0: Vec3) => d0.clone().applyQuaternion(R),
    invDir: (dw: Vec3) => dw.clone().applyQuaternion(Rinv),
  };
}

export interface CornerSolution {
  LBJ: Vec3; UBJ: Vec3; WC: Vec3; TRO: Vec3; TRI: Vec3;
  spin: Vec3;
  camber: number; toe: number; steerAng: number;
  casterLive: number; kpiLive: number;
  scrub: number; trail: number;
  CPy: number;
  theta: number;
  xf: (p0: Vec3) => Vec3;
}

export function solveCorner(
  stat: CornerStatic, theta: number, TRI: Vec3, tieLen: number,
  warm: { phi: number; psi: number },
): CornerSolution {
  const LBJ = stat.lowArm.point(stat.attLBJ, theta);
  const ub = solveUBJ(stat, LBJ, warm.phi);
  const UBJ = ub.UBJ;
  const g = (psi: number) => uprightXform(stat, LBJ, UBJ, psi).xf(stat.TRO0).distanceTo(TRI) - tieLen;
  const psi = solveRoot(g, warm.psi, -0.9, 0.9);
  const x = uprightXform(stat, LBJ, UBJ, psi);
  const WC = x.xf(stat.WC0), TRO = x.xf(stat.TRO0);
  const spin = x.xfDir(stat.wheelAxis0).normalize();
  stat.phi = ub.phi; stat.psi = psi;
  const ob = stat.side;
  // camber negative = top in; side sign carried explicitly (v4 regression)
  const camber = -Math.atan2(spin.z, ob * spin.y) * RAD;
  const heading = spin.clone().cross(V(0, 0, 1));
  if (heading.x < 0) heading.multiplyScalar(-1);
  const toe = -ob * Math.atan2(heading.y, heading.x) * RAD;  // toe-in positive
  const steerAng = Math.atan2(heading.y, heading.x) * RAD;
  const kp = UBJ.clone().sub(LBJ);
  const casterLive = Math.atan2(LBJ.x - UBJ.x, UBJ.z - LBJ.z) * RAD;
  const kpiLive = Math.atan2(ob * (LBJ.y - UBJ.y), UBJ.z - LBJ.z) * RAD;
  let scrub = NaN, trail = NaN;
  if (Math.abs(kp.z) > 1e-6) {
    const tg = -LBJ.z / kp.z;
    const gy = LBJ.y + tg * kp.y, gx = LBJ.x + tg * kp.x;
    scrub = ob * (WC.y - gy);
    trail = gx - WC.x;
  }
  return { LBJ, UBJ, WC, TRO, TRI, spin, camber, toe, steerAng, casterLive, kpiLive, scrub, trail, CPy: WC.y, theta, xf: x.xf };
}

/* ============================================================ STEERING 4-BAR
 * pitman / center link / idler, rotation about z, warm-started (v4 port).
 */
export class SteeringLinkage {
  private warmBeta = 0;
  constructor(private chassis: Chassis, private setup: Setup) {}

  solve(pitmanDeg: number) {
    const c = this.chassis;
    const P = (t: T3) => applyFramePose(Va(t), this.setup);
    const Pp = P(c.steeringBox.pivot), Pi = P(c.idler.pivot);
    const CLL0 = P(c.steeringBox.pitmanEnd), CLR0 = P(c.idler.armEnd);
    const Z = V(0, 0, 1);
    const CLL = rotAboutAxis(CLL0, Pp, Z, pitmanDeg * DEG);
    const clen0 = CLL0.distanceTo(CLR0);
    const beta = solveRoot(
      (b) => rotAboutAxis(CLR0, Pi, Z, b).distanceTo(CLL) - clen0,
      this.warmBeta, -1.2, 1.2,
    );
    this.warmBeta = beta;
    const CLR = rotAboutAxis(CLR0, Pi, Z, beta);
    // each tie rod takes the center-link end on ITS side of the car —
    // decided by GEOMETRY, not by pitman/idler naming (the steering box can
    // sit on either side; on most GM circle-track chassis it's on the LEFT)
    const pitmanIsLeft = CLL0.y > CLR0.y;
    return {
      CLL, CLR, Pp, Pi,
      TRI_L: (pitmanIsLeft ? CLL : CLR).clone(),
      TRI_R: (pitmanIsLeft ? CLR : CLL).clone(),
    };
  }
}

export type SteeringState = ReturnType<SteeringLinkage['solve']>;
export type { FrontEnd };
