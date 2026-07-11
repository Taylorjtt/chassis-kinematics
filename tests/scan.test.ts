/*
 * Scan import: ASC parsing, point-cloud subsampling, and the alignment math
 * (ground plane -> z up, hubs -> axle/origin, front pick -> +x, unit scale).
 */
import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { ScanManager, parseASC, subsample, UNIT_TO_INCHES } from '../src/ui/scan';

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

describe('alignment math', () => {
  // synthetic EinScan-style picks in mm: floor on z=0, hubs 254mm up,
  // 787.4mm out each side (62" track), front of car toward +x
  const picks = () => ({
    ground: [new Vector3(0, 0, 0), new Vector3(1000, 0, 0), new Vector3(0, 1000, 0)],
    hubL: new Vector3(500, -787.4, 254),
    hubR: new Vector3(500, 787.4, 254),
    front: new Vector3(2500, 0, 300),
  });

  it('maps hubs to ±31" out, 10" up, origin at axle center on the ground', () => {
    const scan = new ScanManager();
    const res = scan.applyAlignment(picks(), { unitToInches: UNIT_TO_INCHES.mm });
    expect(res.hubDistIn).toBeCloseTo(62, 1);
    const hubL = picks().hubL.applyMatrix4(scan.group.matrix);
    expect(hubL.x).toBeCloseTo(0, 3);
    expect(hubL.y).toBeCloseTo(-31, 2);
    expect(hubL.z).toBeCloseTo(10, 2);
  });

  it('undoes an arbitrary rigid transform of the scan', () => {
    const T = new Matrix4().makeRotationAxis(new Vector3(1, 2, 3).normalize(), 0.7)
      .setPosition(400, -900, 1234);
    const p = picks();
    const moved = {
      ground: p.ground.map((g) => g.applyMatrix4(T)),
      hubL: p.hubL.applyMatrix4(T), hubR: p.hubR.applyMatrix4(T),
      front: p.front.applyMatrix4(T),
    };
    const scan = new ScanManager();
    scan.applyAlignment(moved, { unitToInches: UNIT_TO_INCHES.mm });
    const hubR = picks().hubR.applyMatrix4(T).applyMatrix4(scan.group.matrix);
    expect(hubR.x).toBeCloseTo(0, 2);
    expect(hubR.y).toBeCloseTo(31, 2);
    expect(hubR.z).toBeCloseTo(10, 2);
  });

  it('a known hub-to-hub distance overrides the unit preset', () => {
    const scan = new ScanManager();
    const res = scan.applyAlignment(picks(), { actualHubDistIn: 61.5 });
    expect(res.hubDistIn).toBeCloseTo(61.5, 6);
  });

  it('front pick fixes forward even if the hubs were picked swapped', () => {
    const p = picks();
    const swapped = { ...p, hubL: p.hubR, hubR: p.hubL };
    const scan = new ScanManager();
    scan.applyAlignment(swapped, { unitToInches: UNIT_TO_INCHES.mm });
    const front = picks().front.applyMatrix4(scan.group.matrix);
    expect(front.x).toBeGreaterThan(0);   // forward stays forward
  });
});
