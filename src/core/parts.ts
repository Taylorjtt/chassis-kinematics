/*
 * Parts-based domain model (spec §3). Every part is a plain serializable
 * object: a `kind`, the part's own geometry in its own local frame, and an
 * id/name so a garage/parts-bin library is possible later.
 *
 * Frame coordinates: x forward, z up, +y = the driver's LEFT (the
 * right-handed third axis; sides are always labeled from the DRIVER's
 * perspective). Chassis pickup points are recorded as measured at reference
 * ride height (that's what a racer with a tape measure produces); the
 * chassis pose over ground is SETUP, not part data.
 *
 * Left/right are fully independent — circle-track asymmetry is the norm.
 * Side-symmetric quantities are stored in a side-aware local basis
 * (kingpin / forward / OUTBOARD) so a part card means the same thing bolted
 * to either side. See assembly.ts for the hard-won sign conventions.
 */

import type { T3 } from './math';

export type Side = 'R' | 'L';

export interface PartBase {
  kind: string;
  id: string;
  name: string;
}

/** One corner's pickup points on the frame, in frame coordinates. */
export interface ChassisSide {
  lowerFront: T3;
  lowerRear: T3;
  upperFront: T3;   // heim mount center
  upperRear: T3;    // heim mount center
  springPocketUpper: T3;
  shockMountUpper: T3;
}

export interface Chassis extends PartBase {
  kind: 'chassis';
  wheelbase: number;
  sides: { R: ChassisSide; L: ChassisSide };
  steeringBox: { pivot: T3; pitmanEnd: T3 };
  idler: { pivot: T3; armEnd: T3 };
}

/**
 * Stock GM-style stamped lower arm — fixed spec, in the arm's own frame:
 * the pivot axis runs front pivot -> rear pivot.
 *   axial  = distance along the pivot axis from the FRONT pivot
 *   radial = perpendicular distance out from the pivot axis
 *   drop   = below (+) the pivot-axis plane, measured perpendicular to both
 */
export interface ArmSeat { axial: number; radial: number; drop: number }

export interface LowerArm extends PartBase {
  kind: 'lowerArm';
  length: number;    // pivot axis -> BJ center, perpendicular radius
  bjAxial: number;   // BJ position along the pivot axis from the front pivot
  bjDrop: number;    // BJ below (+) the pivot axis plane
  springSeat: ArmSeat;
  shockSeat: ArmSeat;
}

/**
 * Heim-adjustable upper A-frame. Each leg threads at the chassis heim:
 * effective length = baseLength + turns / heimPitchTPI (turns live in SETUP).
 * The BJ is located by triangulating the two leg lengths from the two
 * pickups (in the plane of the legs), then offset bjDrop out of that plane
 * (toward the ground).
 */
export interface UpperArmLeg { baseLength: number; heimPitchTPI: number }

export interface UpperArm extends PartBase {
  kind: 'upperArm';
  legFront: UpperArmLeg;
  legRear: UpperArmLeg;
  bjDrop: number;
}

/**
 * GM "long" spindle, 3-piece: spindle body + bolt-on steering arm (+ brake
 * bracket, cosmetic for now). All machined geometry lives in the spindle's
 * kingpin-local frame (see assembly.ts KingpinFrame): k = LBJ->UBJ,
 * f = forward, o = OUTBOARD. Pin angles can't be tape-measured, so a part
 * may instead carry `calibrated` locals back-solved from measured
 * camber/toe (spec §5); calibrated values override the card fields.
 */
export interface SpindlePin {
  heightAboveLBJ: number;  // boss center up the kingpin from the LBJ
  inclinationDeg: number;  // pin dip below the plane perpendicular to the kingpin (+ = down)
  sweepDeg: number;        // pin sweep toward forward (+) in that plane
  snoutLength: number;     // boss -> hub face along the pin
}

export interface SteeringArmPart {
  length: number;           // kingpin axis -> tie-rod hole, horizontal reach
  drop: number;             // tie-rod hole below (+) the LBJ, along -k
  sweepDeg: number;         // from straight fore/aft toward OUTBOARD (+)
  side: 'front' | 'rear';   // which way the arm points off the spindle body
}

/** Locals in the kingpin frame, stored as {k, f, o} components. */
export interface SpindleCalibration {
  pinDir?: T3;       // wheel spin axis direction (unit), kingpin-local
  wcLocal?: T3;      // wheel center relative to LBJ, kingpin-local
  hubFaceLocal?: T3; // hub face center rel. LBJ (scan-measured; wheel center
                     //   = hub face + pinDir * wheel.offsetToHubFace)
  troLocal?: T3;     // tie-rod outer relative to LBJ, kingpin-local
}

export interface Spindle extends PartBase {
  kind: 'spindle';
  height: number;                 // LBJ center -> UBJ center (rigid)
  pin: SpindlePin | null;         // null = unknown, needs calibration (§5)
  steeringArm: SteeringArmPart;
  calibrated?: SpindleCalibration;
}

/** Tie rod with adjustable sleeve. A LH/RH double-threaded sleeve (the norm)
 *  moves BOTH ends per turn: effective length = base + turns·ends/TPI.
 *  Target hardware is 3/4"-16 fine thread -> 0.125" per sleeve turn. */
export interface TieRod extends PartBase {
  kind: 'tieRod';
  baseLength: number;
  sleevePitchTPI: number;
  endsThreaded?: 1 | 2;   // default 2 (LH/RH sleeve)
}

export interface WheelTire extends PartBase {
  kind: 'wheelTire';
  radius: number;          // loaded radius
  width: number;
  offsetToHubFace: number; // hub face -> wheel center plane along the pin, + outboard
}

export interface CornerParts {
  lowerArm: LowerArm;
  upperArm: UpperArm;
  spindle: Spindle;
  tieRod: TieRod;
  wheel: WheelTire;
}

export interface FrontEnd {
  chassis: Chassis;
  corners: { R: CornerParts; L: CornerParts };
}

/* ============================================================ SETUP STATE
 * What you change between races — separate from the parts (spec §3).
 */

/** Slug/shim offsets on slotted chassis mounts, in inches (v4 conventions:
 *  io + = pivot moves toward the wheel; ud + = up; ucs = caster split on the
 *  front upper slug, + front-out). */
export interface SlugShims { uio: number; uud: number; ucs: number; lio: number; lud: number }

export interface CornerSetup {
  heimTurnsFront: number;   // + = longer leg
  heimTurnsRear: number;
  tieRodTurns: number;      // + = longer tie rod
  slugs: SlugShims;
  /** Trim target: wheel-center height over ground at ride ("jack bolt").
   *  Defaults to the tire's loaded radius = tire on the ground. */
  rideTargetWCz: number | null;
}

export interface Setup {
  corners: { R: CornerSetup; L: CornerSetup };
  frameRaise: number;       // whole-frame height change from reference (in); rake later
  toeGaugeDia: number;      // measure toe in inches across this diameter (tape method)
  measured: {               // calibration inputs (§5), per side
    R: { camberDeg: number; toeIn: number };
    L: { camberDeg: number; toeIn: number };
  };
}

export const zeroSlugs = (): SlugShims => ({ uio: 0, uud: 0, ucs: 0, lio: 0, lud: 0 });

export const defaultCornerSetup = (): CornerSetup => ({
  heimTurnsFront: 0,
  heimTurnsRear: 0,
  tieRodTurns: 0,
  slugs: zeroSlugs(),
  rideTargetWCz: null,
});

export const defaultSetup = (): Setup => ({
  corners: { R: defaultCornerSetup(), L: defaultCornerSetup() },
  frameRaise: 0,
  toeGaugeDia: 22,
  measured: { R: { camberDeg: 0, toeIn: 0 }, L: { camberDeg: 0, toeIn: 0 } },
});

let idCounter = 0;
export function partId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}

export function effectiveLegLength(leg: UpperArmLeg, turns: number): number {
  return leg.baseLength + turns / leg.heimPitchTPI;
}

export function effectiveTieRodLength(rod: TieRod, turns: number): number {
  return rod.baseLength + (turns * (rod.endsThreaded ?? 2)) / rod.sleevePitchTPI;
}
