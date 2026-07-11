/*
 * State: v4 importer, save/load round trip, spindle calibration flow (§5).
 */
import { describe, expect, it } from 'vitest';
import {
  V4_DEFAULT, armPickLengths, defaultState, importV4, loadStateJSON, mirrorV4Corner, serializeState,
} from '../src/state/setup';
import { Va, rotAboutAxis } from '../src/core/math';
import { assembleFront } from '../src/core/trim';
import { calibrateSpindle } from '../src/core/calibrate';
import { toeInches } from '../src/core/metrics';

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

describe('v4 importer', () => {
  it('reproduces the measured v4 alignment exactly', () => {
    const { front, setup } = importV4(clone(V4_DEFAULT));
    const fa = assembleFront(front, setup);
    expect(fa.statR.static!.camber).toBeCloseTo(-1.0, 2);
    expect(fa.statL.static!.camber).toBeCloseTo(-1.0, 2);
    expect(toeInches(fa.statR.static!.toe, setup.toeGaugeDia)).toBeCloseTo(0, 3);
  });

  it('derives sensible part specs from the tape measurements', () => {
    const { front } = importV4(clone(V4_DEFAULT));
    const la = front.corners.R.lowerArm;
    expect(la.length).toBeCloseTo(19.504, 2);   // pivot axis -> LBJ radius
    expect(la.bjAxial).toBeCloseTo(7, 3);
    expect(la.bjDrop).toBeCloseTo(0.4, 2);
    const ua = front.corners.R.upperArm;
    expect(ua.legFront.baseLength).toBeCloseTo(Math.sqrt(206.25), 3); // |UBJ-uf|
    expect(ua.legRear.baseLength).toBeCloseTo(Math.sqrt(182.25), 3);
    expect(front.corners.R.spindle.height).toBeCloseTo(Math.sqrt(4 + 4 + 125.44), 3);
  });

  it('stores side-symmetric spindle locals: mirrored car -> identical part cards', () => {
    const { front } = importV4(clone(V4_DEFAULT));
    const pR = front.corners.R.spindle.calibrated!;
    const pL = front.corners.L.spindle.calibrated!;
    for (let i = 0; i < 3; i++) {
      expect(pL.pinDir![i]).toBeCloseTo(pR.pinDir![i], 6);
      expect(pL.wcLocal![i]).toBeCloseTo(pR.wcLocal![i], 6);
      expect(pL.troLocal![i]).toBeCloseTo(pR.troLocal![i], 6);
    }
  });

  it('folds v4 length adjustments (lal/ual/tie) into the parts', () => {
    // v4's "R" corner is the +y corner = the app's LEFT (driver) side
    const hp = clone(V4_DEFAULT);
    hp.R.adj = { uio: 0, uud: 0, ucs: 0, lio: 0, lud: 0, tie: 0.1, lal: 0.25, ual: -0.2 };
    const { front, setup } = importV4(hp);
    const base = importV4(clone(V4_DEFAULT)).front;
    expect(front.corners.L.lowerArm.length).toBeCloseTo(base.corners.L.lowerArm.length + 0.25, 2);
    expect(front.corners.L.tieRod.baseLength).toBeCloseTo(base.corners.L.tieRod.baseLength + 0.1, 6);
    expect(front.corners.L.upperArm.legFront.baseLength)
      .toBeLessThan(base.corners.L.upperArm.legFront.baseLength);
    expect(() => assembleFront(front, setup)).not.toThrow();
  });

  it('imports v4 slug/shim moves as setup, and they still assemble', () => {
    const hp = clone(V4_DEFAULT);
    hp.R.adj = { uio: 0.15, uud: -0.1, ucs: 0.05, lio: 0, lud: 0, tie: 0, lal: 0, ual: 0 };
    const { front, setup } = importV4(hp);
    expect(setup.corners.L.slugs.uio).toBe(0.15);   // v4 "R" = app LEFT
    const fa = assembleFront(front, setup);
    // moves came from a car measured at -1.0° camber; slugs move it away
    expect(fa.statL.static!.camber).not.toBeCloseTo(-1.0, 1);
  });
});

describe('save / load', () => {
  it('native save file round-trips to identical alignment', () => {
    const { front, setup } = defaultState();
    setup.corners.R.heimTurnsFront = 3;
    setup.corners.R.tieRodTurns = -2;
    const a = assembleFront(front, setup);
    const loaded = loadStateJSON(serializeState(front, setup, { mode: 'wheel' }));
    const b = assembleFront(loaded.front, loaded.setup);
    expect(b.statR.static!.camber).toBeCloseTo(a.statR.static!.camber, 9);
    expect(b.statR.static!.toe).toBeCloseTo(a.statR.static!.toe, 9);
    expect(loaded.ui).toEqual({ mode: 'wheel' });
  });

  it('migrates v1 saves: side labels swap, coordinates stay (+y = LEFT now)', () => {
    const { front, setup } = defaultState();
    // fabricate a genuine v1 file: same physical car, but the +y side is
    // labeled "R" (the old, pre-driver-perspective labeling)
    const old = JSON.parse(serializeState(front, setup));
    old.version = 1;
    old.front.chassis.sides = { R: front.chassis.sides.L, L: front.chassis.sides.R };
    old.front.corners = { R: front.corners.L, L: front.corners.R };
    old.setup.corners = { R: setup.corners.L, L: setup.corners.R };
    old.setup.measured = { R: setup.measured.L, L: setup.measured.R };
    const loaded = loadStateJSON(JSON.stringify(old));
    // after migration the labels are back to driver-perspective truth
    expect(loaded.front.chassis.sides.L).toEqual(front.chassis.sides.L);
    expect(loaded.front.chassis.sides.R).toEqual(front.chassis.sides.R);
    const fa = assembleFront(loaded.front, loaded.setup);
    expect(fa.statL.static!.camber).toBeCloseTo(-1.0, 2);
  });

  it('reads a v4 setup file (HP wrapper form)', () => {
    const v4file = { app: 'sla-suspension-sim', version: 4, HP: clone(V4_DEFAULT), ui: { steer: 5 } };
    const loaded = loadStateJSON(JSON.stringify(v4file));
    const fa = assembleFront(loaded.front, loaded.setup);
    expect(fa.statR.static!.camber).toBeCloseTo(-1.0, 2);
    expect(loaded.ui).toEqual({ steer: 5 });
  });

  it('reads a bare v4 HP object', () => {
    const loaded = loadStateJSON(JSON.stringify(clone(V4_DEFAULT)));
    expect(() => assembleFront(loaded.front, loaded.setup)).not.toThrow();
  });

  it('rejects junk', () => {
    expect(() => loadStateJSON('{"hello":"world"}')).toThrow(/Unrecognized/);
  });
});

describe('spindle calibration fallback (§5)', () => {
  it('back-solves the pin from measured camber/toe via the part-card positions', () => {
    const { front, setup } = defaultState();
    // wipe the imported calibration; keep tape-measurable pin POSITIONS on the card
    front.corners.R.spindle.calibrated = undefined;
    front.corners.R.spindle.pin = {
      heightAboveLBJ: 6.0, inclinationDeg: 0, sweepDeg: 0, snoutLength: 7.7,
    };
    const spindle = calibrateSpindle(front, setup, 'R', -1.0, 0.0);
    front.corners.R.spindle = spindle;
    const fa = assembleFront(front, setup);
    expect(fa.statR.static!.camber).toBeCloseTo(-1.0, 2);
    expect(toeInches(fa.statR.static!.toe, setup.toeGaugeDia)).toBeCloseTo(0, 3);
    expect(spindle.calibrated!.pinDir).toBeDefined();
  });

  it('re-calibrating an already-calibrated spindle to new targets hits them', () => {
    const { front, setup } = defaultState();
    front.corners.L.spindle = calibrateSpindle(front, setup, 'L', -2.5, 0.0625);
    const fa = assembleFront(front, setup);
    expect(fa.statL.static!.camber).toBeCloseTo(-2.5, 2);
    expect(toeInches(fa.statL.static!.toe, setup.toeGaugeDia)).toBeCloseTo(0.0625, 3);
  });

  it('left-side calibration keeps the left camber sign (regression)', () => {
    const { front, setup } = defaultState();
    front.corners.L.spindle = calibrateSpindle(front, setup, 'L', -3.0, 0);
    const fa = assembleFront(front, setup);
    expect(fa.statL.static!.camber).toBeCloseTo(-3.0, 2);
    expect(fa.statL.static!.camber).toBeLessThan(0);
  });
});

describe('armPickLengths (scan pick on the arm, any droop)', () => {
  it('recovers the part spec from a fully drooped LBJ pick', () => {
    const { front } = defaultState();
    const cs = front.chassis.sides.L;      // +y side (v4 default "R" data)
    const la = front.corners.L.lowerArm;   // imported: axial 7, radial 19.5, drop 0.4
    // reconstruct the ride-height LBJ, then droop the arm 28° about its pivot axis
    const pf = Va(cs.lowerFront), pr = Va(cs.lowerRear);
    const u = pr.clone().sub(pf).normalize();
    const atRide = Va([1.0, 24.5, 3.8]);
    const drooped = rotAboutAxis(atRide, pf, u, 28 * Math.PI / 180);
    const got = armPickLengths(cs, drooped.toArray(), la.bjDrop);
    expect(got.axial).toBeCloseTo(la.bjAxial, 3);
    expect(got.radial).toBeCloseTo(la.length, 3);
  });
  it('is exact at ride height too', () => {
    const { front } = defaultState();
    const got = armPickLengths(front.chassis.sides.L, [1.0, 24.5, 3.8], 0.4);
    expect(got.axial).toBeCloseTo(7, 3);
    expect(got.radial).toBeCloseTo(19.5, 3);
  });
});

describe('scan-measured spindle (hubFaceLocal path)', () => {
  it('hub face + zero wheel offset reproduces the wheel center exactly', () => {
    const { front, setup } = defaultState();
    const sp = front.corners.R.spindle;
    const cal = sp.calibrated!;
    front.corners.R.spindle = {
      ...sp,
      calibrated: { pinDir: cal.pinDir, troLocal: cal.troLocal, hubFaceLocal: cal.wcLocal },
    };
    const fa = assembleFront(front, setup);
    expect(fa.statR.static!.camber).toBeCloseTo(-1.0, 2);
    expect(toeInches(fa.statR.static!.toe, setup.toeGaugeDia)).toBeCloseTo(0, 3);
  });

  it('nonzero wheel offset walks the wheel center out along the pin', () => {
    const base = assembleFront(defaultState().front, defaultState().setup);
    const { front, setup } = defaultState();
    const sp = front.corners.R.spindle;
    const cal = sp.calibrated!;
    const pin = cal.pinDir!;
    const off = 1.5;
    front.corners.R.spindle = {
      ...sp,
      calibrated: {
        pinDir: pin, troLocal: cal.troLocal,
        hubFaceLocal: [
          cal.wcLocal![0] - pin[0] * off,
          cal.wcLocal![1] - pin[1] * off,
          cal.wcLocal![2] - pin[2] * off,
        ],
      },
    };
    front.corners.R.wheel.offsetToHubFace = off;
    const fa = assembleFront(front, setup);
    expect(fa.statR.static!.camber).toBeCloseTo(base.statR.static!.camber, 3);
    expect(fa.statR.static!.WC.y).toBeCloseTo(base.statR.static!.WC.y, 3);
  });
});

describe('mirrorV4Corner', () => {
  it('negates y and keeps measurements', () => {
    const m = mirrorV4Corner(clone(V4_DEFAULT.R));
    expect(m.LBJ[1]).toBeCloseTo(-V4_DEFAULT.R.LBJ[1], 9);
    expect(m.measCamber).toBe(V4_DEFAULT.R.measCamber);
  });
});
