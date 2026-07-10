/*
 * Parts & chassis editor (spec §6 panels/): part cards with the fields a
 * racer can measure or read off a spec sheet. Every input re-solves the
 * whole assembly; there is no alignment input anywhere.
 */
import { T3 } from '../core/math';
import { FrontEnd, Setup, Side } from '../core/parts';

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

interface Ctx { front: FrontEnd; setup: Setup }

function numField(ctx: Ctx, label: string, root: 'front' | 'setup', path: string, step = 0.05): string {
  const v = getPath(root === 'front' ? ctx.front : ctx.setup, path);
  const val = typeof v === 'number' ? String(+(v as number).toFixed(4)) : '';
  return `<div class="nf"><label>${esc(label)}</label>`
    + `<input type="number" step="${step}" value="${val}" data-root="${root}" data-path="${path}"></div>`;
}

function pointField(ctx: Ctx, label: string, path: string, side: Side | null): string {
  const arr = getPath(ctx.front, path) as T3;
  const yDisp = side === 'L' ? -arr[1] : arr[1];
  const ylab = side ? 'out' : 'y';
  const f = (ax: number, lab: string, value: number) =>
    `<div class="f"><i>${lab}</i><input type="number" step="0.1" value="${+value.toFixed(4)}" `
    + `data-root="front" data-path="${path}" data-ax="${ax}" data-side="${side ?? ''}"></div>`;
  return `<div class="ptrow"><div class="pl">${esc(label)}</div><div class="xyz">`
    + f(0, 'x', arr[0]) + f(1, ylab, yDisp) + f(2, 'z', arr[2]) + '</div></div>';
}

export function buildPartsForm(host: HTMLElement, ctx: Ctx, onChange: () => void): void {
  let h = '';
  h += '<div class="subhead">Vehicle & setup</div><div class="numrow">'
    + numField(ctx, 'Wheelbase', 'front', 'chassis.wheelbase', 0.5)
    + numField(ctx, 'Frame raise (in)', 'setup', 'frameRaise', 0.1)
    + numField(ctx, 'Toe gauge dia', 'setup', 'toeGaugeDia', 0.5)
    + '</div>';

  (['R', 'L'] as Side[]).forEach((side) => {
    const S = side === 'R' ? 'Right' : 'Left';
    const c = `corners.${side}`;
    const spindle = ctx.front.corners[side].spindle;
    h += `<div class="subhead ${side}">${S} — chassis pickups (measure once)</div>`;
    h += pointField(ctx, 'Lower arm — front pivot', `chassis.sides.${side}.lowerFront`, side);
    h += pointField(ctx, 'Lower arm — rear pivot', `chassis.sides.${side}.lowerRear`, side);
    h += pointField(ctx, 'Upper heim mount — front', `chassis.sides.${side}.upperFront`, side);
    h += pointField(ctx, 'Upper heim mount — rear', `chassis.sides.${side}.upperRear`, side);
    h += pointField(ctx, 'Spring pocket (frame)', `chassis.sides.${side}.springPocketUpper`, side);
    h += pointField(ctx, 'Shock mount (frame)', `chassis.sides.${side}.shockMountUpper`, side);

    h += `<div class="subhead ${side}">${S} — lower arm (stock GM spec)</div><div class="numrow">`
      + numField(ctx, 'Length (pivot→BJ)', 'front', `${c}.lowerArm.length`)
      + numField(ctx, 'BJ along axis', 'front', `${c}.lowerArm.bjAxial`)
      + numField(ctx, 'BJ drop', 'front', `${c}.lowerArm.bjDrop`)
      + '</div><div class="numrow">'
      + numField(ctx, 'Spring seat axial', 'front', `${c}.lowerArm.springSeat.axial`)
      + numField(ctx, 'Spring seat radial', 'front', `${c}.lowerArm.springSeat.radial`)
      + numField(ctx, 'Spring seat drop', 'front', `${c}.lowerArm.springSeat.drop`)
      + '</div><div class="numrow">'
      + numField(ctx, 'Shock seat axial', 'front', `${c}.lowerArm.shockSeat.axial`)
      + numField(ctx, 'Shock seat radial', 'front', `${c}.lowerArm.shockSeat.radial`)
      + numField(ctx, 'Shock seat drop', 'front', `${c}.lowerArm.shockSeat.drop`)
      + '</div>';

    h += `<div class="subhead ${side}">${S} — upper A-frame (heim legs)</div><div class="numrow">`
      + numField(ctx, 'Front leg base', 'front', `${c}.upperArm.legFront.baseLength`, 0.01)
      + numField(ctx, 'Rear leg base', 'front', `${c}.upperArm.legRear.baseLength`, 0.01)
      + '</div><div class="numrow">'
      + numField(ctx, 'Front heim TPI', 'front', `${c}.upperArm.legFront.heimPitchTPI`, 1)
      + numField(ctx, 'Rear heim TPI', 'front', `${c}.upperArm.legRear.heimPitchTPI`, 1)
      + numField(ctx, 'BJ drop (plate)', 'front', `${c}.upperArm.bjDrop`)
      + '</div>';

    h += `<div class="subhead ${side}">${S} — spindle (GM long, 3-piece)</div>`;
    h += spindle.calibrated?.pinDir
      ? `<div class="calbadge">✓ calibrated pin stored — overrides card angles <button class="b" style="flex:none;padding:2px 8px;margin-left:6px" data-clearcal="${side}">clear</button></div>`
      : '<div class="calbadge" style="color:var(--bad)">pin not calibrated — card angles in use (or blank)</div>';
    h += '<div class="numrow">'
      + numField(ctx, 'Height LBJ→UBJ', 'front', `${c}.spindle.height`, 0.01)
      + numField(ctx, 'Pin boss above LBJ', 'front', `${c}.spindle.pin.heightAboveLBJ`, 0.05)
      + numField(ctx, 'Pin snout length', 'front', `${c}.spindle.pin.snoutLength`, 0.05)
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
      + '</select></div></div>';

    h += `<div class="subhead ${side}">${S} — tie rod & wheel</div><div class="numrow">`
      + numField(ctx, 'Tie rod base len', 'front', `${c}.tieRod.baseLength`, 0.01)
      + numField(ctx, 'Sleeve TPI', 'front', `${c}.tieRod.sleevePitchTPI`, 1)
      + numField(ctx, 'Ride target WC z', 'setup', `corners.${side}.rideTargetWCz`, 0.05)
      + '</div><div class="numrow">'
      + numField(ctx, 'Tire radius (loaded)', 'front', `${c}.wheel.radius`, 0.25)
      + numField(ctx, 'Tire width', 'front', `${c}.wheel.width`, 0.25)
      + numField(ctx, 'Wheel offset→hub', 'front', `${c}.wheel.offsetToHubFace`, 0.05)
      + '</div>';
  });

  h += '<div class="subhead">Steering linkage (y from center, + = right)</div>'
    + pointField(ctx, 'Pitman pivot (box output)', 'chassis.steeringBox.pivot', null)
    + pointField(ctx, 'Pitman arm end (link L)', 'chassis.steeringBox.pitmanEnd', null)
    + pointField(ctx, 'Idler pivot', 'chassis.idler.pivot', null)
    + pointField(ctx, 'Idler arm end (link R)', 'chassis.idler.armEnd', null);

  host.innerHTML = h;

  host.querySelectorAll<HTMLInputElement>('input[data-path]').forEach((inp) => {
    inp.addEventListener('input', () => {
      let val = parseFloat(inp.value);
      if (!isFinite(val)) return;
      const root = inp.dataset.root === 'setup' ? ctx.setup : ctx.front;
      if (inp.dataset.ax !== undefined) {
        const ax = +inp.dataset.ax;
        if (ax === 1 && inp.dataset.side === 'L') val = -val;
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
  host.querySelectorAll<HTMLButtonElement>('button[data-clearcal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const side = btn.dataset.clearcal as Side;
      ctx.front.corners[side].spindle.calibrated = undefined;
      onChange();
    });
  });
}

function ensurePin(ctx: Ctx, path: string): void {
  const m = path.match(/^corners\.(R|L)\.spindle\.pin\./);
  if (!m) return;
  const spindle = ctx.front.corners[m[1] as Side].spindle;
  if (!spindle.pin) {
    spindle.pin = { heightAboveLBJ: 0, inclinationDeg: 0, sweepDeg: 0, snoutLength: 0 };
  }
}
