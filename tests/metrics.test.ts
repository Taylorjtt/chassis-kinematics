/*
 * Metric invariants (spec §7): bump camber, motion ratio, roll center,
 * Ackermann / toe-out-on-turns, toe conversions, sweeps.
 */
import { describe, expect, it } from 'vitest';
import { rig } from './helpers';
import { computeSweep, gainAt, toeDegFromInches, toeInches } from '../src/core/metrics';

describe('bump behavior', () => {
  const r = rig();
  it('camber goes more negative in bump on both sides', () => {
    const s0 = r.solve();
    const s2 = r.solve({ travL: 2, travR: 2 });
    expect(s2.cR.camber).toBeLessThan(s0.cR.camber);
    expect(s2.cL.camber).toBeLessThan(s0.cL.camber);
  });
  it('camber gain (local slope at ride) is negative', () => {
    const sweep = computeSweep(r.fa);
    expect(gainAt(sweep, sweep.cambR, 0)).toBeLessThan(0);
    expect(gainAt(sweep, sweep.cambL, 0)).toBeLessThan(0);
  });
  it('motion ratio is physical: dShock/dWheel in (0.3, 1.2)', () => {
    for (const t of [-2, 0, 2]) {
      const s = r.solve({ travL: t, travR: t });
      expect(s.mrR).toBeGreaterThan(0.3);
      expect(s.mrR).toBeLessThan(1.2);
      expect(s.mrL).toBeGreaterThan(0.3);
      expect(s.mrL).toBeLessThan(1.2);
    }
  });
});

describe('roll center', () => {
  const r = rig();
  it('exists near the centerline at rest', () => {
    const s = r.solve();
    expect(s.rc.rc).not.toBeNull();
    expect(Math.abs(s.rc.rc![0])).toBeLessThan(2);
    expect(s.rc.rc![1]).toBeGreaterThan(-5);
    expect(s.rc.rc![1]).toBeLessThan(15);
  });
  it('migrates laterally in roll', () => {
    const s = r.solve({ travL: -2, travR: 2 });
    expect(s.rc.rc).not.toBeNull();
    expect(Math.abs(s.rc.rc![0])).toBeGreaterThan(0.5);
  });
  it('both instant centers exist at rest', () => {
    const s = r.solve();
    expect(s.rc.icR).not.toBeNull();
    expect(s.rc.icL).not.toBeNull();
  });
});

describe('steering metrics', () => {
  const r = rig();
  it('Ackermann % and toe-out-on-turns are produced past 3° steer', () => {
    const s = r.solve({ steerDeg: 15 });
    expect(s.ack).not.toBeNull();
    expect(isFinite(s.ack!)).toBe(true);
    expect(s.tot).not.toBeNull();
    expect(s.tot!).toBeGreaterThanOrEqual(0);
  });
  it('road steer moves both wheels the same direction', () => {
    const s = r.solve({ steerDeg: 12 });
    expect(Math.sign(s.steerR)).toBe(Math.sign(s.steerL));
    expect(Math.abs(s.steerR)).toBeGreaterThan(2);
  });
  it('steer-camber coupling ≈ sin(caster)·steer, opposite signs L/R (real physics)', () => {
    const s0 = r.solve();
    const s = r.solve({ steerDeg: 12 });
    const dR = s.cR.camber - s0.cR.camber;
    const dL = s.cL.camber - s0.cL.camber;
    expect(Math.sign(dR)).not.toBe(Math.sign(dL));
    // caster ≈ 10.1°, road steer ≈ several deg -> coupling well over noise
    expect(Math.abs(dR)).toBeGreaterThan(0.3);
    expect(Math.abs(dR)).toBeLessThan(4);
  });
});

describe('toe reporting (tape method across gauge diameter)', () => {
  it('inches <-> degrees are inverse', () => {
    expect(toeInches(toeDegFromInches(0.125, 22), 22)).toBeCloseTo(0.125, 9);
  });
  it('scales with gauge diameter', () => {
    expect(toeInches(1, 44)).toBeCloseTo(2 * toeInches(1, 22), 9);
  });
});

describe('sweep data', () => {
  it('covers the travel range with finite alignment values', () => {
    const r = rig();
    const sweep = computeSweep(r.fa);
    expect(sweep.trav[0]).toBe(-4);
    expect(sweep.trav[sweep.trav.length - 1]).toBe(4);
    expect(sweep.cambR.every(isFinite)).toBe(true);
    expect(sweep.toeL.every(isFinite)).toBe(true);
  });
});
