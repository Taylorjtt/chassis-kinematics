/*
 * Ride trim + travel solvers (v4 port) and the whole-front-end assembly.
 *
 * The trim solve MUST run through the full chain including the tie-rod ψ
 * solve — ψ affects wheel height (v4 lesson; round-trip test < 0.001").
 */

import { Vec3, solveRoot } from './math';
import {
  AssemblyError, CornerStatic, SteeringLinkage, buildCornerStatic,
  solveCorner, solveUBJ, uprightXform,
} from './assembly';
import { FrontEnd, Setup, Side } from './parts';

/** Wheel-center height through the FULL chain (θ, φ, ψ all consistent). */
export function fullWCz(stat: CornerStatic, theta: number, TRI: Vec3, tieLen: number): number {
  const LBJ = stat.lowArm.point(stat.attLBJ, theta);
  const ub = solveUBJ(stat, LBJ, 0);
  const g = (psi: number) => uprightXform(stat, LBJ, ub.UBJ, psi).xf(stat.TRO0).distanceTo(TRI) - tieLen;
  const psi = solveRoot(g, 0, -0.9, 0.9);
  return uprightXform(stat, LBJ, ub.UBJ, psi).xf(stat.WC0).z;
}

/** θ that puts the wheel center dz above the ride target ("jack bolt"). */
export function thetaForWheel(stat: CornerStatic, dz: number, TRI: Vec3, tieLen: number): number {
  return solveRoot(
    (t) => fullWCz(stat, t, TRI, tieLen) - stat.rideTarget - dz,
    stat.trimTheta, -0.7, 0.7,
  );
}

export function shockLenAt(stat: CornerStatic, theta: number): number {
  return stat.shockUpper0.distanceTo(stat.lowArm.point(stat.attShockLow, theta));
}

/** θ for a given shock travel from the trimmed static length (compression +). */
export function thetaForShock(stat: CornerStatic, travel: number, TRI: Vec3, tieLen: number): number {
  return solveRoot(
    (t) => shockLenAt(stat, t) - (stat.shockLenTrim - travel),
    stat.trimTheta, -0.7, 0.7,
  );
}

/** ψ=0 wheel-center height helper for the motion-ratio derivative. */
export function wczAt(stat: CornerStatic, theta: number): number {
  const LBJ = stat.lowArm.point(stat.attLBJ, theta);
  const ub = solveUBJ(stat, LBJ, 0);
  return uprightXform(stat, LBJ, ub.UBJ, 0).xf(stat.WC0).z;
}

/** dShock/dWheel, numeric, at arm angle θ. */
export function motionRatio(stat: CornerStatic, theta: number): number {
  const d = 0.012;
  const dW = wczAt(stat, theta + d) - wczAt(stat, theta - d);
  const dS = shockLenAt(stat, theta + d) - shockLenAt(stat, theta - d);
  return Math.abs(dW) < 1e-6 ? 0 : Math.abs(dS / dW);
}

/* ============================================================ FRONT ASSEMBLY
 * Equivalent of v4 recomputeStatics(): build both corners from parts +
 * setup, trim ride height, record trimmed static alignment as OUTPUTS.
 */
export interface FrontAssembly {
  statR: CornerStatic;
  statL: CornerStatic;
  steering: SteeringLinkage;
}

export function assembleFront(front: FrontEnd, setup: Setup): FrontAssembly {
  const steering = new SteeringLinkage(front.chassis, setup);
  const st = steering.solve(0);
  const build = (side: Side): CornerStatic => {
    const stat = buildCornerStatic(front.chassis, front.corners[side], setup, side);
    const TRI = side === 'R' ? st.TRI_R : st.TRI_L;
    stat.trimTheta = thetaForWheel(stat, 0, TRI, stat.tieLen);
    const landed = fullWCz(stat, stat.trimTheta, TRI, stat.tieLen);
    if (Math.abs(landed - stat.rideTarget) > 0.01) {
      throw new AssemblyError(
        `${side}: ride trim failed — wheel lands at ${landed.toFixed(3)}" vs target ${stat.rideTarget.toFixed(3)}"`,
      );
    }
    stat.shockLenTrim = shockLenAt(stat, stat.trimTheta);
    const c = solveCorner(stat, stat.trimTheta, TRI, stat.tieLen, stat);
    stat.headAng0 = c.steerAng;
    stat.static = c;
    return stat;
  };
  return { statR: build('R'), statL: build('L'), steering };
}
