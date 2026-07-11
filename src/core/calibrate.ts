/*
 * Spindle calibration fallback (spec §5).
 *
 * Machined pin ANGLES can't be tape-measured (lengths can). Flow: assemble
 * with the pin's angle fields unknown, enter measured camber + toe at known
 * ride height, and back-solve the pin direction in the kingpin frame. The
 * result is stored on the part as `calibrated` — from then on the spindle is
 * a reusable part card and alignment is fully position-driven.
 *
 * This is exactly v4's wheelAxis0 construction, ported INCLUDING the
 * side-sign fix: the target axis starts as (0, sign, 0) and every rotation
 * built from the side-symmetric measurements carries the side sign.
 */

import { DEG, T3, V, Vec3, rotAboutAxis } from './math';
import { dirToKingpinLocal, uprightXform } from './assembly';
import { toeDegFromInches } from './metrics';
import { FrontEnd, Setup, Side, Spindle } from './parts';
import { assembleFront } from './trim';

/** Ground-frame wheel spin axis implied by measured camber/toe (v4 port).
 *  Deliberate deviation from v4: the toe rotation is NEGATED. v4 had a
 *  latent calibration sign bug (masked by its default measToe = 0) where
 *  entering toe-in produced a wheel reporting toe-out. Spec §7 requires
 *  static toe == calibration input, toe-in positive. */
export function axisFromMeasured(
  side: Side, camberDeg: number, toeInches: number, gaugeDia: number,
): Vec3 {
  const sign = side === 'L' ? 1 : -1;   // +y = LEFT (driver side)
  let ax = V(0, sign, 0);
  ax = rotAboutAxis(ax, V(0, 0, 0), V(1, 0, 0), -camberDeg * DEG * sign);
  ax = rotAboutAxis(ax, V(0, 0, 0), V(0, 0, 1), -toeDegFromInches(toeInches, gaugeDia) * DEG * sign);
  return ax.normalize();
}

/**
 * Back-solve the spindle pin direction so the assembled, ride-trimmed corner
 * reports exactly the measured camber and toe. Returns a new Spindle with
 * `calibrated.pinDir` set (positions untouched). Iterates because the pin
 * direction moves the wheel center a hair, which moves the trim.
 */
export function calibrateSpindle(
  front: FrontEnd, setup: Setup, side: Side,
  measCamberDeg: number, measToeInches: number,
): Spindle {
  const spindle0 = front.corners[side].spindle;
  let pinDir: T3 = spindle0.calibrated?.pinDir
    ?? (spindle0.pin ? cardPinDir(spindle0) : [0, 0, 1]);

  let result: Spindle = spindle0;
  for (let i = 0; i < 10; i++) {
    result = {
      ...spindle0,
      calibrated: { ...spindle0.calibrated, pinDir },
    };
    const trial: FrontEnd = {
      ...front,
      corners: { ...front.corners, [side]: { ...front.corners[side], spindle: result } },
    };
    const fa = assembleFront(trial, setup);
    const stat = side === 'R' ? fa.statR : fa.statL;
    const c = stat.static!;
    const target = axisFromMeasured(side, measCamberDeg, measToeInches, setup.toeGaugeDia);
    // undo the trimmed upright pose, then express in the reference kingpin frame
    const x = uprightXform(stat, c.LBJ, c.UBJ, stat.psi);
    const axis0 = x.invDir(target).normalize();
    const next = dirToKingpinLocal(stat.kf0, axis0);
    const delta = Math.hypot(next[0] - pinDir[0], next[1] - pinDir[1], next[2] - pinDir[2]);
    pinDir = next;
    if (delta < 1e-12) break;
  }
  return { ...spindle0, calibrated: { ...spindle0.calibrated, pinDir } };
}

function cardPinDir(spindle: Spindle): T3 {
  const p = spindle.pin!;
  const inc = p.inclinationDeg * DEG, sw = p.sweepDeg * DEG;
  return [-Math.sin(inc), Math.cos(inc) * Math.sin(sw), Math.cos(inc) * Math.cos(sw)];
}
