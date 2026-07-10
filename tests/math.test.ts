import { describe, expect, it } from 'vitest';
import { Quat, V, intersect2D, rotAboutAxis, solveRoot } from '../src/core/math';

describe('solveRoot', () => {
  it('finds a simple root by Newton', () => {
    expect(solveRoot((x) => x * x - 4, 1, 0, 10)).toBeCloseTo(2, 6);
  });
  it('falls back to bracket scan when the derivative dies', () => {
    // cos'(0) = 0 -> Newton bails immediately; scan must find pi/2
    expect(solveRoot(Math.cos, 0, 0, 4)).toBeCloseTo(Math.PI / 2, 5);
  });
  it('prefers the root nearest the warm start', () => {
    expect(solveRoot(Math.sin, 3, -7, 7)).toBeCloseTo(Math.PI, 5);
    expect(solveRoot(Math.sin, -3, -7, 7)).toBeCloseTo(-Math.PI, 5);
  });
});

describe('intersect2D', () => {
  it('intersects crossing lines', () => {
    const p = intersect2D([0, 0], [2, 2], [0, 2], [2, 0])!;
    expect(p[0]).toBeCloseTo(1, 9);
    expect(p[1]).toBeCloseTo(1, 9);
  });
  it('returns null for parallel lines', () => {
    expect(intersect2D([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull();
  });
});

describe('quaternions', () => {
  it('rotAboutAxis rotates x onto y about z by 90°', () => {
    const p = rotAboutAxis(V(1, 0, 0), V(0, 0, 0), V(0, 0, 1), Math.PI / 2);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(1, 9);
  });
  it('setFromUnitVectors maps from onto to', () => {
    const a = V(1, 2, 3).normalize(), b = V(-2, 0.5, 1).normalize();
    const q = new Quat().setFromUnitVectors(a, b);
    const r = a.clone().applyQuaternion(q);
    expect(r.distanceTo(b)).toBeLessThan(1e-9);
  });
  it('handles the antiparallel case', () => {
    const a = V(0, 0, 1);
    const q = new Quat().setFromUnitVectors(a, V(0, 0, -1));
    const r = a.clone().applyQuaternion(q);
    expect(r.z).toBeCloseTo(-1, 9);
  });
  it('multiply composes like THREE (this * q applies q first)', () => {
    const q1 = new Quat().setFromAxisAngle(V(0, 0, 1), Math.PI / 2);
    const q2 = new Quat().setFromAxisAngle(V(1, 0, 0), Math.PI / 2);
    // R = q1 * q2: rotate about x first, then about z
    const R = q1.clone().multiply(q2);
    const r = V(0, 1, 0).applyQuaternion(R); // x-rot: y->z ; z-rot: z stays
    expect(r.distanceTo(V(0, 0, 1))).toBeLessThan(1e-9);
  });
});
