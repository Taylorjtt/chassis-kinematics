/*
 * CLR Suspension Builder — app shell. Owns the parts + setup state, re-solves
 * the assembly on every wrench turn, and feeds the 3D scene / HUD / charts /
 * front view. Alignment is an output everywhere.
 */
import './style.css';
import { FrontEnd, Setup, Side, effectiveLegLength, effectiveTieRodLength } from './core/parts';
import { FrontAssembly, assembleFront } from './core/trim';
import {
  FrontState, SweepData, TravelMode, computeSweep, gainAt, solveFrontState, toeInches,
} from './core/metrics';
import { calibrateSpindle } from './core/calibrate';
import { Vector2, Vector3 } from 'three';
import { defaultState, loadStateJSON, serializeState } from './state/setup';
import { Scene3D } from './ui/scene3d';
import { chartMulti, seriesRange } from './ui/charts';
import { drawFrontView } from './ui/frontview';
import { PickRequest, buildPartsForm, setFrontPoint, setFrontValue } from './ui/panels';
import { armPickLengths } from './state/setup';
import { AssemblyError, kingpinFrame, toKingpinLocal } from './core/assembly';
import { V as coreV } from './core/math';
import { ChassisPicks, ScanManager, ScanUnits, UNIT_TO_INCHES } from './ui/scan';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number, d: number) => (n >= 0 ? '+' : '') + n.toFixed(d);

/* ---------------- state ---------------- */
let { front, setup } = defaultState() as { front: FrontEnd; setup: Setup };
let fa: FrontAssembly | null = null;
let sweep: SweepData | null = null;
let mode: TravelMode = 'wheel';

const scene = new Scene3D($('scene'));

const AUTOSAVE_KEY = 'clrAutosave';
let fixingArms = false;

function rebuild(): void {
  try {
    fa = assembleFront(front, setup);
    sweep = computeSweep(fa);
    $('asmErr').style.display = 'none';
    // auto-persist every good state — measurements survive a reload
    try { localStorage.setItem(AUTOSAVE_KEY, serializeState(front, setup)); } catch { /* storage full */ }
  } catch (err) {
    if (!fixingArms && err instanceof AssemblyError && err.armFixable && err.side && offerArmFix(err)) {
      return;   // handled: either legs were fitted + rebuilt, or state reverted
    }
    // keep the last good assembly on screen so the user can back out
    $('asmErr').textContent = 'ASSEMBLY: ' + (err as Error).message;
    $('asmErr').style.display = 'block';
  }
  scene.clearTrail();
  syncLegLengths();
  updateDeltas();
  update();
}

/**
 * A measured spindle that the current upper arm can't reach is a real shop
 * situation — the fix on the car is turning the heims. Offer exactly that:
 * OK = find the smallest equal change to both upper leg lengths that makes
 * the corner assemble, No = undo the edit (restore the last good state).
 */
function offerArmFix(err: AssemblyError): boolean {
  const side = err.side!;
  const ok = window.confirm(
    `${err.message}\n\nThe ${side === 'R' ? 'RIGHT' : 'LEFT'} upper control arm leg lengths `
    + 'will have to change to assemble this spindle.\n\n'
    + 'OK — fit the upper arm legs to the spindle\nCancel — undo the change',
  );
  if (!ok) {
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) {
        const loaded = loadStateJSON(saved);
        front = loaded.front;
        setup = loaded.setup;
      }
    } catch { /* nothing to restore */ }
    fixingArms = true;
    rebuildForm(); syncAdjInputs(); rebuild();
    fixingArms = false;
    return true;
  }
  // search the smallest equal-length change (±4", 0.05" steps) that assembles
  for (let i = 1; i <= 80; i++) {
    for (const d of [i * 0.05, -i * 0.05]) {
      const trial: FrontEnd = JSON.parse(JSON.stringify(front));
      trial.corners[side].upperArm.legFront.baseLength += d;
      trial.corners[side].upperArm.legRear.baseLength += d;
      try {
        assembleFront(trial, setup);
      } catch { continue; }
      front = trial;
      fixingArms = true;
      rebuildForm(); syncAdjInputs(); rebuild();
      fixingArms = false;
      $('asmErr').textContent =
        `ARM FIT: ${side} upper legs ${d > 0 ? 'lengthened' : 'shortened'} ${Math.abs(d).toFixed(2)}" each to reach the spindle — check the part card`;
      $('asmErr').style.display = 'block';
      setTimeout(() => { $('asmErr').style.display = 'none'; }, 6000);
      return true;
    }
  }
  window.alert('Could not fit the upper arm to this spindle within ±4" — check the picked points.');
  return false;
}

function inputs() {
  return {
    travL: +($('travL') as HTMLInputElement).value,
    travR: +($('travR') as HTMLInputElement).value,
    steerDeg: +($('steer') as HTMLInputElement).value,
    mode,
  };
}

function toggles() {
  const on = (id: string) => ($(id) as HTMLInputElement).checked;
  return {
    construct: on('tConstruct'), trail: on('tTrail'), shock: on('tShock'),
    wire: on('tWire'), ghost: on('tGhost'), model: on('tModel'),
  };
}

/* ---------------- baseline ghost + deltas ----------------
 * Real wrench moves change the geometry by hundredths of an inch — correct,
 * but invisible at model scale. Snapshot a baseline, draw it as a dashed
 * ghost, and report the alignment deltas right where you wrench. */
let baseline: FrontAssembly | null = null;
let baselineSweep: SweepData | null = null;
function captureBaseline(): void {
  if (!fa) return;
  baseline = fa;
  baselineSweep = computeSweep(fa);
  const m0 = solveFrontState(fa, front.chassis.wheelbase, { travL: 0, travR: 0, steerDeg: 0, mode: 'wheel' });
  scene.setGhost(fa, m0);
  updateDeltas();
}
function updateDeltas(): void {
  const el = $('adjDelta');
  if (!fa || !baseline || fa === baseline) { el.innerHTML = 'Δ vs baseline — none (this is the baseline)'; return; }
  const gd = setup.toeGaugeDia;
  const d = (side: 'statR' | 'statL') => {
    const a = fa![side].static!, b = baseline![side].static!;
    return {
      camb: a.camber - b.camber,
      cast: a.casterLive - b.casterLive,
      toe: toeInches(a.toe, gd) - toeInches(b.toe, gd),
      trk: 0,
    };
  };
  const R = d('statR'), L = d('statL');
  const trk = (fa.statR.static!.WC.y - fa.statL.static!.WC.y)
    - (baseline.statR.static!.WC.y - baseline.statL.static!.WC.y);
  el.innerHTML =
    `Δ vs baseline — camber <b>L ${fmt(L.camb, 2)}° R ${fmt(R.camb, 2)}°</b>`
    + ` · caster <b>L ${fmt(L.cast, 2)}° R ${fmt(R.cast, 2)}°</b><br>`
    + `toe <b>L ${fmt(L.toe, 3)}" R ${fmt(R.toe, 3)}"</b>`
    + ` · track <b>${fmt(trk, 3)}"</b>`;
}

function update(): void {
  if (!fa) return;
  const m = solveFrontState(fa, front.chassis.wheelbase, inputs());
  scene.update(fa, m, toggles());
  updateHUD(m);
  drawCharts(m);
  const fvOn = ($('tFront') as HTMLInputElement).checked;
  $('fv').style.display = fvOn ? 'block' : 'none';
  if (fvOn) drawFrontView($('fvCanvas') as HTMLCanvasElement, $('fvInfo'), fa, m);
}

/* ---------------- HUD ---------------- */
function updateHUD(m: FrontState): void {
  if (!fa) return;
  const gd = setup.toeGaugeDia;
  const sR = fa.statR.static!, sL = fa.statL.static!;
  $('sCambL').textContent = fmt(sL.camber, 2); $('sCambR').textContent = fmt(sR.camber, 2);
  $('sCastL').textContent = fmt(sL.casterLive, 1); $('sCastR').textContent = fmt(sR.casterLive, 1);
  $('sToeL').textContent = fmt(toeInches(sL.toe, gd), 3); $('sToeR').textContent = fmt(toeInches(sR.toe, gd), 3);
  $('sTotToe').textContent = fmt(toeInches(sL.toe, gd) + toeInches(sR.toe, gd), 3);
  $('sTrack').textContent = (sR.WC.y - sL.WC.y).toFixed(2) + '"';
  $('hWtL').textContent = fmt(m.wtL, 2); $('hWtR').textContent = fmt(m.wtR, 2);
  $('hStL').textContent = fmt(m.stkL, 2); $('hStR').textContent = fmt(m.stkR, 2);
  $('hMrL').textContent = m.mrL.toFixed(2); $('hMrR').textContent = m.mrR.toFixed(2);
  $('hCambL').textContent = fmt(m.cL.camber, 2); $('hCambR').textContent = fmt(m.cR.camber, 2);
  $('hToeL').textContent = fmt(toeInches(m.cL.toe, gd), 3); $('hToeR').textContent = fmt(toeInches(m.cR.toe, gd), 3);
  $('hSteerL').textContent = fmt(m.steerL, 1); $('hSteerR').textContent = fmt(m.steerR, 1);
  $('hAck').textContent = m.ack === null ? '—' : m.ack.toFixed(0) + '%';
  $('hTot').textContent = m.tot === null ? '—' : m.tot.toFixed(1) + '°';
  if (sweep) {
    $('hGainR').textContent = fmt(gainAt(sweep, sweep.cambR, m.wtR), 2);
    $('hGainL').textContent = fmt(gainAt(sweep, sweep.cambL, m.wtL), 2);
  }
  $('hCasterR').textContent = fmt(m.cR.casterLive, 1); $('hCasterL').textContent = fmt(m.cL.casterLive, 1);
  $('hKpiR').textContent = m.cR.kpiLive.toFixed(1); $('hKpiL').textContent = m.cL.kpiLive.toFixed(1);
  $('hScrubR').textContent = isFinite(m.cR.scrub) ? fmt(m.cR.scrub, 2) : '—';
  $('hScrubL').textContent = isFinite(m.cL.scrub) ? fmt(m.cL.scrub, 2) : '—';
  $('hTrailR').textContent = isFinite(m.cR.trail) ? fmt(m.cR.trail, 2) : '—';
  $('hTrailL').textContent = isFinite(m.cL.trail) ? fmt(m.cL.trail, 2) : '—';
  if (m.rc.rc) {
    $('hRcZ').textContent = m.rc.rc[1].toFixed(2) + '"';
    $('hRcY').textContent = fmt(m.rc.rc[0], 2) + '"';
  } else { $('hRcZ').textContent = '—'; $('hRcY').textContent = '—'; }
  $('vTravL').textContent = fmt(+($('travL') as HTMLInputElement).value, 2) + ' in';
  $('vTravR').textContent = fmt(+($('travR') as HTMLInputElement).value, 2) + ' in';
  $('vSteer').textContent = fmt(m.steerA, 1) + '°';
}

/* Charts show the CURRENT sweep solid with the BASELINE sweep dashed
 * underneath — the whole point is seeing how a wrench move bends the curve. */
function drawCharts(m: FrontState): void {
  if (!sweep) return;
  const gd = setup.toeGaugeDia;
  const tv = sweep.trav;
  const showBase = !!baselineSweep && baseline !== fa;
  const bs = baselineSweep!;
  const DASH = [5, 4];
  const base = (ys: number[], color: string) => ({ ys, color, dash: DASH, width: 1.5 });
  const baseIf = (ys: number[], color: string) => (showBase ? [base(ys, color)] : []);

  chartMulti($('chCamb') as HTMLCanvasElement, tv, [
    ...baseIf(bs?.cambR ?? [], 'rgba(255,106,31,.42)'),
    ...baseIf(bs?.cambL ?? [], 'rgba(54,194,255,.42)'),
    { ys: sweep.cambR, color: '#ff6a1f', markerX: m.wtR },
    { ys: sweep.cambL, color: '#36c2ff', markerX: m.wtL },
  ]);
  chartMulti($('chToe') as HTMLCanvasElement, tv, [
    ...baseIf((bs?.toeR ?? []).map((d) => toeInches(d, gd)), 'rgba(255,106,31,.42)'),
    ...baseIf((bs?.toeL ?? []).map((d) => toeInches(d, gd)), 'rgba(54,194,255,.42)'),
    { ys: sweep.toeR.map((d) => toeInches(d, gd)), color: '#ff6a1f', markerX: m.wtR },
    { ys: sweep.toeL.map((d) => toeInches(d, gd)), color: '#36c2ff', markerX: m.wtL },
  ]);
  chartMulti($('chCast') as HTMLCanvasElement, tv, [
    ...baseIf(bs?.castR ?? [], 'rgba(255,106,31,.42)'),
    ...baseIf(bs?.castL ?? [], 'rgba(54,194,255,.42)'),
    { ys: sweep.castR, color: '#ff6a1f', markerX: m.wtR },
    { ys: sweep.castL, color: '#36c2ff', markerX: m.wtL },
  ]);
  chartMulti($('chRc') as HTMLCanvasElement, tv, [
    ...baseIf(bs?.rcz ?? [], 'rgba(255,210,63,.42)'),
    { ys: sweep.rcz, color: '#ffd23f', markerX: (m.wtR + m.wtL) / 2 },
  ]);

  // header readouts: Δ at ride vs baseline when one is set, else curve range
  const atRide = (ys: number[]) => ys[Math.floor(ys.length / 2)];
  if (showBase) {
    $('cCamb').textContent = 'Δ@ride R ' + fmt(atRide(sweep.cambR) - atRide(bs.cambR), 2)
      + '° / L ' + fmt(atRide(sweep.cambL) - atRide(bs.cambL), 2) + '°';
    $('cToe').textContent = 'Δ@ride R '
      + fmt(toeInches(atRide(sweep.toeR), gd) - toeInches(atRide(bs.toeR), gd), 3)
      + '" / L ' + fmt(toeInches(atRide(sweep.toeL), gd) - toeInches(atRide(bs.toeL), gd), 3) + '"';
    $('cCast').textContent = 'Δ@ride R ' + fmt(atRide(sweep.castR) - atRide(bs.castR), 2)
      + '° / L ' + fmt(atRide(sweep.castL) - atRide(bs.castL), 2) + '°';
    $('cRc').textContent = 'Δ@ride ' + fmt(atRide(sweep.rcz) - atRide(bs.rcz), 2) + '"';
  } else {
    $('cCamb').textContent = 'R ' + seriesRange(sweep.cambR).toFixed(2) + '° / L ' + seriesRange(sweep.cambL).toFixed(2) + '°';
    $('cToe').textContent = 'R ' + seriesRange(sweep.toeR.map((d) => toeInches(d, gd))).toFixed(3) + '" / L '
      + seriesRange(sweep.toeL.map((d) => toeInches(d, gd))).toFixed(3) + '"';
    $('cCast').textContent = 'R ' + seriesRange(sweep.castR).toFixed(2) + '° / L ' + seriesRange(sweep.castL).toFixed(2) + '°';
    $('cRc').textContent = seriesRange(sweep.rcz).toFixed(2) + '" travel';
  }
}

/* ---------------- IDE-style splitters ---------------- */
interface Layout { rightW: number; bottomH: number; ctrlF: number }
const LAYOUT_KEY = 'clrLayout3';
const layout: Layout = {
  rightW: 760, bottomH: 400, ctrlF: 0.5,
  ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}'),
};
function applyLayout(): void {
  const app = $('app');
  app.style.setProperty('--rightW', layout.rightW + 'px');
  app.style.setProperty('--bottomH', layout.bottomH + 'px');
  $('paneControls').style.flexGrow = String(Math.round(layout.ctrlF * 100));
  $('paneCharts').style.flexGrow = String(Math.round((1 - layout.ctrlF) * 100));
}
function wireSplitter(id: string, onMove: (e: PointerEvent) => void): void {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    const move = (ev: PointerEvent) => { onMove(ev); applyLayout(); };
    const up = () => {
      el.classList.remove('drag');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    e.preventDefault();
  });
}
wireSplitter('vsplit', (e) => {
  layout.rightW = Math.min(Math.max(window.innerWidth - e.clientX, 300), window.innerWidth * 0.55);
});
wireSplitter('hsplit', (e) => {
  layout.bottomH = Math.min(Math.max(window.innerHeight - e.clientY, 120), window.innerHeight * 0.65);
});
wireSplitter('rsplit', (e) => {
  const r = $('right').getBoundingClientRect();
  layout.ctrlF = Math.min(Math.max((e.clientY - r.top) / r.height, 0.15), 0.85);
});
applyLayout();

// panes and stage resize with the splitters — keep canvases in sync
let roPending = false;
const ro = new ResizeObserver(() => {
  if (roPending) return;
  roPending = true;
  requestAnimationFrame(() => { roPending = false; scene.resize(); update(); });
});
ro.observe($('scene'));
ro.observe($('paneCharts'));

/* ---------------- steppers (−/+ around every number input) ---------------- */
document.querySelectorAll<HTMLElement>('.stepper').forEach((box) => {
  const input = box.querySelector('input') as HTMLInputElement;
  const bump = (dir: number) => {
    const step = parseFloat(input.step) || 1;
    const v = (parseFloat(input.value) || 0) + dir * step;
    input.value = String(+v.toFixed(6));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  box.querySelector('[data-dec]')?.addEventListener('click', () => bump(-1));
  box.querySelector('[data-inc]')?.addEventListener('click', () => bump(+1));
});

// numeric fields select their content on focus so typing replaces it
document.addEventListener('focusin', (e) => {
  const t = e.target as HTMLInputElement;
  if (t?.tagName === 'INPUT' && t.type === 'number') t.select();
});

/* ---------------- adjustments in turns ---------------- */
function syncAdjInputs(): void {
  document.querySelectorAll<HTMLInputElement>('input[data-turn]').forEach((inp) => {
    const c = setup.corners[inp.dataset.turn as Side];
    const k = inp.dataset.tkey!;
    inp.value = String(k === 'hf' ? c.heimTurnsFront : k === 'hr' ? c.heimTurnsRear : c.tieRodTurns);
  });
  document.querySelectorAll<HTMLInputElement>('input[data-slug]').forEach((inp) => {
    inp.value = String(setup.corners[inp.dataset.slug as Side].slugs[inp.dataset.skey as keyof typeof setup.corners.R.slugs]);
  });
  document.querySelectorAll<HTMLInputElement>('input[data-cal]').forEach((inp) => {
    const m = setup.measured[inp.dataset.cal as Side];
    inp.value = String(inp.dataset.ckey === 'camber' ? m.camberDeg : m.toeIn);
  });
}

function syncLegLengths(): void {
  const el = $('legLens');
  const leg = (side: Side) => {
    const ua = front.corners[side].upperArm, c = setup.corners[side];
    const tr = front.corners[side].tieRod;
    return `<b>${side}</b> legs ${effectiveLegLength(ua.legFront, c.heimTurnsFront).toFixed(3)}"`
      + ` / ${effectiveLegLength(ua.legRear, c.heimTurnsRear).toFixed(3)}"`
      + ` · tie ${effectiveTieRodLength(tr, c.tieRodTurns).toFixed(3)}"`;
  };
  el.innerHTML = 'Effective lengths — ' + leg('L') + ' &nbsp; ' + leg('R');
}

document.querySelectorAll<HTMLInputElement>('input[data-turn]').forEach((inp) => {
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v)) return;
    const c = setup.corners[inp.dataset.turn as Side];
    if (inp.dataset.tkey === 'hf') c.heimTurnsFront = v;
    else if (inp.dataset.tkey === 'hr') c.heimTurnsRear = v;
    else c.tieRodTurns = v;
    rebuild();
  });
});
document.querySelectorAll<HTMLInputElement>('input[data-slug]').forEach((inp) => {
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v)) return;
    setup.corners[inp.dataset.slug as Side].slugs[inp.dataset.skey as keyof typeof setup.corners.R.slugs] = v;
    rebuild();
  });
});
$('adjZero').addEventListener('click', () => {
  (['R', 'L'] as Side[]).forEach((s) => {
    const c = setup.corners[s];
    c.heimTurnsFront = 0; c.heimTurnsRear = 0; c.tieRodTurns = 0;
    c.slugs = { uio: 0, uud: 0, ucs: 0, lio: 0, lud: 0 };
  });
  syncAdjInputs(); rebuild();
});

/* ---------------- calibration ---------------- */
document.querySelectorAll<HTMLInputElement>('input[data-cal]').forEach((inp) => {
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v)) return;
    const m = setup.measured[inp.dataset.cal as Side];
    if (inp.dataset.ckey === 'camber') m.camberDeg = v; else m.toeIn = v;
  });
});
$('calBtn').addEventListener('click', () => {
  try {
    (['R', 'L'] as Side[]).forEach((s) => {
      front.corners[s].spindle = calibrateSpindle(
        front, setup, s, setup.measured[s].camberDeg, setup.measured[s].toeIn,
      );
    });
    $('calMsg').textContent = '';
    rebuildForm(); rebuild();
    $('calMsg').style.color = 'var(--good)';
    $('calMsg').textContent = 'spindles calibrated — pin stored on the part';
  } catch (err) {
    $('calMsg').style.color = 'var(--bad)';
    $('calMsg').textContent = (err as Error).message;
  }
});

/* ---------------- motion controls ---------------- */
$('modeSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  $('modeSeg').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  mode = (b as HTMLElement).dataset.mode as TravelMode;
  const lab = mode === 'wheel' ? 'wheel' : 'shock';
  $('lblL').textContent = lab; $('lblR').textContent = lab;
  update();
}));
function travInput(which: Side): void {
  if (($('lock') as HTMLInputElement).checked) {
    const v = ($(which === 'L' ? 'travL' : 'travR') as HTMLInputElement).value;
    ($('travL') as HTMLInputElement).value = v;
    ($('travR') as HTMLInputElement).value = v;
  }
  update();
}
$('travL').addEventListener('input', () => travInput('L'));
$('travR').addEventListener('input', () => travInput('R'));
$('steer').addEventListener('input', update);
$('setBaseline').addEventListener('click', () => { captureBaseline(); update(); });
// H toggles the sim model — handy mid-pick when it covers the scan
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (e.key.toLowerCase() !== 'h' || t?.tagName === 'INPUT' || t?.tagName === 'SELECT' || t?.tagName === 'TEXTAREA') return;
  const box = $('tModel') as HTMLInputElement;
  box.checked = !box.checked;
  box.closest('.tg')!.classList.toggle('on', box.checked);
  update();
});
['tModel', 'tConstruct', 'tTrail', 'tShock', 'tWire', 'tFront', 'tGhost'].forEach((id) => {
  const el = $(id) as HTMLInputElement;
  el.addEventListener('change', () => {
    el.closest('.tg')!.classList.toggle('on', el.checked);
    if (id === 'tTrail' && !el.checked) scene.clearTrail();
    update();
  });
});
$('recenter').addEventListener('click', () => { scene.resetView(); scene.render(); });
$('zeroInputs').addEventListener('click', () => {
  ['travL', 'travR', 'steer'].forEach((id) => { ($(id) as HTMLInputElement).value = '0'; });
  scene.clearTrail(); update();
});

/* ---------------- 3D scan import + point picking ---------------- */
const scan = new ScanManager();
scene.addObject(scan.group);

let pickCb: ((p: Vector3) => void) | null = null;
function startPick(label: string, cb: (p: Vector3) => void): void {
  pickCb = cb;
  $('pickMsg').textContent = '⌖ Click on the scan: ' + label + '  (H hides the model · Esc cancels)';
  $('pickMsg').style.display = 'block';
  $('stage').classList.add('picking');
}
function endPick(): void {
  pickCb = null;
  $('pickMsg').style.display = 'none';
  $('stage').classList.remove('picking');
}
let downAt: { x: number; y: number } | null = null;
scene.canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
scene.canvas.addEventListener('pointerup', (e) => {
  if (!pickCb || !downAt) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;  // was an orbit drag
  const r = scene.canvas.getBoundingClientRect();
  const ndc = new Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1,
  );
  const p = scan.pick(ndc, scene.cam);
  if (!p) { $('pickMsg').textContent = '⌖ missed the scan — click again  (Esc cancels)'; return; }
  const cb = pickCb;
  pickCb = null;
  cb(p);           // may chain into the next wizard step via startPick
  if (!pickCb) endPick();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pickCb) {
    alignPicks = [];
    endPick();
    cancelWizard();
    scan.clearMarkers();
    scene.render();
  }
  const t = e.target as HTMLElement;
  if (e.key.toLowerCase() === 's' && pickCb
    && t?.tagName !== 'INPUT' && t?.tagName !== 'SELECT' && t?.tagName !== 'TEXTAREA') {
    wizardSkip();
  }
});

let alignPicks: Vector3[] = [];
function alignWizard(): void {
  if (!scan.loaded) return;
  alignPicks = [];
  scan.clearMarkers();
  // all five references are chassis-fixed — a drooped, wheels-off scan on
  // stands aligns exactly the same as one at ride height
  const labels = [
    'LEFT lower arm — FRONT chassis pivot',
    'LEFT lower arm — REAR chassis pivot',
    'RIGHT lower arm — FRONT chassis pivot',
    'RIGHT lower arm — REAR chassis pivot',
    'either hub / spindle snout center (sets the axle station)',
  ];
  const next = (): void => {
    if (alignPicks.length < 5) {
      startPick(labels[alignPicks.length], (p) => {
        alignPicks.push(p);
        scan.addMarker(p);
        scene.render();
        next();
      });
    } else {
      const picks: ChassisPicks = {
        lf: alignPicks[0], lr: alignPicks[1],
        rf: alignPicks[2], rr: alignPicks[3],
        hub: alignPicks[4],
      };
      const actual = parseFloat(($('scanScaleActual') as HTMLInputElement).value);
      const units = ($('scanUnits') as HTMLSelectElement).value as ScanUnits;
      const hIn = parseFloat(($('scanPivotH') as HTMLInputElement).value);
      const pivotHeightIn = isFinite(hIn) ? hIn : front.chassis.sides.R.lowerFront[2];
      const res = scan.applyChassisAlignment(picks, {
        pivotHeightIn,
        ...(isFinite(actual) && actual > 0
          ? { actualFrontSpanIn: actual }
          : { unitToInches: UNIT_TO_INCHES[units] }),
      });
      alignPicks = [];
      // the four picked pivots ARE measurements — fill them in
      setFrontPoint(front, 'chassis.sides.L.lowerFront', res.pivots.lf);
      setFrontPoint(front, 'chassis.sides.L.lowerRear', res.pivots.lr);
      setFrontPoint(front, 'chassis.sides.R.lowerFront', res.pivots.rf);
      setFrontPoint(front, 'chassis.sides.R.lowerRear', res.pivots.rr);
      $('scanStatus').style.color = 'var(--good)';
      $('scanStatus').textContent =
        `aligned ✓ — LF↔RF pivot span ${res.frontSpanIn.toFixed(2)}" · lower pivots filled in · ${scan.info}`;
      scene.resetView();
      rebuildForm();
      rebuild();
    }
  };
  next();
}

function scanNote(msg: string): void {
  $('scanStatus').style.color = 'var(--bad)';
  $('scanStatus').textContent = msg;
  // also flash it in the viewport — the scan card may be scrolled away
  const pm = $('pickMsg');
  pm.textContent = '⌖ ' + msg;
  pm.style.display = 'block';
  setTimeout(() => { if (!pickCb) pm.style.display = 'none'; }, 3000);
}
$('scanLoad').addEventListener('click', () => $('scanFile').click());
$('scanFile').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  $('scanStatus').style.color = 'var(--dim)';
  $('scanStatus').textContent = `loading ${f.name} (${(f.size / 1e6).toFixed(0)} MB)…`;
  try {
    await scan.load(f);
    ($('scanAlign') as HTMLButtonElement).disabled = false;
    ($('scanMeasure') as HTMLButtonElement).disabled = false;
    $('scanScaleRow').style.display = 'flex';
    const hEl = $('scanPivotH') as HTMLInputElement;
    if (!hEl.value) hEl.value = String(front.chassis.sides.R.lowerFront[2]);
    $('scanStatus').style.color = scan.aligned ? 'var(--good)' : 'var(--dim)';
    $('scanStatus').textContent = scan.info
      + (scan.aligned ? ' — stored alignment applied ✓' : ' — now Align scan');
    scan.setOpacity(+($('scanOpacity') as HTMLInputElement).value);
    update();
  } catch (err) {
    scanNote('load failed: ' + (err as Error).message);
  }
});
$('scanAlign').addEventListener('click', alignWizard);
$('scanMeasure').addEventListener('click', measureWizard);
$('scanOpacity').addEventListener('input', () => {
  scan.setOpacity(+($('scanOpacity') as HTMLInputElement).value);
  scene.render();
});
$('scanVisible').addEventListener('change', () => {
  scan.group.visible = ($('scanVisible') as HTMLInputElement).checked;
  scene.render();
});
$('scanClear').addEventListener('click', () => {
  scan.clear();
  ($('scanAlign') as HTMLButtonElement).disabled = true;
  ($('scanMeasure') as HTMLButtonElement).disabled = true;
  $('scanScaleRow').style.display = 'none';
  $('scanStatus').textContent = '';
  scene.render();
});

/* ---------------- scan measurement recipes ---------------- */
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const distTo = (t: [number, number, number], p: Vector3) =>
  Math.hypot(t[0] - p.x, t[1] - p.y, t[2] - p.z);

function pickDone(p: Vector3): void {
  scan.addMarker(p, 0x46d18a);
  setTimeout(() => { scan.clearMarkers(); scene.render(); }, 2500);
  rebuildForm();
  rebuild();
}

/** All recipes measure rigid part geometry, so a full-droop scan is exact —
 *  see armPickLengths for the one caveat (out-of-plane drop comes from the
 *  part card, not the scan). */
function handlePickReq(req: PickRequest): void {
  if (!scan.loaded) { scanNote('load a 3D scan first (scan card, bottom left)'); return; }
  if (!scan.aligned) { scanNote('align the scan first — Align scan button'); return; }
  const side = req.side ?? 'R';
  const corner = front.corners[side];
  const cs = front.chassis.sides[side];
  switch (req.kind) {
    case 'point':
      startPick(req.label, (p) => {
        setFrontPoint(front, req.path, [r3(p.x), r3(p.y), r3(p.z)]);
        pickDone(p);
      });
      break;
    case 'two':
      startPick(req.label + ' — FIRST point', (p1) => {
        scan.addMarker(p1, 0x36c2ff);
        scene.render();
        startPick(req.label + ' — SECOND point', (p2) => {
          setFrontValue(front, req.path, r3(p1.distanceTo(p2)));
          pickDone(p2);
        });
      });
      break;
    case 'ubj':   // one click on the UBJ ball center fills BOTH heim legs
      startPick(`${side} upper ball joint center`, (p) => {
        const c = setup.corners[side];
        const ua = corner.upperArm;
        ua.legFront.baseLength = r3(distTo(cs.upperFront, p) - c.heimTurnsFront / ua.legFront.heimPitchTPI);
        ua.legRear.baseLength = r3(distTo(cs.upperRear, p) - c.heimTurnsRear / ua.legRear.heimPitchTPI);
        pickDone(p);
      });
      break;
    case 'tro': { // tie rod is a rigid link; inner end is chassis-mounted
      const tri = side === 'R' ? front.chassis.idler.armEnd : front.chassis.steeringBox.pitmanEnd;
      startPick(`${side} tie rod OUTER end (steering arm ball)`, (p) => {
        const c = setup.corners[side];
        const tr = corner.tieRod;
        tr.baseLength = r3(distTo(tri, p) - (c.tieRodTurns * (tr.endsThreaded ?? 2)) / tr.sleevePitchTPI);
        pickDone(p);
      });
      break;
    }
    case 'lbj':   // axial + radius are pose-independent; drop from the card
      startPick(`${side} LOWER ball joint center`, (p) => {
        const { axial, radial } = armPickLengths(cs, [p.x, p.y, p.z], corner.lowerArm.bjDrop);
        corner.lowerArm.bjAxial = r3(axial);
        corner.lowerArm.length = r3(radial);
        pickDone(p);
      });
      break;
    case 'shockseat':
      startPick(`${side} shock LOWER seat on the arm`, (p) => {
        const { axial, radial } = armPickLengths(cs, [p.x, p.y, p.z], corner.lowerArm.shockSeat.drop);
        corner.lowerArm.shockSeat.axial = r3(axial);
        corner.lowerArm.shockSeat.radial = r3(radial);
        pickDone(p);
      });
      break;
    case 'spindle':
      // 4 clicks measure the whole corner: the spindle's rigid geometry is
      // stored in its kingpin frame built from the picked LBJ/UBJ, so the
      // drooped pose doesn't matter (droop toe twists it by <1° — the pin
      // AXIS still comes from camber/toe calibration afterward)
      startPick(`${side} spindle 1/4 — LOWER ball joint center`, (lbj) => {
        scan.addMarker(lbj, 0x36c2ff); scene.render();
        startPick(`${side} spindle 2/4 — UPPER ball joint center`, (ubj) => {
          scan.addMarker(ubj, 0x36c2ff); scene.render();
          startPick(`${side} spindle 3/4 — tie rod OUTER ball center`, (tro) => {
            scan.addMarker(tro, 0x36c2ff); scene.render();
            startPick(`${side} spindle 4/4 — hub FACE center`, (hub) => {
              applySpindleAndArms(side, lbj, ubj, tro, hub);
              pickDone(hub);
            });
          });
        });
      });
      break;
  }
}

/** Fold the four spindle picks into the parts: spindle rigid geometry plus
 *  the lower arm, both upper legs, and the tie rod (the same physical points
 *  measure all of them). */
function applySpindleAndArms(side: Side, lbj: Vector3, ubj: Vector3, tro: Vector3, hub: Vector3): void {
  const corner = front.corners[side];
  const cs = front.chassis.sides[side];
  const kf = kingpinFrame(coreV(lbj.x, lbj.y, lbj.z), coreV(ubj.x, ubj.y, ubj.z), side);
  const spindle = corner.spindle;
  spindle.height = r3(lbj.distanceTo(ubj));
  spindle.calibrated = {
    ...spindle.calibrated,               // keep a calibrated pin axis if there is one
    wcLocal: undefined,                  // hub face + wheel offset now governs
    hubFaceLocal: toKingpinLocal(kf, coreV(hub.x, hub.y, hub.z)).map(r3) as [number, number, number],
    troLocal: toKingpinLocal(kf, coreV(tro.x, tro.y, tro.z)).map(r3) as [number, number, number],
  };
  const lower = armPickLengths(cs, [lbj.x, lbj.y, lbj.z], corner.lowerArm.bjDrop);
  corner.lowerArm.bjAxial = r3(lower.axial);
  corner.lowerArm.length = r3(lower.radial);
  const c = setup.corners[side];
  const ua = corner.upperArm;
  ua.legFront.baseLength = r3(distTo(cs.upperFront, ubj) - c.heimTurnsFront / ua.legFront.heimPitchTPI);
  ua.legRear.baseLength = r3(distTo(cs.upperRear, ubj) - c.heimTurnsRear / ua.legRear.heimPitchTPI);
  const tri = side === 'R' ? front.chassis.idler.armEnd : front.chassis.steeringBox.pitmanEnd;
  const tr = corner.tieRod;
  tr.baseLength = r3(distTo(tri, tro) - (c.tieRodTurns * (tr.endsThreaded ?? 2)) / tr.sleevePitchTPI);
}

/* ---------------- whole-car guided measure ----------------
 * The one process: import -> align -> click every chassis piece. Nothing
 * assembles until the LAST click, so half-measured states can never throw
 * "spindle unreachable" at you mid-stream. */
let wizardRestore: string | null = null;

function measureWizard(): void {
  if (!scan.loaded) { scanNote('load a 3D scan first (scan card, bottom left)'); return; }
  wizardRestore = JSON.stringify(front);
  scan.clearMarkers();

  interface WStep { label: string; apply: (p: Vector3) => void; skippable: boolean }
  const steps: WStep[] = [];
  const pt = (label: string, path: string, skippable = true) =>
    steps.push({
      label, skippable,
      apply: (p) => setFrontPoint(front, path, [r3(p.x), r3(p.y), r3(p.z)]),
    });

  // 1) alignment — the four lower pivots + a hub (fills the pivots too)
  const aPicks: Vector3[] = [];
  const alignLabels = [
    'align: LEFT lower arm FRONT pivot',
    'align: LEFT lower arm REAR pivot',
    'align: RIGHT lower arm FRONT pivot',
    'align: RIGHT lower arm REAR pivot',
    'align: either hub / spindle snout center',
  ];
  alignLabels.forEach((label, i) => steps.push({
    label,
    skippable: false,
    apply: (p) => {
      aPicks.push(p);
      if (i < 4) return;
      const actual = parseFloat(($('scanScaleActual') as HTMLInputElement).value);
      const units = ($('scanUnits') as HTMLSelectElement).value as ScanUnits;
      const hIn = parseFloat(($('scanPivotH') as HTMLInputElement).value);
      const res = scan.applyChassisAlignment(
        { lf: aPicks[0], lr: aPicks[1], rf: aPicks[2], rr: aPicks[3], hub: aPicks[4] },
        {
          pivotHeightIn: isFinite(hIn) ? hIn : front.chassis.sides.R.lowerFront[2],
          ...(isFinite(actual) && actual > 0
            ? { actualFrontSpanIn: actual }
            : { unitToInches: UNIT_TO_INCHES[units] }),
        },
      );
      setFrontPoint(front, 'chassis.sides.L.lowerFront', res.pivots.lf);
      setFrontPoint(front, 'chassis.sides.L.lowerRear', res.pivots.lr);
      setFrontPoint(front, 'chassis.sides.R.lowerFront', res.pivots.rf);
      setFrontPoint(front, 'chassis.sides.R.lowerRear', res.pivots.rr);
      scene.resetView();
    },
  }));

  // 2) steering linkage (center the steering in the scan if you can)
  pt('steering: pitman PIVOT (box output shaft)', 'chassis.steeringBox.pivot');
  pt('steering: pitman ARM END (center link left)', 'chassis.steeringBox.pitmanEnd');
  pt('steering: idler PIVOT', 'chassis.idler.pivot');
  pt('steering: idler ARM END (center link right)', 'chassis.idler.armEnd');

  // 3) each corner: chassis mounts, then the spindle stack
  (['R', 'L'] as Side[]).forEach((side) => {
    const S = side === 'R' ? 'RIGHT' : 'LEFT';
    pt(`${S}: upper heim mount — FRONT`, `chassis.sides.${side}.upperFront`, false);
    pt(`${S}: upper heim mount — REAR`, `chassis.sides.${side}.upperRear`, false);
    pt(`${S}: shock CHASSIS mount`, `chassis.sides.${side}.shockMountUpper`);
    const sp: Vector3[] = [];
    const grab = (label: string, last = false) => steps.push({
      label, skippable: false,
      apply: (p) => {
        sp.push(p);
        if (last) applySpindleAndArms(side, sp[0], sp[1], sp[2], sp[3]);
      },
    });
    grab(`${S}: LOWER ball joint center`);
    grab(`${S}: UPPER ball joint center`);
    grab(`${S}: tie rod OUTER ball center`);
    grab(`${S}: hub FACE center`, true);
    steps.push({
      label: `${S}: shock LOWER seat on the arm`,
      skippable: true,
      apply: (p) => {
        const la = front.corners[side].lowerArm;
        const seat = armPickLengths(front.chassis.sides[side], [p.x, p.y, p.z], la.shockSeat.drop);
        la.shockSeat.axial = r3(seat.axial);
        la.shockSeat.radial = r3(seat.radial);
      },
    });
  });

  let idx = 0;
  const runNext = (): void => {
    if (idx >= steps.length) { finishWizard(); return; }
    const s = steps[idx];
    startPick(
      `[${idx + 1}/${steps.length}] ${s.label}` + (s.skippable ? '  ·  S skips' : ''),
      (p) => {
        scan.addMarker(p, 0x46d18a);
        scene.render();
        s.apply(p);
        idx += 1;
        runNext();
      },
    );
  };
  wizardSkip = () => {
    if (wizardRestore && steps[idx]?.skippable) { idx += 1; runNext(); }
  };
  runNext();
}

let wizardSkip: () => void = () => {};

function finishWizard(): void {
  wizardRestore = null;
  endPick();
  rebuildForm();
  syncAdjInputs();
  rebuild();                      // FIRST assembly of the measured car
  if ($('asmErr').style.display !== 'block') {
    captureBaseline();
    update();
    $('scanStatus').style.color = 'var(--good)';
    $('scanStatus').textContent = 'car measured from scan ✓ — now enter gauge camber/toe and Calibrate spindles';
  }
  setTimeout(() => { scan.clearMarkers(); scene.render(); }, 4000);
}

function cancelWizard(): void {
  if (!wizardRestore) return;
  front = JSON.parse(wizardRestore) as FrontEnd;
  wizardRestore = null;
  scan.clearMarkers();
  rebuildForm();
  syncAdjInputs();
  rebuild();
}

/* ---------------- parts form ---------------- */
function rebuildForm(): void {
  buildPartsForm($('hpForm'), { front, setup }, () => { rebuildForm(); rebuild(); }, handlePickReq);
}
$('hpMirror').addEventListener('click', () => {
  const mirror = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
  const R = front.chassis.sides.R;
  front.chassis.sides.L = mirror(R);
  (Object.keys(front.chassis.sides.L) as (keyof typeof R)[]).forEach((k) => {
    front.chassis.sides.L[k] = [R[k][0], -R[k][1], R[k][2]];
  });
  front.corners.L = mirror(front.corners.R);   // part specs are side-symmetric
  setup.corners.L = mirror(setup.corners.R);
  setup.measured.L = mirror(setup.measured.R);
  rebuildForm(); syncAdjInputs(); rebuild();
});
$('hpReset').addEventListener('click', () => {
  localStorage.removeItem(AUTOSAVE_KEY);
  ({ front, setup } = defaultState());
  rebuildForm(); syncAdjInputs(); rebuild(); captureBaseline(); update();
});

/* ---------------- save / load ---------------- */
$('hpSave').addEventListener('click', () => {
  const ui = {
    mode,
    lock: ($('lock') as HTMLInputElement).checked,
    travL: +($('travL') as HTMLInputElement).value,
    travR: +($('travR') as HTMLInputElement).value,
    steer: +($('steer') as HTMLInputElement).value,
  };
  const blob = new Blob([serializeState(front, setup, ui)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'clr-suspension-setup.json';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 150);
});
$('hpLoad').addEventListener('click', () => $('loadFile').click());
$('loadFile').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const loaded = loadStateJSON(String(r.result));
      front = loaded.front; setup = loaded.setup;
      const ui = loaded.ui as Record<string, number | boolean | string> | undefined;
      if (ui) {
        if (typeof ui.travL === 'number') ($('travL') as HTMLInputElement).value = String(ui.travL);
        if (typeof ui.travR === 'number') ($('travR') as HTMLInputElement).value = String(ui.travR);
        if (typeof ui.steer === 'number') ($('steer') as HTMLInputElement).value = String(ui.steer);
      }
      $('hpErr').textContent = '';
      rebuildForm(); syncAdjInputs(); rebuild(); captureBaseline(); update();
    } catch (err) {
      $('hpErr').textContent = 'Load error: ' + (err as Error).message;
    }
  };
  r.readAsText(f);
  (e.target as HTMLInputElement).value = '';
});

window.addEventListener('resize', () => { scene.resize(); update(); });

/* boot: restore the auto-saved car if there is one */
try {
  const saved = localStorage.getItem(AUTOSAVE_KEY);
  if (saved) {
    const loaded = loadStateJSON(saved);
    front = loaded.front;
    setup = loaded.setup;
  }
} catch { localStorage.removeItem(AUTOSAVE_KEY); }
rebuildForm();
syncAdjInputs();
rebuild();
captureBaseline();

// testing/sharing hook: apply adjustments from the URL after the baseline is
// captured, e.g. ?hfR=6&lioL=0.4 (heim/slug key + side, value in turns/in)
const qp = new URLSearchParams(location.search);
let qpTouched = false;
qp.forEach((val, key) => {
  const km = key.match(/^(hf|hr|tie|uio|uud|ucs|lio|lud)(R|L)$/);
  const v = parseFloat(val);
  if (!km || !isFinite(v)) return;
  const c = setup.corners[km[2] as Side];
  if (km[1] === 'hf') c.heimTurnsFront = v;
  else if (km[1] === 'hr') c.heimTurnsRear = v;
  else if (km[1] === 'tie') c.tieRodTurns = v;
  else c.slugs[km[1] as keyof typeof c.slugs] = v;
  qpTouched = true;
});
if (qpTouched) { syncAdjInputs(); rebuild(); }

update();
