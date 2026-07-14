/*
 * Parts & chassis editor (spec §6 panels/): part cards with the fields a
 * racer can measure or read off a spec sheet. Every input re-solves the
 * whole assembly; there is no alignment input anywhere.
 *
 * Two entry points share the same wiring:
 *   - buildPartsForm(host, ...)  — legacy horizontal card row (M1 shim)
 *   - renderPartEditor(host, partId, side, ...)  — single-part editor (M2+)
 */
import { T3, V as coreV } from '../core/math';
import { CornerParts, FrontEnd, Setup, Side, effectiveLegLength } from '../core/parts';
import { FrontAssembly } from '../core/trim';
import { FrontState } from '../core/metrics';
import { CornerSolution, fromKingpinLocal, kingpinFrame, spindleLocals, toKingpinLocal } from '../core/assembly';
import { armPickLengths } from '../state/setup';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Resolve a dotted path like "corners.R.lowerArm.length" on an object. */
function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}
function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);
  (target as Record<string, unknown>)[last] = value;
}

interface Ctx {
  front: FrontEnd;
  setup: Setup;
  fa?: FrontAssembly | null;
  /** live solved state (follows the travel sliders) — BJ/hub coordinates
   *  display in the CURRENT pose so they line up with a drooped scan */
  live?: () => FrontState | null;
}

/** What a ⌖ button asks the app to measure off the scan.
 *  point = fill an xyz point · two = distance between two clicks ·
 *  ubj/tro/lbj/shockseat = one-click recipes using known chassis points. */
export interface PickRequest {
  kind: 'point' | 'two' | 'ubj' | 'tro' | 'lbj' | 'shockseat' | 'spindle' | 'hubface';
  path: string;
  side: Side | null;
  label: string;
}

/** The 8 parts of the front end that the user navigates in Build mode. */
export type PartId =
  | 'chassis' | 'steering'
  | 'lca' | 'uca' | 'spindle' | 'tieRod' | 'shock' | 'wheel';

/** Which parts are per-side vs global. */
export const PART_HAS_SIDE: Record<PartId, boolean> = {
  chassis: false, steering: false,
  lca: true, uca: true, spindle: true, tieRod: true, shock: true, wheel: true,
};

/** Human labels for the nav. */
export const PART_LABELS: Record<PartId, string> = {
  chassis: 'Chassis',
  steering: 'Steering linkage',
  lca: 'Lower control arm',
  uca: 'Upper control arm',
  spindle: 'Spindle',
  tieRod: 'Tie rod',
  shock: 'Shock',
  wheel: 'Wheel & tire',
};

function numField(
  ctx: Ctx, label: string, root: 'front' | 'setup', path: string, step = 0.05,
  pick?: PickRequest['kind'], side?: Side,
): string {
  const v = getPath(root === 'front' ? ctx.front : ctx.setup, path);
  const val = typeof v === 'number' ? String(+(v as number).toFixed(4)) : '';
  const btn = pick
    ? `<button class="pickbtn" data-picknum="${pick}" data-path="${path}" data-side="${side ?? ''}" data-picklabel="${esc(label)}">⌖</button>`
    : '';
  return `<div class="nf"><label>${esc(label)}${btn}</label>`
    + `<input type="number" step="${step}" value="${val}" data-root="${root}" data-path="${path}"></div>`;
}

/** Write a scan-measured scalar into a front-rooted path (creates the pin
 *  card on demand — its fields may be untouched/null). */
export function setFrontValue(front: FrontEnd, path: string, v: number): void {
  const m = path.match(/^corners\.(R|L)\.spindle\.pin\./);
  if (m) {
    const spindle = front.corners[m[1] as Side].spindle;
    if (!spindle.pin) spindle.pin = { heightAboveLBJ: 0, inclinationDeg: 0, sweepDeg: 0, snoutLength: 0 };
  }
  setPath(front, path, v);
}

function pointField(ctx: Ctx, label: string, path: string, side: Side | null): string {
  const arr = getPath(ctx.front, path) as T3;
  const yDisp = side === 'R' ? -arr[1] : arr[1];   // +y = LEFT; "out" always +
  const ylab = side ? 'out' : 'y';
  const f = (ax: number, lab: string, value: number) =>
    `<div class="f"><i>${lab}</i><input type="number" step="0.1" value="${+value.toFixed(4)}" `
    + `data-root="front" data-path="${path}" data-ax="${ax}" data-side="${side ?? ''}"></div>`;
  return `<div class="ptrow"><div class="pl">${esc(label)}`
    + `<button class="pickbtn" data-pickpt="${path}" data-pickside="${side ?? ''}" data-picklabel="${esc(label)}" title="pick this point on the 3D scan">⌖ pick</button>`
    + '</div><div class="xyz">'
    + f(0, 'x', arr[0]) + f(1, ylab, yDisp) + f(2, 'z', arr[2]) + '</div></div>';
}

/** Write a picked scan point (car-frame coords) into a chassis point path.
 *  If the target array doesn't exist yet (optional field on a legacy save),
 *  create it — parent objects are always present in our schema. */
export function setFrontPoint(front: FrontEnd, path: string, t3: T3): void {
  const arr = getPath(front, path) as T3 | undefined;
  if (arr) { arr[0] = t3[0]; arr[1] = t3[1]; arr[2] = t3[2]; return; }
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<Record<string, unknown>>(
    (o, k) => o[k] as Record<string, unknown>, front as unknown as Record<string, unknown>,
  );
  target[last] = [t3[0], t3[1], t3[2]];
}

/** Read a chassis point path (for the live highlight while fine-tuning). */
export function getFrontPoint(front: FrontEnd, path: string): T3 | null {
  const arr = getPath(front, path);
  return Array.isArray(arr) && arr.length === 3 ? (arr as T3) : null;
}

/* ---- ball joints as x/y/z: the arm spec derives from chassis pickups +
 * BJ location, so the user edits familiar car coordinates and the part
 * lengths fall out (same pose-independent math as scan picking). ---- */

const rr3 = (v: number) => Math.round(v * 1000) / 1000;

export type BJKind = 'lower' | 'upper' | 'hub';

function liveCorner(ctx: Ctx, side: Side): CornerSolution | null {
  const m = ctx.live?.();
  if (m) return side === 'R' ? m.cR : m.cL;
  const stat = ctx.fa ? (side === 'R' ? ctx.fa.statR : ctx.fa.statL) : null;
  return stat?.static ?? null;
}

function hubLocalOf(corner: CornerParts): T3 | null {
  const cal = corner.spindle.calibrated;
  if (cal?.hubFaceLocal) return cal.hubFaceLocal;
  try {
    const sl = spindleLocals(corner.spindle, corner.wheel);
    const off = corner.wheel.offsetToHubFace;
    return [
      sl.wcLocal[0] - sl.pinDir[0] * off,
      sl.wcLocal[1] - sl.pinDir[1] * off,
      sl.wcLocal[2] - sl.pinDir[2] * off,
    ];
  } catch { return null; }
}

/** BJ / hub-face position at the CURRENT solved pose, car coordinates. */
export function getSolvedBJ(ctx: Ctx, side: Side, kind: BJKind): T3 | null {
  const c = liveCorner(ctx, side);
  if (!c) return null;
  if (kind === 'hub') {
    const stat = ctx.fa ? (side === 'R' ? ctx.fa.statR : ctx.fa.statL) : null;
    const local = hubLocalOf(ctx.front.corners[side]);
    if (!stat || !local) return null;
    const w = c.xf(fromKingpinLocal(stat.kf0, local));
    return [rr3(w.x), rr3(w.y), rr3(w.z)];
  }
  const p = kind === 'lower' ? c.LBJ : c.UBJ;
  return [rr3(p.x), rr3(p.y), rr3(p.z)];
}

/** Push current-pose coordinates into the BJ/hub inputs (skips the focused
 *  one so nudging is never interrupted). Called on every solver update. */
export function refreshBJFields(ctx: Ctx): void {
  document.querySelectorAll<HTMLInputElement>('input[data-bjkind]').forEach((inp) => {
    if (inp === document.activeElement) return;
    const side = inp.dataset.bjside as Side;
    const kind = inp.dataset.bjkind as BJKind;
    const p = getSolvedBJ(ctx, side, kind);
    if (!p) return;
    const ax = +inp.dataset.bjax!;
    const v = ax === 0 ? p[0] : ax === 1 ? (side === 'R' ? -p[1] : p[1]) : p[2];
    inp.value = String(rr3(v));
  });
}

const BJ_PICK: Record<BJKind, string> = { lower: 'lbj', upper: 'ubj', hub: 'hubface' };

function bjRow(ctx: Ctx, label: string, side: Side, kind: BJKind): string {
  const p = getSolvedBJ(ctx, side, kind);
  const pick = BJ_PICK[kind];
  const f = (ax: number, lab: string, value: number | null) =>
    `<div class="f"><i>${lab}</i><input type="number" step="0.1" value="${value === null ? '' : value}" `
    + `data-bjkind="${kind}" data-bjside="${side}" data-bjax="${ax}"></div>`;
  const yDisp = p === null ? null : (side === 'R' ? -p[1] : p[1]);
  return `<div class="ptrow"><div class="pl">${esc(label)}`
    + `<button class="pickbtn" data-picknum="${pick}" data-path="" data-side="${side}" data-picklabel="${esc(label)}">⌖ pick</button>`
    + '</div><div class="xyz">'
    + f(0, 'x', p && rr3(p[0])) + f(1, 'out', yDisp && rr3(yDisp)) + f(2, 'z', p && rr3(p[2]))
    + '</div></div>';
}

/** Derived arm geometry line, refreshed in place on every BJ edit. */
function armDerivedText(ctx: Ctx, side: Side): string {
  const la = ctx.front.corners[side].lowerArm;
  const ua = ctx.front.corners[side].upperArm;
  const c = ctx.setup.corners[side];
  const cs = ctx.front.chassis.sides[side];
  const uf = cs.upperFront, ur = cs.upperRear;
  const span = Math.hypot(ur[0] - uf[0], ur[1] - uf[1], ur[2] - uf[2]);
  const lf = effectiveLegLength(ua.legFront, c.heimTurnsFront);
  const lr = effectiveLegLength(ua.legRear, c.heimTurnsRear);
  const a = (lf * lf + span * span - lr * lr) / (2 * span);
  const rho2 = lf * lf - a * a;
  const rho = rho2 > 0 ? Math.sqrt(rho2) : NaN;
  return `derived — lower: radius <b>${la.length.toFixed(3)}"</b> axial ${la.bjAxial.toFixed(3)}" drop ${la.bjDrop.toFixed(2)}"`
    + ` · upper legs <b>${lf.toFixed(3)}"</b>/<b>${lr.toFixed(3)}"</b>`
    + ` → BJ↔axis <b>${isFinite(rho) ? rho.toFixed(3) : '—'}"</b>`;
}

const card = (title: string, cls: string, body: string) =>
  `<div class="card ${cls}"><h4>${esc(title)}</h4>${body}</div>`;

/* ============================================================
 *  Per-part fragment builders — shared by both entry points.
 *  Each returns *the interior body only* (no .card wrapper), so
 *  the shim can drop them into legacy cards and the M2 editor
 *  can drop them into a single #partEditor container.
 * ============================================================ */

function chassisSteeringBody(ctx: Ctx): string {
  return '<div class="numrow">'
    + numField(ctx, 'Wheelbase', 'front', 'chassis.wheelbase', 0.5)
    + numField(ctx, 'Frame raise (in)', 'setup', 'frameRaise', 0.1)
    + numField(ctx, 'Toe gauge dia', 'setup', 'toeGaugeDia', 0.5)
    + '</div><div class="cg2">'
    + pointField(ctx, 'Pitman pivot (box output)', 'chassis.steeringBox.pivot', null)
    + pointField(ctx, 'Pitman arm end (link L)', 'chassis.steeringBox.pitmanEnd', null)
    + pointField(ctx, 'Idler pivot', 'chassis.idler.pivot', null)
    + pointField(ctx, 'Idler arm end (link R)', 'chassis.idler.armEnd', null)
    + '</div>';
}

function chassisPickupsBody(ctx: Ctx, side: Side): string {
  return '<div class="cg2">'
    + pointField(ctx, 'Lower arm — front pivot', `chassis.sides.${side}.lowerFront`, side)
    + pointField(ctx, 'Lower arm — rear pivot', `chassis.sides.${side}.lowerRear`, side)
    + pointField(ctx, 'Upper heim mount — front', `chassis.sides.${side}.upperFront`, side)
    + pointField(ctx, 'Upper heim mount — rear', `chassis.sides.${side}.upperRear`, side)
    + '</div>';
}

function controlArmsBody(ctx: Ctx, side: Side): string {
  const c = `corners.${side}`;
  return '<div class="cardhelp">Ball joints in car coordinates (solved at ride).'
    + ' Edit x/out/z or ⌖ pick from the scan — the arm spec (pivot-axis'
    + ' radius, heim leg lengths) is derived from the chassis pickups + BJ.'
    + ' Front/rear heims adjust independently in the Adjustments panel.</div>'
    + '<div class="cg2">'
    + bjRow(ctx, 'Lower ball joint', side, 'lower')
    + bjRow(ctx, 'Upper ball joint', side, 'upper')
    + '<div class="numrow">'
    + numField(ctx, 'Lower BJ drop', 'front', `${c}.lowerArm.bjDrop`)
    + numField(ctx, 'Front heim TPI', 'front', `${c}.upperArm.legFront.heimPitchTPI`, 1)
    + numField(ctx, 'Rear heim TPI', 'front', `${c}.upperArm.legRear.heimPitchTPI`, 1)
    + '</div></div>'
    + `<div class="leglen" id="armDerived${side}">${armDerivedText(ctx, side)}</div>`;
}

function shockBody(ctx: Ctx, side: Side): string {
  const c = `corners.${side}`;
  return '<div class="cardhelp">Upper mount on the frame, lower seat on the arm — these'
    + ' set the motion ratio (dShock/dWheel in the HUD). Spring omitted for now.</div>'
    + pointField(ctx, 'Chassis mount (frame)', `chassis.sides.${side}.shockMountUpper`, side)
    + '<div class="numrow">'
    + numField(ctx, 'Seat on arm — axial', 'front', `${c}.lowerArm.shockSeat.axial`, 0.05, 'shockseat', side)
    + numField(ctx, 'Seat radial', 'front', `${c}.lowerArm.shockSeat.radial`)
    + numField(ctx, 'Seat drop', 'front', `${c}.lowerArm.shockSeat.drop`)
    + '</div>';
}

function spindleBody(ctx: Ctx, side: Side): string {
  const c = `corners.${side}`;
  const spindle = ctx.front.corners[side].spindle;
  const calBadge = spindle.calibrated?.pinDir
    ? `<div class="calbadge">✓ calibrated pin stored — overrides card angles <button data-clearcal="${side}">clear</button></div>`
    : '<div class="calbadge" style="color:var(--bad)">pin not calibrated — card angles in use (or blank)</div>';
  const scanBadge = spindle.calibrated?.hubFaceLocal || spindle.calibrated?.wcLocal
    ? '<div class="calbadge">✓ hub &amp; tie-rod positions measured</div>' : '';
  return calBadge + scanBadge
    + '<div class="btns" style="margin-bottom:10px">'
    + `<button class="b primary" data-picknum="spindle" data-path="" data-side="${side}" data-picklabel="spindle">⌖ Measure spindle from scan (4 clicks)</button>`
    + '</div>'
    + '<div class="cardhelp">LBJ → UBJ → tie-rod outer → hub face. Fills the'
    + ' spindle height + hub/tie-rod positions, and the arm lengths & tie rod'
    + ' as a bonus. Pin ANGLES still come from camber/toe calibration.</div>'
    + '<div class="cg2"><div class="numrow">'
    + numField(ctx, 'Height LBJ→UBJ', 'front', `${c}.spindle.height`, 0.01, 'two', side)
    + numField(ctx, 'Pin boss above LBJ', 'front', `${c}.spindle.pin.heightAboveLBJ`, 0.05, 'two', side)
    + numField(ctx, 'Pin snout length', 'front', `${c}.spindle.pin.snoutLength`, 0.05, 'two', side)
    + '</div><div class="numrow">'
    + numField(ctx, 'Pin inclination °', 'front', `${c}.spindle.pin.inclinationDeg`, 0.1)
    + numField(ctx, 'Pin sweep °', 'front', `${c}.spindle.pin.sweepDeg`, 0.1)
    + '</div><div class="numrow">'
    + numField(ctx, 'Str. arm length', 'front', `${c}.spindle.steeringArm.length`, 0.05)
    + numField(ctx, 'Str. arm drop', 'front', `${c}.spindle.steeringArm.drop`, 0.05)
    + numField(ctx, 'Str. arm sweep °', 'front', `${c}.spindle.steeringArm.sweepDeg`, 0.5)
    + `<div class="nf"><label>Arm side</label><select data-root="front" data-path="${c}.spindle.steeringArm.side" data-sel="1">`
    + `<option value="front"${spindle.steeringArm.side === 'front' ? ' selected' : ''}>front</option>`
    + `<option value="rear"${spindle.steeringArm.side === 'rear' ? ' selected' : ''}>rear</option>`
    + '</select></div></div>'
    + bjRow(ctx, 'Rotor / hub face center', side, 'hub')
    + '</div>';
}

function tieRodWheelBody(ctx: Ctx, side: Side): string {
  const c = `corners.${side}`;
  return '<div class="numrow">'
    + numField(ctx, 'Tie rod base len', 'front', `${c}.tieRod.baseLength`, 0.01, 'tro', side)
    + numField(ctx, 'Sleeve TPI', 'front', `${c}.tieRod.sleevePitchTPI`, 1)
    + numField(ctx, 'Sleeve ends (1/2)', 'front', `${c}.tieRod.endsThreaded`, 1)
    + numField(ctx, 'Ride target WC z', 'setup', `corners.${side}.rideTargetWCz`, 0.05)
    + '</div><div class="numrow">'
    + numField(ctx, 'Tire radius (loaded)', 'front', `${c}.wheel.radius`, 0.25)
    + numField(ctx, 'Tire width', 'front', `${c}.wheel.width`, 0.25)
    + numField(ctx, 'Wheel offset→hub', 'front', `${c}.wheel.offsetToHubFace`, 0.05)
    + '</div>';
}

/* ============================================================
 *  Per-part editor renderers (M2+). Each returns a self-contained
 *  <section> targeted at the #partEditor mount.
 * ============================================================ */

function sectionHeader(title: string, side?: Side): string {
  const cls = side ? (side === 'R' ? 'R' : 'L') : '';
  const suffix = side ? ` — ${side === 'R' ? 'RIGHT' : 'LEFT'}` : '';
  return `<div class="editorHead ${cls}"><h3>${esc(title)}${suffix}</h3></div>`;
}

export function renderChassisEditor(ctx: Ctx): string {
  return sectionHeader('Chassis')
    + '<div class="editorBody">'
    + guideButtonHTML('chassis', null)
    + '<div class="cardhelp">The frame itself: wheelbase and how high the frame'
    + ' sits (raise/lower on the jack). Pickups below are where the arms bolt on.</div>'
    + '<div class="numrow">'
    + numField(ctx, 'Wheelbase', 'front', 'chassis.wheelbase', 0.5)
    + numField(ctx, 'Frame raise (in)', 'setup', 'frameRaise', 0.1)
    + '</div>'
    + '<h5 class="subhead">Chassis pickups — LEFT</h5>' + chassisPickupsBody(ctx, 'L')
    + '<h5 class="subhead">Chassis pickups — RIGHT</h5>' + chassisPickupsBody(ctx, 'R')
    + '</div>';
}

export function renderSteeringLinkageEditor(ctx: Ctx): string {
  // Default the tie-rod inners to their arm ends so v1 saves still render
  // (they're modeled as the same point historically).
  const sb = ctx.front.chassis.steeringBox;
  const idl = ctx.front.chassis.idler;
  if (!sb.tieRodInner) sb.tieRodInner = [...sb.pitmanEnd] as T3;
  if (!idl.tieRodInner) idl.tieRodInner = [...idl.armEnd] as T3;
  return sectionHeader('Steering linkage')
    + '<div class="editorBody">'
    + guideButtonHTML('steering', null)
    + '<div class="cardhelp"><b>Pivots + arm ends</b> — vertical-axis taper'
    + ' joints where the pitman/idler arms bolt to the center link. The 4-bar'
    + ' rotates about these on steering input.</div>'
    + '<div class="numrow">'
    + numField(ctx, 'Toe gauge dia', 'setup', 'toeGaugeDia', 0.5)
    + '</div><div class="cg2">'
    + pointField(ctx, 'Pitman pivot (box output)', 'chassis.steeringBox.pivot', null)
    + pointField(ctx, 'Pitman arm end (link end)', 'chassis.steeringBox.pitmanEnd', null)
    + pointField(ctx, 'Idler pivot', 'chassis.idler.pivot', null)
    + pointField(ctx, 'Idler arm end (link end)', 'chassis.idler.armEnd', null)
    + '</div>'
    + '<div class="cardhelp" style="margin-top:12px"><b>Tie-rod inner joints</b>'
    + ' — SEPARATE fore/aft-axis taper joints where each tie rod attaches to'
    + ' the center link. Usually a few inches inboard of the arm end. Leave equal'
    + ' to the arm end if your linkage has the tie rod bolted right at the arm'
    + ' end (rare).</div>'
    + '<div class="cg2">'
    + pointField(ctx, 'Tie-rod inner (pitman side)', 'chassis.steeringBox.tieRodInner', null)
    + pointField(ctx, 'Tie-rod inner (idler side)', 'chassis.idler.tieRodInner', null)
    + '</div></div>';
}

export function renderLCAEditor(ctx: Ctx, side: Side): string {
  const c = `corners.${side}`;
  return sectionHeader('Lower control arm', side)
    + '<div class="editorBody">'
    + guideButtonHTML('lca', side)
    + '<div class="cardhelp">Lower chassis pickups define the pivot axis. The'
    + ' lower ball joint sets the arm radius + axial position — edit BJ x/out/z'
    + ' or ⌖ pick from the scan.</div>'
    + '<h5 class="subhead">Chassis pickups (lower)</h5>'
    + '<div class="cg2">'
    + pointField(ctx, 'Lower arm — front pivot', `chassis.sides.${side}.lowerFront`, side)
    + pointField(ctx, 'Lower arm — rear pivot', `chassis.sides.${side}.lowerRear`, side)
    + '</div>'
    + '<h5 class="subhead">Ball joint</h5>'
    + bjRow(ctx, 'Lower ball joint', side, 'lower')
    + '<div class="numrow">'
    + numField(ctx, 'Lower BJ drop', 'front', `${c}.lowerArm.bjDrop`)
    + '</div>'
    + `<div class="leglen" id="armDerived${side}">${armDerivedText(ctx, side)}</div>`
    + '</div>';
}

export function renderUCAEditor(ctx: Ctx, side: Side): string {
  const c = `corners.${side}`;
  return sectionHeader('Upper control arm', side)
    + '<div class="editorBody">'
    + guideButtonHTML('uca', side)
    + '<div class="cardhelp">Upper heim mounts on the frame; the ball joint'
    + ' + heim TPI derive the leg lengths. Adjuster turns live in Tune → Adjustments.</div>'
    + '<h5 class="subhead">Chassis pickups (upper)</h5>'
    + '<div class="cg2">'
    + pointField(ctx, 'Upper heim mount — front', `chassis.sides.${side}.upperFront`, side)
    + pointField(ctx, 'Upper heim mount — rear', `chassis.sides.${side}.upperRear`, side)
    + '</div>'
    + '<h5 class="subhead">Ball joint</h5>'
    + bjRow(ctx, 'Upper ball joint', side, 'upper')
    + '<div class="numrow">'
    + numField(ctx, 'Front heim TPI', 'front', `${c}.upperArm.legFront.heimPitchTPI`, 1)
    + numField(ctx, 'Rear heim TPI', 'front', `${c}.upperArm.legRear.heimPitchTPI`, 1)
    + '</div>'
    + `<div class="leglen" id="armDerived${side}">${armDerivedText(ctx, side)}</div>`
    + '</div>';
}

export function renderSpindleEditor(ctx: Ctx, side: Side): string {
  return sectionHeader('Spindle (GM long, 3-piece)', side)
    + '<div class="editorBody">' + guideButtonHTML('spindle', side) + spindleBody(ctx, side) + '</div>';
}

export function renderTieRodEditor(ctx: Ctx, side: Side): string {
  const c = `corners.${side}`;
  return sectionHeader('Tie rod', side)
    + '<div class="editorBody">'
    + guideButtonHTML('tieRod', side)
    + '<div class="numrow">'
    + numField(ctx, 'Tie rod base len', 'front', `${c}.tieRod.baseLength`, 0.01, 'tro', side)
    + numField(ctx, 'Sleeve TPI', 'front', `${c}.tieRod.sleevePitchTPI`, 1)
    + numField(ctx, 'Sleeve ends (1/2)', 'front', `${c}.tieRod.endsThreaded`, 1)
    + '</div></div>';
}

export function renderShockEditor(ctx: Ctx, side: Side): string {
  return sectionHeader('Shock', side)
    + '<div class="editorBody">' + guideButtonHTML('shock', side) + shockBody(ctx, side) + '</div>';
}

export function renderWheelEditor(ctx: Ctx, side: Side): string {
  const c = `corners.${side}`;
  return sectionHeader('Wheel & tire', side)
    + '<div class="editorBody">'
    + guideButtonHTML('wheel', side)
    + '<div class="numrow">'
    + numField(ctx, 'Tire radius (loaded)', 'front', `${c}.wheel.radius`, 0.25)
    + numField(ctx, 'Tire width', 'front', `${c}.wheel.width`, 0.25)
    + numField(ctx, 'Wheel offset→hub', 'front', `${c}.wheel.offsetToHubFace`, 0.05)
    + numField(ctx, 'Ride target WC z', 'setup', `corners.${side}.rideTargetWCz`, 0.05)
    + '</div></div>';
}

interface EditorCallbacks {
  onChange: (structural?: boolean) => void;
  onPick?: (req: PickRequest) => void;
  onFocusPoint?: (path: string | null) => void;
  /** "Guide me through this part" — runs a mini wizard covering only that
   *  part's picks. Only relevant when a scan is loaded. */
  onPartGuide?: (partId: PartId, side: Side | null) => void;
}

/** Which pick recipes each part uses in its guided flow. Empty = no guide. */
const PART_GUIDE_STEPS: Record<PartId, string[]> = {
  chassis: ['lowerFront', 'lowerRear', 'upperFront', 'upperRear'],
  steering: ['pivot', 'pitmanEnd', 'idlerPivot', 'idlerEnd', 'triPit', 'triIdl'],
  lca: ['lowerFront', 'lowerRear', 'LBJ'],
  uca: ['upperFront', 'upperRear', 'UBJ'],
  spindle: ['spindle4'],       // the existing 4-click recipe
  tieRod: ['TRO'],
  shock: ['shockMount', 'shockSeat'],
  wheel: ['hubFace'],
};

function guideButtonHTML(partId: PartId, side: Side | null): string {
  if (!PART_GUIDE_STEPS[partId]?.length) return '';
  const n = PART_GUIDE_STEPS[partId].length;
  return `<div class="pickBar"><button class="b primary" data-partguide="${partId}" data-side="${side ?? ''}">`
    + `⌖ Guide me through this part (${n} pick${n === 1 ? '' : 's'})</button></div>`;
}

/** Render one part's editor into `host` and wire its inputs. */
export function renderPartEditor(
  host: HTMLElement, ctx: Ctx, partId: PartId | null, side: Side, cbs: EditorCallbacks,
): void {
  if (!partId) { host.innerHTML = '<div class="editorEmpty">Pick a part from the list to edit.</div>'; return; }
  let html = '';
  switch (partId) {
    case 'chassis': html = renderChassisEditor(ctx); break;
    case 'steering': html = renderSteeringLinkageEditor(ctx); break;
    case 'lca': html = renderLCAEditor(ctx, side); break;
    case 'uca': html = renderUCAEditor(ctx, side); break;
    case 'spindle': html = renderSpindleEditor(ctx, side); break;
    case 'tieRod': html = renderTieRodEditor(ctx, side); break;
    case 'shock': html = renderShockEditor(ctx, side); break;
    case 'wheel': html = renderWheelEditor(ctx, side); break;
  }
  host.innerHTML = html;
  wireEditorInputs(host, ctx, cbs);
}

/** Wire every input/select/pick button inside `host` to `ctx`.
 *  Behaves identically for the legacy full form and for a single-part editor. */
export function wireEditorInputs(
  host: HTMLElement, ctx: Ctx, cbs: EditorCallbacks,
): void {
  const { onChange, onPick, onFocusPoint } = cbs;
  host.querySelectorAll<HTMLInputElement>('input[data-path]').forEach((inp) => {
    // point fields: live crosshair in the 3D view while focused, and
    // Shift+Arrow = 0.01" fine nudge (plain arrows step 0.1")
    if (inp.dataset.ax !== undefined) {
      inp.addEventListener('focus', () => onFocusPoint?.(inp.dataset.path!));
      inp.addEventListener('blur', () => onFocusPoint?.(null));
      inp.addEventListener('keydown', (e) => {
        if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const v = (parseFloat(inp.value) || 0) + (e.key === 'ArrowUp' ? 0.01 : -0.01);
        inp.value = String(+v.toFixed(4));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    inp.addEventListener('input', () => {
      let val = parseFloat(inp.value);
      if (!isFinite(val)) return;
      const root = inp.dataset.root === 'setup' ? ctx.setup : ctx.front;
      if (inp.dataset.ax !== undefined) {
        const ax = +inp.dataset.ax;
        if (ax === 1 && inp.dataset.side === 'R') val = -val;   // +y = LEFT
        const arr = getPath(ctx.front, inp.dataset.path!) as T3;
        arr[ax] = val;
      } else {
        // pin card may be null until first touched
        if (inp.dataset.path!.includes('.pin.')) ensurePin(ctx, inp.dataset.path!);
        setPath(root, inp.dataset.path!, val);
      }
      onChange();
    });
  });
  host.querySelectorAll<HTMLSelectElement>('select[data-sel]').forEach((sel) => {
    sel.addEventListener('change', () => {
      setPath(ctx.front, sel.dataset.path!, sel.value);
      onChange();
    });
  });
  // ball-joint x/y/z editors: derive the arm spec from pickups + BJ location
  host.querySelectorAll<HTMLInputElement>('input[data-bjkind]').forEach((inp) => {
    const side = inp.dataset.bjside as Side;
    const kind = inp.dataset.bjkind as BJKind;
    inp.addEventListener('focus', () => onFocusPoint?.(`bj:${side}:${kind}`));
    inp.addEventListener('blur', () => onFocusPoint?.(null));
    inp.addEventListener('keydown', (e) => {
      if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const v = (parseFloat(inp.value) || 0) + (e.key === 'ArrowUp' ? 0.01 : -0.01);
      inp.value = String(+v.toFixed(4));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    inp.addEventListener('input', () => {
      const trio = [...host.querySelectorAll<HTMLInputElement>(
        `input[data-bjkind="${kind}"][data-bjside="${side}"]`,
      )].sort((x, y2) => +x.dataset.bjax! - +y2.dataset.bjax!);
      const vals = trio.map((t) => parseFloat(t.value));
      if (vals.some((v) => !isFinite(v))) return;
      const p: T3 = [vals[0], side === 'R' ? -vals[1] : vals[1], vals[2]];
      const cs = ctx.front.chassis.sides[side];
      if (kind === 'lower') {
        const la = ctx.front.corners[side].lowerArm;
        const got = armPickLengths(cs, p, la.bjDrop);
        la.bjAxial = rr3(got.axial);
        la.length = rr3(got.radial);
      } else if (kind === 'upper') {
        const ua = ctx.front.corners[side].upperArm;
        const cc = ctx.setup.corners[side];
        const dist = (t: T3) => Math.hypot(t[0] - p[0], t[1] - p[1], t[2] - p[2]);
        ua.legFront.baseLength = rr3(dist(cs.upperFront) - cc.heimTurnsFront / ua.legFront.heimPitchTPI);
        ua.legRear.baseLength = rr3(dist(cs.upperRear) - cc.heimTurnsRear / ua.legRear.heimPitchTPI);
      } else {
        // hub face: store in the spindle's kingpin frame at the CURRENT pose
        const c2 = liveCorner(ctx, side);
        if (!c2) return;
        const kf = kingpinFrame(c2.LBJ, c2.UBJ, side);
        const local = toKingpinLocal(kf, coreV(p[0], p[1], p[2]));
        const sp = ctx.front.corners[side].spindle;
        sp.calibrated = {
          ...sp.calibrated,
          wcLocal: undefined,
          hubFaceLocal: [rr3(local[0]), rr3(local[1]), rr3(local[2])],
        };
      }
      const derived = host.querySelector(`#armDerived${side}`);
      if (derived) derived.innerHTML = armDerivedText(ctx, side);
      onChange();
    });
  });

  host.querySelectorAll<HTMLButtonElement>('button[data-pickpt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onPick?.({
        kind: 'point',
        path: btn.dataset.pickpt!,
        side: (btn.dataset.pickside as Side) || null,
        label: btn.dataset.picklabel ?? 'point',
      });
    });
  });
  host.querySelectorAll<HTMLButtonElement>('button[data-picknum]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onPick?.({
        kind: btn.dataset.picknum as PickRequest['kind'],
        path: btn.dataset.path!,
        side: (btn.dataset.side as Side) || null,
        label: btn.dataset.picklabel ?? 'length',
      });
    });
  });
  host.querySelectorAll<HTMLButtonElement>('button[data-clearcal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const side = btn.dataset.clearcal as Side;
      ctx.front.corners[side].spindle.calibrated = undefined;
      onChange(true);
    });
  });
  host.querySelectorAll<HTMLButtonElement>('button[data-partguide]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cbs.onPartGuide?.(
        btn.dataset.partguide as PartId,
        (btn.dataset.side as Side) || null,
      );
    });
  });
}

/** onChange(structural): structural=true means the form layout itself must
 *  re-render (badges, pin creation) — plain value edits must NOT re-render
 *  or the focused field loses focus mid-nudge.
 *
 *  Legacy shim: renders the full horizontal card row exactly as before.
 *  M2 will replace this call site with renderPartEditor + a nav. */
export function buildPartsForm(
  host: HTMLElement, ctx: Ctx, onChange: (structural?: boolean) => void,
  onPick?: (req: PickRequest) => void,
  onFocusPoint?: (path: string | null) => void,
): void {
  let h = '';
  h += card('Vehicle & steering linkage', 'wide', chassisSteeringBody(ctx));

  (['R', 'L'] as Side[]).forEach((side) => {
    const S = side === 'R' ? 'Right' : 'Left';
    h += card(`${S} — chassis pickups`, `wide ${side}`, chassisPickupsBody(ctx, side));
    h += card(`${S} — control arms`, `wide ${side}`, controlArmsBody(ctx, side));
    h += card(`${S} — shock (motion ratio)`, side, shockBody(ctx, side));
    h += card(`${S} — spindle (GM long, 3-piece)`, `wide ${side}`, spindleBody(ctx, side));
    h += card(`${S} — tie rod & wheel`, side, tieRodWheelBody(ctx, side));
  });

  host.innerHTML = h;
  wireEditorInputs(host, ctx, { onChange, onPick, onFocusPoint });
}

function ensurePin(ctx: Ctx, path: string): void {
  const m = path.match(/^corners\.(R|L)\.spindle\.pin\./);
  if (!m) return;
  const spindle = ctx.front.corners[m[1] as Side].spindle;
  if (!spindle.pin) {
    spindle.pin = { heightAboveLBJ: 0, inclinationDeg: 0, sweepDeg: 0, snoutLength: 0 };
  }
}
