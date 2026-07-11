/*
 * Metrics (spec §4): everything the racer reads off the model. All values
 * are OUTPUTS of the solved assembly. Ported from v4 metricsNow()/rollCenter
 * with track width added.
 */

import { DEG, RAD, Vec3, intersect2D } from './math';
import { CornerSolution, CornerStatic, SteeringState, solveCorner } from './assembly';
import { FrontAssembly, motionRatio, shockLenAt, thetaForShock, thetaForWheel } from './trim';

/** Toe angle (deg) -> inches across the toe gauge diameter (tape method). */
export const toeInches = (deg: number, gaugeDia: number) => gaugeDia * Math.tan(deg * DEG);
export const toeDegFromInches = (inch: number, gaugeDia: number) => Math.atan(inch / gaugeDia) * RAD;

export interface RollCenterResult {
  rc: [number, number] | null;   // [y, z] front view
  icR: [number, number] | null;  // per-side instant centers
  icL: [number, number] | null;
}

interface RcSideInput {
  lf: Vec3; lr: Vec3; uf: Vec3; ur: Vec3; LBJ: Vec3; UBJ: Vec3; CPy: number;
}

/** Front-view construction: arm planes -> instant centers -> RC (v4 port). */
export function rollCenter(R: RcSideInput, L: RcSideInput): RollCenterResult {
  const lmR: [number, number] = [(R.lf.y + R.lr.y) / 2, (R.lf.z + R.lr.z) / 2];
  const umR: [number, number] = [(R.uf.y + R.ur.y) / 2, (R.uf.z + R.ur.z) / 2];
  const lmL: [number, number] = [(L.lf.y + L.lr.y) / 2, (L.lf.z + L.lr.z) / 2];
  const umL: [number, number] = [(L.uf.y + L.ur.y) / 2, (L.uf.z + L.ur.z) / 2];
  const icR = intersect2D([R.LBJ.y, R.LBJ.z], lmR, [R.UBJ.y, R.UBJ.z], umR);
  const icL = intersect2D([L.LBJ.y, L.LBJ.z], lmL, [L.UBJ.y, L.UBJ.z], umL);
  if (!icR || !icL) return { rc: null, icR, icL };
  return { rc: intersect2D([R.CPy, 0], icR, [L.CPy, 0], icL), icR, icL };
}

function rcInput(stat: CornerStatic, c: CornerSolution): RcSideInput {
  return {
    lf: stat.lowerFront, lr: stat.lowerRear,
    uf: stat.upperFront, ur: stat.upperRear,
    LBJ: c.LBJ, UBJ: c.UBJ, CPy: c.CPy,
  };
}

export type TravelMode = 'wheel' | 'shock';

export interface MotionInputs {
  travL: number;      // wheel or shock travel per mode (compression +)
  travR: number;
  steerDeg: number;   // pitman arm angle
  mode: TravelMode;
}

export interface FrontState {
  cR: CornerSolution; cL: CornerSolution;
  st: SteeringState;
  rc: RollCenterResult;
  wtR: number; wtL: number;     // wheel travel from ride
  stkR: number; stkL: number;   // shock travel (compression +)
  mrR: number; mrL: number;     // motion ratios
  steerR: number; steerL: number;  // road steer from static heading
  steerA: number;
  ack: number | null;           // Ackermann %
  tot: number | null;           // toe-out on turns, deg
  trackWidth: number;           // WC_R.y - WC_L.y
}

export function solveFrontState(fa: FrontAssembly, wheelbase: number, inp: MotionInputs): FrontState {
  const { statR, statL } = fa;
  const st = fa.steering.solve(inp.steerDeg);
  const thR = inp.mode === 'wheel'
    ? thetaForWheel(statR, inp.travR, st.TRI_R, statR.tieLen)
    : thetaForShock(statR, inp.travR, st.TRI_R, statR.tieLen);
  const thL = inp.mode === 'wheel'
    ? thetaForWheel(statL, inp.travL, st.TRI_L, statL.tieLen)
    : thetaForShock(statL, inp.travL, st.TRI_L, statL.tieLen);
  const cR = solveCorner(statR, thR, st.TRI_R, statR.tieLen, statR);
  const cL = solveCorner(statL, thL, st.TRI_L, statL.tieLen, statL);
  const wtR = cR.WC.z - statR.rideTarget, wtL = cL.WC.z - statL.rideTarget;
  const stkR = statR.shockLenTrim - shockLenAt(statR, thR);
  const stkL = statL.shockLenTrim - shockLenAt(statL, thL);
  const mrR = motionRatio(statR, thR), mrL = motionRatio(statL, thL);
  const rc = rollCenter(rcInput(statR, cR), rcInput(statL, cL));
  const steerR = cR.steerAng - statR.headAng0, steerL = cL.steerAng - statL.headAng0;
  let ack: number | null = null, tot: number | null = null;
  if (Math.abs(inp.steerDeg) > 3) {
    const dR = Math.abs(steerR), dL = Math.abs(steerL);
    const din = Math.max(dR, dL), dout = Math.min(dR, dL);
    const track = statR.WC0.y - statL.WC0.y;
    const ideal = track / wheelbase;
    const actual = 1 / Math.tan(dout * DEG) - 1 / Math.tan(din * DEG);
    if (isFinite(actual) && Math.abs(ideal) > 1e-6) ack = (actual / ideal) * 100;
    tot = din - dout;
  }
  return {
    cR, cL, st, rc, wtR, wtL, stkR, stkL, mrR, mrL,
    steerR, steerL, steerA: inp.steerDeg, ack, tot,
    trackWidth: cR.WC.y - cL.WC.y,
  };
}

/* ============================================================ SWEEP
 * Camber / toe / RC height vs wheel travel, for charts + camber gain.
 */
export interface SweepData {
  trav: number[];
  cambR: number[]; cambL: number[];
  toeR: number[]; toeL: number[];
  castR: number[]; castL: number[];
  rcz: number[];
}

export function computeSweep(fa: FrontAssembly, lo = -4, hi = 4, N = 49): SweepData {
  const { statR, statL } = fa;
  const st = fa.steering.solve(0);
  const trav: number[] = [], cambR: number[] = [], cambL: number[] = [];
  const toeR: number[] = [], toeL: number[] = [], rcz: number[] = [];
  const castR: number[] = [], castL: number[] = [];
  const wr = { phi: 0, psi: 0 }, wl = { phi: 0, psi: 0 };
  for (let i = 0; i < N; i++) {
    const t = lo + ((hi - lo) * i) / (N - 1);
    trav.push(t);
    const thR = thetaForWheel(statR, t, st.TRI_R, statR.tieLen);
    const thL = thetaForWheel(statL, t, st.TRI_L, statL.tieLen);
    const cR = solveCorner(statR, thR, st.TRI_R, statR.tieLen, wr);
    const cL = solveCorner(statL, thL, st.TRI_L, statL.tieLen, wl);
    cambR.push(cR.camber); cambL.push(cL.camber);
    toeR.push(cR.toe); toeL.push(cL.toe);
    castR.push(cR.casterLive); castL.push(cL.casterLive);
    const rc = rollCenter(rcInput(statR, cR), rcInput(statL, cL));
    rcz.push(rc.rc ? rc.rc[1] : NaN);
  }
  return { trav, cambR, cambL, toeR, toeL, castR, castL, rcz };
}

/** Local slope of a sweep series at wheel travel wt (v4 gainAt). */
export function gainAt(sweep: SweepData, series: number[], wt: number): number {
  const tv = sweep.trav;
  let i = 1;
  while (i < tv.length - 1 && tv[i] < wt) i++;
  return (series[i] - series[i - 1]) / (tv[i] - tv[i - 1]);
}
