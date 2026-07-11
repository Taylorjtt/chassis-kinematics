/*
 * Setup state: parts + setup, save/load, and the v4-file importer.
 *
 * The v4 prototype stored measured hardpoints (ground coordinates at ride).
 * The importer converts them to parts: chassis pickups, a lower-arm spec
 * derived from pivots + BJ + seats, upper-arm heim leg lengths, and a
 * spindle whose locals (pin direction, wheel center, tie-rod outer) are
 * calibrated from the measured state — so an imported car reproduces the
 * v4 alignment exactly.
 *
 * The app's default car IS the imported v4 default setup: one source of
 * truth, and every v4 fixture number stays valid.
 */

import { RAD, T3, V, Va, Vec3 } from './../core/math';
import { dirToKingpinLocal, kingpinFrame, toKingpinLocal } from '../core/assembly';
import { axisFromMeasured } from '../core/calibrate';
import {
  ArmSeat, Chassis, ChassisSide, CornerParts, FrontEnd, LowerArm, Setup, Side,
  Spindle, SteeringArmPart, TieRod, UpperArm, WheelTire,
  defaultSetup, partId, zeroSlugs,
} from '../core/parts';

/* ============================================================ v4 FILE SHAPE */

export interface V4Adj {
  uio: number; uud: number; ucs: number; lio: number; lud: number;
  tie: number; lal: number; ual: number;
}

export interface V4Corner {
  measCamber: number; measToe: number;
  lowerFront: T3; lowerRear: T3; LBJ: T3;
  upperFront: T3; upperRear: T3; UBJ: T3;
  wheelCenter: T3; tieRodOuter: T3;
  springLower: T3; springUpper: T3;
  shockLower: T3; shockUpper: T3;
  adj?: Partial<V4Adj>;
}

export interface V4HP {
  common: {
    wheelRadius: number; wheelWidth: number; wheelbase: number; toeGaugeDia: number;
    pitmanPivot: T3; pitmanArmEnd: T3; idlerPivot: T3; idlerArmEnd: T3;
  };
  R: V4Corner;
  L: V4Corner;
}

const zeroV4Adj = (): V4Adj => ({ uio: 0, uud: 0, ucs: 0, lio: 0, lud: 0, tie: 0, lal: 0, ual: 0 });

/* v4 default baseline (R side; L is the mirror) — kept as the app default. */
const V4_R_DEF: V4Corner = {
  measCamber: -1.0, measToe: 0.0,
  lowerFront: [8, 5.0, 4.2], lowerRear: [-8, 5.0, 4.2], LBJ: [1.0, 24.5, 3.8],
  upperFront: [6, 10.0, 14.0], upperRear: [-6, 10.0, 14.0], UBJ: [-1.0, 22.5, 15.0],
  wheelCenter: [0, 31.0, 11.0], tieRodOuter: [6.5, 25.0, 5.2],
  springLower: [-2.0, 17.0, 4.8], springUpper: [-2.0, 14.0, 24.0],
  shockLower: [2.5, 16.0, 4.8], shockUpper: [2.5, 13.5, 24.0],
  adj: zeroV4Adj(),
};

export function mirrorV4Corner(R: V4Corner): V4Corner {
  const o = {
    measCamber: R.measCamber, measToe: R.measToe,
    adj: { ...zeroV4Adj(), ...(R.adj ?? {}) },
  } as V4Corner;
  for (const k of Object.keys(R) as (keyof V4Corner)[]) {
    if (k === 'measCamber' || k === 'measToe' || k === 'adj') continue;
    const p = R[k] as T3;
    (o as unknown as Record<string, unknown>)[k] = [p[0], -p[1], p[2]] as T3;
  }
  return o;
}

export const V4_DEFAULT: V4HP = {
  common: {
    wheelRadius: 11, wheelWidth: 8, wheelbase: 108, toeGaugeDia: 22,
    pitmanPivot: [12, -12, 6.0], pitmanArmEnd: [6, -10, 6.0],
    idlerPivot: [12, 12, 6.0], idlerArmEnd: [6, 10, 6.0],
  },
  R: JSON.parse(JSON.stringify(V4_R_DEF)),
  L: mirrorV4Corner(V4_R_DEF),
};

/* ============================================================ IMPORTER */

/** Decompose a point on an arm into {axial, radial, drop} arm-local seat
 *  coordinates. r0dir = horizontal outboard, n0dir = up (see makeRigidArm). */
function armSeatFrom(pf: Vec3, pr: Vec3, side: Side, p: Vec3): ArmSeat {
  const sign = side === 'R' ? 1 : -1;
  const u = pr.clone().sub(pf).normalize();
  const out = V(0, sign, 0);
  const r0dir = out.clone().sub(u.clone().multiplyScalar(u.dot(out))).normalize();
  let n0dir = u.clone().cross(r0dir).normalize();
  if (n0dir.z < 0) n0dir.multiplyScalar(-1);
  const rel = p.clone().sub(pf);
  const axial = rel.dot(u);
  const perp = rel.clone().sub(u.clone().multiplyScalar(axial));
  return { axial, radial: perp.dot(r0dir), drop: -perp.dot(n0dir) };
}

/**
 * Turn a scan pick of a point ON the lower arm (ball joint, shock seat) into
 * the arm-local spec {axial, radial}, given the chassis pivots and the seat's
 * known out-of-plane drop. Pose-independent: axial and the total perpendicular
 * radius are rigid under arm rotation, so a full-droop scan measures the part
 * exactly — only the drop must come from the bench (it can't be split from
 * one pose).
 */
export function armPickLengths(
  cs: ChassisSide, pick: T3, knownDrop: number,
): { axial: number; radial: number } {
  const pf = Va(cs.lowerFront), pr = Va(cs.lowerRear);
  const u = pr.clone().sub(pf).normalize();
  const rel = Va(pick).sub(pf);
  const axial = rel.dot(u);
  const perp2 = rel.lengthSq() - axial * axial;
  const radial = Math.sqrt(Math.max(perp2 - knownDrop * knownDrop, 0));
  return { axial, radial };
}

function importCorner(hp: V4HP, side: Side): { parts: CornerParts; rideTargetWCz: number } {
  const d = side === 'R' ? hp.R : hp.L;
  const adj = { ...zeroV4Adj(), ...(d.adj ?? {}) };
  const lf = Va(d.lowerFront), lr = Va(d.lowerRear), LBJ = Va(d.LBJ);
  const uf = Va(d.upperFront), ur = Va(d.upperRear), UBJ = Va(d.UBJ);
  const WC = Va(d.wheelCenter), TRO = Va(d.tieRodOuter);

  // ---- lower arm (stock part): spec from measured geometry
  const bj = armSeatFrom(lf, lr, side, LBJ);
  // v4 `lal` stretched the whole BJ offset vector; fold it into the part
  const L0 = Math.hypot(bj.radial, bj.drop);
  const s = L0 > 1e-9 ? (L0 + adj.lal) / L0 : 1;
  const lowerArm: LowerArm = {
    kind: 'lowerArm', id: partId('la'), name: `Lower arm ${side} (imported)`,
    length: bj.radial * s, bjAxial: bj.axial, bjDrop: bj.drop * s,
    springSeat: armSeatFrom(lf, lr, side, Va(d.springLower)),
    shockSeat: armSeatFrom(lf, lr, side, Va(d.shockLower)),
  };

  // ---- upper arm: heim leg lengths from pickup->BJ distances (bjDrop 0 —
  // the measured distances ARE the leg lengths, so triangulation is exact)
  const span = uf.distanceTo(ur);
  const aAx = UBJ.clone().sub(uf).dot(ur.clone().sub(uf).normalize());
  const rho0 = Math.sqrt(Math.max(uf.distanceTo(UBJ) ** 2 - aAx * aAx, 0));
  const rho = rho0 + adj.ual;                    // v4 `ual` = radial stretch
  const legF = Math.sqrt(aAx * aAx + rho * rho);
  const legR = Math.sqrt((span - aAx) * (span - aAx) + rho * rho);
  const upperArm: UpperArm = {
    kind: 'upperArm', id: partId('ua'), name: `Upper arm ${side} (imported)`,
    legFront: { baseLength: legF, heimPitchTPI: 16 },
    legRear: { baseLength: legR, heimPitchTPI: 16 },
    bjDrop: 0,
  };

  // ---- spindle: rigid LBJ->UBJ, locals calibrated from the measured state
  const kf = kingpinFrame(LBJ, UBJ, side);
  const pinDir = dirToKingpinLocal(
    kf, axisFromMeasured(side, d.measCamber, d.measToe, hp.common.toeGaugeDia),
  );
  const troLocal = toKingpinLocal(kf, TRO);
  const steeringArm: SteeringArmPart = {
    length: Math.hypot(troLocal[1], troLocal[2]),
    drop: -troLocal[0],
    sweepDeg: Math.atan2(troLocal[2], Math.abs(troLocal[1])) * RAD,
    side: troLocal[1] >= 0 ? 'front' : 'rear',
  };
  const spindle: Spindle = {
    kind: 'spindle', id: partId('sp'), name: `Spindle ${side} (imported)`,
    height: LBJ.distanceTo(UBJ),
    pin: null,
    steeringArm,
    calibrated: { pinDir, wcLocal: toKingpinLocal(kf, WC), troLocal },
  };

  // ---- tie rod: physical length at the measured state + v4 length adj
  const TRI = Va(side === 'R' ? hp.common.idlerArmEnd : hp.common.pitmanArmEnd);
  const tieRod: TieRod = {
    kind: 'tieRod', id: partId('tr'), name: `Tie rod ${side} (imported)`,
    baseLength: TRO.distanceTo(TRI) + adj.tie,
    sleevePitchTPI: 16,           // 3/4"-16 fine-thread sleeve
    endsThreaded: 2,
  };

  const wheel: WheelTire = {
    kind: 'wheelTire', id: partId('wh'), name: 'Wheel/tire (imported)',
    radius: hp.common.wheelRadius, width: hp.common.wheelWidth, offsetToHubFace: 0,
  };

  return {
    parts: { lowerArm, upperArm, spindle, tieRod, wheel },
    rideTargetWCz: WC.z,
  };
}

export interface ImportedState { front: FrontEnd; setup: Setup }

export function importV4(hp: V4HP): ImportedState {
  const side = (s: Side): ChassisSide => {
    const d = s === 'R' ? hp.R : hp.L;
    return {
      lowerFront: d.lowerFront, lowerRear: d.lowerRear,
      upperFront: d.upperFront, upperRear: d.upperRear,
      springPocketUpper: d.springUpper, shockMountUpper: d.shockUpper,
    };
  };
  const chassis: Chassis = {
    kind: 'chassis', id: partId('ch'), name: 'Chassis (imported v4)',
    wheelbase: hp.common.wheelbase,
    sides: { R: side('R'), L: side('L') },
    steeringBox: { pivot: hp.common.pitmanPivot, pitmanEnd: hp.common.pitmanArmEnd },
    idler: { pivot: hp.common.idlerPivot, armEnd: hp.common.idlerArmEnd },
  };
  const R = importCorner(hp, 'R'), L = importCorner(hp, 'L');
  const setup = defaultSetup();
  setup.toeGaugeDia = hp.common.toeGaugeDia;
  (['R', 'L'] as Side[]).forEach((s) => {
    const d = s === 'R' ? hp.R : hp.L;
    const adj = { ...zeroV4Adj(), ...(d.adj ?? {}) };
    const c = setup.corners[s];
    c.slugs = { uio: adj.uio, uud: adj.uud, ucs: adj.ucs, lio: adj.lio, lud: adj.lud };
    c.rideTargetWCz = (s === 'R' ? R : L).rideTargetWCz;
    setup.measured[s] = { camberDeg: d.measCamber, toeIn: d.measToe };
  });
  return {
    front: { chassis, corners: { R: R.parts, L: L.parts } },
    setup,
  };
}

/** App default = the imported v4 default car (single source of truth). */
export function defaultState(): ImportedState {
  return importV4(JSON.parse(JSON.stringify(V4_DEFAULT)));
}

/* ============================================================ SAVE / LOAD */

export interface SaveFile {
  app: 'clr-suspension-builder';
  version: 1;
  saved: string;
  front: FrontEnd;
  setup: Setup;
  ui?: Record<string, unknown>;
}

export function serializeState(front: FrontEnd, setup: Setup, ui?: Record<string, unknown>): string {
  const data: SaveFile = {
    app: 'clr-suspension-builder', version: 1,
    saved: new Date().toISOString(),
    front, setup, ui,
  };
  return JSON.stringify(data, null, 1);
}

/** Load either a native save file or a v4 setup file (auto-detected). */
export function loadStateJSON(text: string): ImportedState & { ui?: Record<string, unknown> } {
  const data = JSON.parse(text);
  if (data && data.app === 'clr-suspension-builder' && data.front && data.setup) {
    return { front: data.front, setup: normalizeSetup(data.setup), ui: data.ui };
  }
  // v4 file: {app:'sla-suspension-sim', HP:{common,R,L}, ui} or a bare HP
  const hp: V4HP | null =
    data && data.HP && data.HP.common ? data.HP
    : data && data.common && data.R && data.L ? data
    : null;
  if (!hp) throw new Error('Unrecognized setup file: expected a CLR save or a v4 suspension-sim file');
  const merged: V4HP = {
    common: { ...V4_DEFAULT.common, ...hp.common },
    R: { ...JSON.parse(JSON.stringify(V4_R_DEF)), ...hp.R },
    L: { ...mirrorV4Corner(V4_R_DEF), ...hp.L },
  };
  return { ...importV4(merged), ui: data.ui };
}

function normalizeSetup(s: Setup): Setup {
  const d = defaultSetup();
  return {
    ...d, ...s,
    corners: {
      R: { ...d.corners.R, ...s.corners?.R, slugs: { ...zeroSlugs(), ...s.corners?.R?.slugs } },
      L: { ...d.corners.L, ...s.corners?.L, slugs: { ...zeroSlugs(), ...s.corners?.L?.slugs } },
    },
    measured: { ...d.measured, ...s.measured },
  };
}
