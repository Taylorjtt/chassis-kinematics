/*
 * Scan import: ASC parsing, point-cloud subsampling, and the alignment math
 * (ground plane -> z up, hubs -> axle/origin, front pick -> +x, unit scale).
 */
import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { Points } from 'three';
import { ChassisPicks, ScanManager, parseASC, subsample, UNIT_TO_INCHES } from '../src/ui/scan';

describe('parseASC', () => {
  it('parses xyz lines and skips junk', () => {
    const geo = parseASC('# header\n1 2 3\n4,5,6\n\nnot a point\n7 8 9\n');
    expect(geo.getAttribute('position').count).toBe(3);
    expect(geo.getAttribute('position').getY(1)).toBe(5);
  });
  it('picks up 0-255 colors and normalizes them', () => {
    const geo = parseASC('1 2 3 255 0 128\n4 5 6 0 255 0\n');
    const c = geo.getAttribute('color');
    expect(c.getX(0)).toBeCloseTo(1, 5);
    expect(c.getZ(0)).toBeCloseTo(128 / 255, 5);
  });
  it('throws on empty input', () => {
    expect(() => parseASC('# nothing\n')).toThrow(/no points/);
  });
});

describe('subsample', () => {
  it('caps huge point clouds at the budget', () => {
    const n = 10_000;
    const pos = new Float32Array(n * 3).map((_, i) => i);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    const out = subsample(geo, 2500);
    expect(out.getAttribute('position').count).toBeLessThanOrEqual(2500);
    expect(out.getAttribute('position').count).toBeGreaterThan(2000);
  });
});

describe('chassis-point alignment (drooped, wheels-off scan)', () => {
  // synthetic EinScan-style picks in mm. Car floats 500mm up on stands;
  // pivots match the app default geometry (x ±8", out 5", equal heights);
  // hub is at full droop (BELOW the pivot plane) and 2" forward of the
  // pivot-span midpoint to exercise the x-origin shift.
  const IN = 25.4;
  const picks = (): ChassisPicks => ({
    lf: new Vector3(8 * IN, -5 * IN, 500),
    lr: new Vector3(-8 * IN, -5 * IN, 500),
    rf: new Vector3(8 * IN, 5 * IN, 500),
    rr: new Vector3(-8 * IN, 5 * IN, 500),
    hub: new Vector3(2 * IN, 31 * IN, 500 - 6 * IN),
  });

  it('maps pivots to the entered ride height with the hub at x=0', () => {
    const scan = new ScanManager();
    const res = scan.applyChassisAlignment(picks(), {
      unitToInches: UNIT_TO_INCHES.mm, pivotHeightIn: 4.2,
    });
    expect(res.frontSpanIn).toBeCloseTo(10, 3);           // LF<->RF = 2 x 5"
    expect(res.pivots.lf).toEqual([6, -5, 4.2]);          // x: 8 - 2 (hub shift)
    expect(res.pivots.rr).toEqual([-10, 5, 4.2]);
    const hub = picks().hub.applyMatrix4(scan.group.matrix);
    expect(hub.x).toBeCloseTo(0, 3);                      // axle station
    expect(hub.y).toBeCloseTo(31, 3);
    expect(hub.z).toBeCloseTo(4.2 - 6, 3);                // droop preserved
  });

  it('undoes an arbitrary rigid transform of the scan (car on jack stands)', () => {
    const T = new Matrix4().makeRotationAxis(new Vector3(1, 2, 3).normalize(), 0.7)
      .setPosition(400, -900, 1234);
    const p = picks();
    const moved: ChassisPicks = {
      lf: p.lf.applyMatrix4(T), lr: p.lr.applyMatrix4(T),
      rf: p.rf.applyMatrix4(T), rr: p.rr.applyMatrix4(T),
      hub: p.hub.applyMatrix4(T),
    };
    const scan = new ScanManager();
    const res = scan.applyChassisAlignment(moved, {
      unitToInches: UNIT_TO_INCHES.mm, pivotHeightIn: 4.2,
    });
    expect(res.pivots.lf[0]).toBeCloseTo(6, 2);
    expect(res.pivots.lf[1]).toBeCloseTo(-5, 2);
    expect(res.pivots.lf[2]).toBeCloseTo(4.2, 2);
  });

  it('a known LF<->RF pivot distance overrides the unit preset', () => {
    const scan = new ScanManager();
    const res = scan.applyChassisAlignment(picks(), {
      actualFrontSpanIn: 10.5, pivotHeightIn: 4.2,
    });
    expect(res.frontSpanIn).toBeCloseTo(10.5, 6);
  });

  it('detects mirrored L/R picks (car would be upside down) and auto-corrects', () => {
    const scan = new ScanManager();
    // give the scan some "car mass" well above the pivots in scan coords
    scan.group.add(new Points(parseASC('0 0 1200\n100 100 1300\n-100 -100 1400\n')));
    const p = picks();
    const mirrored: ChassisPicks = { lf: p.rf, lr: p.rr, rf: p.lf, rr: p.lr, hub: p.hub };
    const res = scan.applyChassisAlignment(mirrored, {
      unitToInches: UNIT_TO_INCHES.mm, pivotHeightIn: 4.2,
    });
    expect(res.swappedLR).toBe(true);
    // output keyed by CAR side — identical to the correctly-labeled case
    expect(res.pivots.lf[0]).toBeCloseTo(6, 2);
    expect(res.pivots.lf[1]).toBeCloseTo(-5, 2);
    expect(res.pivots.rf[1]).toBeCloseTo(5, 2);
    // and the car mass ends up above the ground, not below it
    const c = scan.contentCenterWorld()!;
    expect(c.z).toBeGreaterThan(4.2);
  });

  it('does not second-guess correctly labeled picks', () => {
    const scan = new ScanManager();
    scan.group.add(new Points(parseASC('0 0 1200\n100 100 1300\n-100 -100 1400\n')));
    const res = scan.applyChassisAlignment(picks(), {
      unitToInches: UNIT_TO_INCHES.mm, pivotHeightIn: 4.2,
    });
    expect(res.swappedLR).toBe(false);
    expect(res.pivots.lf[1]).toBeCloseTo(-5, 2);
  });

  it('labeled picks make up/forward deterministic — no floor needed', () => {
    // rotate the whole scan upside-down-ish; labels still resolve the frame
    const T = new Matrix4().makeRotationAxis(new Vector3(1, 0, 0), Math.PI * 0.9);
    const p = picks();
    const moved: ChassisPicks = {
      lf: p.lf.applyMatrix4(T), lr: p.lr.applyMatrix4(T),
      rf: p.rf.applyMatrix4(T), rr: p.rr.applyMatrix4(T),
      hub: p.hub.applyMatrix4(T),
    };
    const scan = new ScanManager();
    const res = scan.applyChassisAlignment(moved, {
      unitToInches: UNIT_TO_INCHES.mm, pivotHeightIn: 4.2,
    });
    expect(res.pivots.lf[0]).toBeGreaterThan(0);          // front pivot forward
    expect(res.pivots.lf[1]).toBeCloseTo(-5, 2);          // left is left
    const hub = picks().hub.applyMatrix4(T).applyMatrix4(scan.group.matrix);
    expect(hub.z).toBeLessThan(4.2);                      // droop still below pivots
  });
});
