/*
 * Adjustment directionality (spec §7): every shop move must push the
 * alignment the way it does on the real car, with ride re-trimmed.
 */
import { describe, expect, it } from 'vitest';
import { rig } from './helpers';
import { effectiveLegLength, effectiveTieRodLength } from '../src/core/parts';
import { toeInches } from '../src/core/metrics';

const base = rig();
const camR0 = base.fa.statR.static!.camber;
const toeR0 = base.fa.statR.static!.toe;
const castR0 = base.fa.statR.static!.casterLive;

describe('heim-turn adjustments (entered in turns, spec §2)', () => {
  it('turns convert to inches through the thread pitch (3/4"-16 hardware)', () => {
    const leg = { baseLength: 14, heimPitchTPI: 16 };
    expect(effectiveLegLength(leg, 8)).toBeCloseTo(14.5, 9);        // heim: 1/16" per turn
    // LH/RH sleeve moves both ends: 2/16 = 0.125" per turn
    expect(effectiveTieRodLength({ kind: 'tieRod', id: 't', name: 't', baseLength: 12, sleevePitchTPI: 16 }, -4))
      .toBeCloseTo(11.5, 9);
    expect(effectiveTieRodLength({ kind: 'tieRod', id: 't', name: 't', baseLength: 12, sleevePitchTPI: 16, endsThreaded: 1 }, -4))
      .toBeCloseTo(11.75, 9);
  });

  it('both upper legs longer -> camber more positive; other side untouched', () => {
    const r = rig((_, setup) => {
      setup.corners.R.heimTurnsFront = 4;
      setup.corners.R.heimTurnsRear = 4;
    });
    expect(r.fa.statR.static!.camber).toBeGreaterThan(camR0 + 0.1);
    expect(r.fa.statL.static!.camber).toBeCloseTo(base.fa.statL.static!.camber, 6);
  });

  it('front-vs-rear heim split changes caster with small camber cross-talk', () => {
    const r = rig((_, setup) => {
      setup.corners.R.heimTurnsFront = 4;
      setup.corners.R.heimTurnsRear = -4;
    });
    const dCaster = r.fa.statR.static!.casterLive - castR0;
    const dCamber = r.fa.statR.static!.camber - camR0;
    expect(Math.abs(dCaster)).toBeGreaterThan(0.3);
    expect(Math.abs(dCamber)).toBeLessThan(Math.abs(dCaster) * 0.5);
  });

  it('ride is re-trimmed after the wrench turns (jack bolt)', () => {
    const r = rig((_, setup) => { setup.corners.R.heimTurnsFront = 6; setup.corners.R.heimTurnsRear = 6; });
    const s = r.solve();
    expect(Math.abs(s.cR.WC.z - r.fa.statR.rideTarget)).toBeLessThan(0.001);
  });
});

describe('lower arm (part swap — stock arms are not adjustable)', () => {
  it('longer lower arm -> camber more negative, track wider, ride re-trimmed', () => {
    // 0.25" more arm nets less than 0.25" of track: the kingpin tilts and
    // pulls the wheel center back inboard — real geometry, don't over-expect
    const r = rig((front) => { front.corners.R.lowerArm.length += 0.25; });
    expect(r.fa.statR.static!.camber).toBeLessThan(camR0 - 0.1);
    expect(r.solve().trackWidth).toBeGreaterThan(base.solve().trackWidth + 0.05);
    expect(Math.abs(r.solve().cR.WC.z - r.fa.statR.rideTarget)).toBeLessThan(0.001);
  });
});

describe('tie rod turns', () => {
  it('move toe with camber coupling ≈ sin(caster)·steer (real physics — kept)', () => {
    const r = rig((_, setup) => { setup.corners.R.tieRodTurns = 4; });
    const dToeIn = toeInches(r.fa.statR.static!.toe, 22) - toeInches(toeR0, 22);
    const dToeDeg = r.fa.statR.static!.toe - toeR0;
    const dCamber = r.fa.statR.static!.camber - camR0;
    expect(Math.abs(dToeIn)).toBeGreaterThan(0.05);
    const expected = Math.abs(Math.sin(castR0 * Math.PI / 180) * dToeDeg);
    expect(Math.abs(dCamber)).toBeGreaterThan(expected * 0.5);
    expect(Math.abs(dCamber)).toBeLessThan(expected * 1.5);
  });
  it('direction flips with sign', () => {
    const plus = rig((_, s) => { s.corners.R.tieRodTurns = 4; }).fa.statR.static!.toe;
    const minus = rig((_, s) => { s.corners.R.tieRodTurns = -4; }).fa.statR.static!.toe;
    expect(Math.sign(plus - toeR0)).not.toBe(Math.sign(minus - toeR0));
  });
});

describe('slug / shim moves on slotted chassis mounts', () => {
  it('upper slugs toward the wheel -> camber more positive', () => {
    const r = rig((_, setup) => { setup.corners.R.slugs.uio = 0.25; });
    expect(r.fa.statR.static!.camber).toBeGreaterThan(camR0 + 0.2);
  });
  it('caster-split slug changes caster', () => {
    const r = rig((_, setup) => { setup.corners.R.slugs.ucs = 0.25; });
    expect(Math.abs(r.fa.statR.static!.casterLive - castR0)).toBeGreaterThan(0.2);
  });
  it('lower pivots up re-trims and changes camber', () => {
    const r = rig((_, setup) => { setup.corners.R.slugs.lud = 0.3; });
    const s = r.solve();
    expect(Math.abs(s.cR.WC.z - r.fa.statR.rideTarget)).toBeLessThan(0.001);
    expect(Math.abs(r.fa.statR.static!.camber - camR0)).toBeGreaterThan(0.02);
  });
});

describe('frame raise (setup pose, not a part change)', () => {
  it('raising the frame droops the suspension and changes camber', () => {
    const r = rig((_, setup) => { setup.frameRaise = 1.0; });
    const s = r.solve();
    // wheel still on the ground at its target height
    expect(Math.abs(s.cR.WC.z - r.fa.statR.rideTarget)).toBeLessThan(0.001);
    expect(Math.abs(r.fa.statR.static!.camber - camR0)).toBeGreaterThan(0.05);
  });
});
