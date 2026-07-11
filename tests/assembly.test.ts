/*
 * Assembly invariants (spec §7): calibration fidelity, round trips,
 * symmetry, sign regressions, part rigidity.
 */
import { describe, expect, it } from 'vitest';
import { rig } from './helpers';
import { toeInches } from '../src/core/metrics';
import { fullWCz, shockLenAt, thetaForWheel } from '../src/core/trim';
import { AssemblyError } from '../src/core/assembly';
import { assembleFront } from '../src/core/trim';
import { defaultState } from '../src/state/setup';

describe('static alignment = calibration inputs (outputs, not inputs)', () => {
  const r = rig();
  it('camber matches the measured calibration value on both sides', () => {
    expect(r.fa.statR.static!.camber).toBeCloseTo(-1.0, 2);
    expect(r.fa.statL.static!.camber).toBeCloseTo(-1.0, 2);
  });
  it('LEFT camber sign regression: left reports -1.0, not +1.0', () => {
    // v4 had a left-camber sign bug; this must never come back
    expect(r.fa.statL.static!.camber).toBeLessThan(0);
    expect(Math.abs(r.fa.statL.static!.camber - r.fa.statR.static!.camber)).toBeLessThan(0.02);
  });
  it('toe matches measured (0.000") on both sides', () => {
    expect(toeInches(r.fa.statR.static!.toe, r.setup.toeGaugeDia)).toBeCloseTo(0, 3);
    expect(toeInches(r.fa.statL.static!.toe, r.setup.toeGaugeDia)).toBeCloseTo(0, 3);
  });
  it('trim θ ≈ 0 at baseline', () => {
    expect(Math.abs(r.fa.statR.trimTheta)).toBeLessThan(0.01);
    expect(Math.abs(r.fa.statL.trimTheta)).toBeLessThan(0.01);
  });
  it('caster/KPI from the default geometry ≈ 10.1° both sides', () => {
    // LBJ [1,24.5,3.8] -> UBJ [-1,22.5,15]: atan2(2, 11.2) = 10.12°
    expect(r.fa.statR.static!.casterLive).toBeCloseTo(10.12, 1);
    expect(r.fa.statL.static!.casterLive).toBeCloseTo(10.12, 1);
    expect(r.fa.statR.static!.kpiLive).toBeCloseTo(10.12, 1);
    expect(r.fa.statL.static!.kpiLive).toBeCloseTo(10.12, 1);
  });
});

describe('L/R symmetry with symmetric parts', () => {
  const r = rig();
  const s = r.solve();
  it('camber symmetric', () => expect(s.cL.camber).toBeCloseTo(s.cR.camber, 3));
  it('toe symmetric', () => expect(s.cL.toe).toBeCloseTo(s.cR.toe, 3));
  it('caster symmetric', () => expect(s.cL.casterLive).toBeCloseTo(s.cR.casterLive, 3));
  it('scrub symmetric', () => expect(s.cL.scrub).toBeCloseTo(s.cR.scrub, 3));
  it('track width ≈ 62" (WC y ±31)', () => expect(s.trackWidth).toBeCloseTo(62, 1));
  it('bump behavior symmetric', () => {
    const b = r.solve({ travL: 2, travR: 2 });
    expect(b.cL.camber).toBeCloseTo(b.cR.camber, 3);
    expect(b.cL.toe).toBeCloseTo(b.cR.toe, 3);
  });
});

describe('travel round trips', () => {
  it('wheel travel round-trips < 0.01"', () => {
    const r = rig();
    for (const t of [-2.5, -1, 0.5, 1.5, 3]) {
      const s = r.solve({ travR: t, travL: -t / 2 });
      expect(Math.abs(s.wtR - t)).toBeLessThan(0.01);
      expect(Math.abs(s.wtL - -t / 2)).toBeLessThan(0.01);
    }
  });
  it('shock travel round-trips < 0.01"', () => {
    const r = rig();
    for (const t of [-1, 0.4, 1.2]) {
      const s = r.solve({ travR: t, travL: t, mode: 'shock' });
      expect(Math.abs(s.stkR - t)).toBeLessThan(0.01);
      expect(Math.abs(s.stkL - t)).toBeLessThan(0.01);
    }
  });
  it('full-chain ride trim (ψ included) lands < 0.001"', () => {
    const r = rig((_, setup) => { setup.corners.R.tieRodTurns = 3; });
    const st = r.fa.steering.solve(0);
    const z = fullWCz(r.fa.statR, r.fa.statR.trimTheta, st.TRI_R, r.fa.statR.tieLen);
    expect(Math.abs(z - r.fa.statR.rideTarget)).toBeLessThan(0.001);
  });
});

describe('part rigidity under motion + adjustment (< 0.02")', () => {
  const r = rig((_, setup) => {
    setup.corners.R.slugs.uio = 0.2;
    setup.corners.R.slugs.ucs = 0.1;
    setup.corners.R.heimTurnsFront = 2;
  });
  it('spindle height preserved through travel and steer', () => {
    for (const inp of [{ travR: 3, travL: -3 }, { steerDeg: 18 }, { travR: -2, steerDeg: -12 }]) {
      const s = r.solve(inp);
      expect(Math.abs(s.cR.UBJ.distanceTo(s.cR.LBJ) - r.fa.statR.uprLen)).toBeLessThan(0.02);
      expect(Math.abs(s.cL.UBJ.distanceTo(s.cL.LBJ) - r.fa.statL.uprLen)).toBeLessThan(0.02);
    }
  });
  it('lower arm swing radius preserved', () => {
    const stat = r.fa.statR;
    const expected = stat.attLBJ.r0.length();
    for (const t of [-3, 0, 3]) {
      const s = r.solve({ travR: t });
      const u = stat.lowArm.dir;
      const rel = s.cR.LBJ.clone().sub(stat.lowArm.pf);
      const axial = rel.dot(u);
      const radial = rel.clone().sub(u.clone().multiplyScalar(axial)).length();
      expect(Math.abs(radial - expected)).toBeLessThan(0.02);
      expect(Math.abs(axial - stat.attLBJ.a0)).toBeLessThan(0.02);
    }
  });
  it('tie rod holds its physical length', () => {
    const s = r.solve({ travR: 2, steerDeg: 10 });
    expect(Math.abs(s.cR.TRO.distanceTo(s.cR.TRI) - r.fa.statR.tieLen)).toBeLessThan(0.001);
  });
});

describe('assembly failure modes', () => {
  it('throws when the upper legs cannot triangulate the pickup span', () => {
    const { front, setup } = defaultState();
    front.corners.R.upperArm.legFront.baseLength = 5;
    front.corners.R.upperArm.legRear.baseLength = 5; // pickups are 12" apart
    expect(() => assembleFront(front, setup)).toThrow(AssemblyError);
  });
  it('flags arm-fixable failures with the side, so the UI can offer the heim fix', () => {
    const { front, setup } = defaultState();
    front.corners.L.spindle.height = 30;   // way beyond the arms' reach
    try {
      assembleFront(front, setup);
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as AssemblyError;
      expect(err).toBeInstanceOf(AssemblyError);
      expect(err.side).toBe('L');
      expect(err.armFixable).toBe(true);
    }
  });
});

describe('trim helpers', () => {
  it('thetaForWheel hits requested offsets through the full chain', () => {
    const r = rig();
    const st = r.fa.steering.solve(0);
    for (const dz of [-2, 1, 2.5]) {
      const th = thetaForWheel(r.fa.statR, dz, st.TRI_R, r.fa.statR.tieLen);
      expect(Math.abs(fullWCz(r.fa.statR, th, st.TRI_R, r.fa.statR.tieLen) - (r.fa.statR.rideTarget + dz))).toBeLessThan(0.001);
    }
  });
  it('shock compresses in bump (positive = compression)', () => {
    const r = rig();
    const st = r.fa.steering.solve(0);
    const thUp = thetaForWheel(r.fa.statR, 2, st.TRI_R, r.fa.statR.tieLen);
    expect(shockLenAt(r.fa.statR, thUp)).toBeLessThan(r.fa.statR.shockLenTrim);
  });
});
