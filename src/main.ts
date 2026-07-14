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
import { chartMulti } from './ui/charts';
import { drawFrontView } from './ui/frontview';
import {
  BJKind, PartId, PART_HAS_SIDE, PickRequest, getFrontPoint, getSolvedBJ, refreshBJFields,
  renderPartEditor, setFrontPoint, setFrontValue,
} from './ui/panels';
import { UIState, defaultUIState, loadUIState, saveUIState } from './ui/uiState';
import type { Bundle, LapFrames, SensorMapping } from './ui/telemetry/bundle';
import { resolveMapping } from './ui/telemetry/mapping';
import {
  ReplayUIState, buildReplayRailHTML, renderReplayRail, tickReplayUI, wireReplayRail,
} from './ui/telemetry/replayUI';
import { Engine, createEngine } from './ui/telemetry/replayEngine';
import { armPickLengths } from './state/setup';
import {
  AssemblyError, cornerDiagnostics, fitUpperLegsToSpindle, kingpinFrame, toKingpinLocal,
} from './core/assembly';
import { V as coreV } from './core/math';
import { ChassisPicks, ScanManager, ScanUnits, UNIT_TO_INCHES } from './ui/scan';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number, d: number) => (n >= 0 ? '+' : '') + n.toFixed(d);

/* ---------------- state ---------------- */
let { front, setup } = defaultState() as { front: FrontEnd; setup: Setup };
let fa: FrontAssembly | null = null;
let sweep: SweepData | null = null;
let mode: TravelMode = 'wheel';
let lastState: FrontState | null = null;   // latest solve, follows the sliders

const scene = new Scene3D($('scene'));

const AUTOSAVE_KEY = 'clrAutosave';
let fixingArms = false;
let lastGoodState: string | null = null;   // for "undo the change"

function rebuild(): void {
  // ALWAYS persist — 10 minutes of scan picks must survive a reload even if
  // the state doesn't assemble yet
  try { localStorage.setItem(AUTOSAVE_KEY, serializeState(front, setup)); } catch { /* storage full */ }
  try {
    fa = assembleFront(front, setup);
    sweep = computeSweep(fa);
    lastGoodState = serializeState(front, setup);
    $('asmErr').style.display = 'none';
    scene.setDiagnostic(null);
  } catch (err) {
    if (!fixingArms && err instanceof AssemblyError && err.armFixable && err.side && offerArmFix(err)) {
      return;   // handled: either legs were fitted + rebuilt, or state reverted
    }
    showAssemblyFailure(err as Error);
  }
  scene.clearTrail();
  syncLegLengths();
  updateDeltas();
  update();
}

/** Failure = diagnosis, not a dead end: red skeleton of the measured
 *  geometry in the scene + the exact numbers in the banner. */
function showAssemblyFailure(err: Error): void {
  const diags = (['R', 'L'] as Side[]).map((s) =>
    cornerDiagnostics(front.chassis, front.corners[s], setup, s));
  scene.setDiagnostic(diags);
  const lines = diags.filter((d) => !d.ok).map((d) =>
    `${d.side}: ${d.error} · legs ${d.legFront.toFixed(2)}"/${d.legRear.toFixed(2)}"`);
  $('asmErr').innerHTML =
    'ASSEMBLY: ' + (err as Error).message
    + (lines.length ? '<br>' + lines.join('<br>') : '')
    + '<br>red skeleton = your measured geometry · re-pick the odd point with its ⌖ button (no need to redo the wizard)';
  $('asmErr').style.display = 'block';
}

/**
 * A measured spindle the current upper arm can't reach is a real shop
 * situation — the fix on the car is turning the heims. Offer exactly that:
 * OK = smallest equal change to both upper leg lengths that assembles the
 * CORNER (searched in core, ±6"), Cancel = undo back to the last good state.
 */
function offerArmFix(err: AssemblyError): boolean {
  const side = err.side!;
  const diag = cornerDiagnostics(front.chassis, front.corners[side], setup, side);
  const ok = window.confirm(
    `${err.message}\n\n`
    + (diag.reachMin !== undefined
      ? `Measured: spindle ${diag.spindleHeight.toFixed(2)}", arms reach ${diag.reachMin.toFixed(2)}"–${diag.reachMax!.toFixed(2)}" `
        + `with legs ${diag.legFront.toFixed(2)}"/${diag.legRear.toFixed(2)}".\n\n`
      : '')
    + `The ${side === 'R' ? 'RIGHT' : 'LEFT'} upper control arm leg lengths will have to change to assemble this spindle.\n\n`
    + 'OK — fit the upper arm legs to the spindle\nCancel — undo the change (measurements stay auto-saved)',
  );
  if (!ok) {
    if (lastGoodState) {
      try {
        const loaded = loadStateJSON(lastGoodState);
        front = loaded.front;
        setup = loaded.setup;
      } catch { /* keep current */ }
    }
    fixingArms = true;
    rebuild(); rebuildEditor(); syncAdjInputs();
    fixingArms = false;
    return true;
  }
  const d = fitUpperLegsToSpindle(front.chassis, front.corners[side], setup, side);
  if (d === null) {
    // even ±6" of heim can't span it — a pick is off; show the diagnosis
    fixingArms = true;
    showAssemblyFailure(err);
    fixingArms = false;
    update();
    return true;
  }
  front.corners[side].upperArm.legFront.baseLength = r3(front.corners[side].upperArm.legFront.baseLength + d);
  front.corners[side].upperArm.legRear.baseLength = r3(front.corners[side].upperArm.legRear.baseLength + d);
  fixingArms = true;   // if something ELSE still fails, show THAT error honestly
  rebuild(); rebuildEditor(); syncAdjInputs();
  fixingArms = false;
  if ($('asmErr').style.display !== 'block') {
    $('asmErr').textContent =
      `ARM FIT: ${side} upper legs ${d > 0 ? 'lengthened' : 'shortened'} ${Math.abs(d).toFixed(2)}" each to reach the spindle — check the part card`;
    $('asmErr').style.display = 'block';
    setTimeout(() => { $('asmErr').style.display = 'none'; }, 8000);
  }
  return true;
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
  const trk = (fa.statL.static!.WC.y - fa.statR.static!.WC.y)
    - (baseline.statL.static!.WC.y - baseline.statR.static!.WC.y);
  el.innerHTML =
    `Δ vs baseline — camber <b>L ${fmt(L.camb, 2)}° R ${fmt(R.camb, 2)}°</b>`
    + ` · caster <b>L ${fmt(L.cast, 2)}° R ${fmt(R.cast, 2)}°</b><br>`
    + `toe <b>L ${fmt(L.toe, 3)}" R ${fmt(R.toe, 3)}"</b>`
    + ` · track <b>${fmt(trk, 3)}"</b>`;
}

function update(): void {
  if (!fa) return;
  const m = solveFrontState(fa, front.chassis.wheelbase, inputs());
  lastState = m;
  scene.update(fa, m, toggles());
  updateHUD(m);
  drawCharts(m);
  // BJ / hub coordinate fields track the current pose (line up with a
  // drooped scan by setting the travel sliders), as does the crosshair
  refreshBJFields({ front, setup, fa, live: () => lastState });
  refreshHighlight();
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
  $('sTrack').textContent = (sL.WC.y - sR.WC.y).toFixed(2) + '"';
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

  // LIVE header readouts: current value at the marker (tracks the travel
  // sliders) + Δ vs the baseline curve AT THE SAME TRAVEL when one is set
  const interp = (xs: number[], ys: number[], x: number): number => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 1;
    while (xs[i] < x) i++;
    const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + f * (ys[i] - ys[i - 1]);
  };
  const CY = '#36c2ff', OR = '#ff6a1f', YL = '#ffd23f';
  const cell = (col: string, cur: string, dlt: string | null) =>
    `<span style="color:${col}">${cur}</span>`
    + (dlt !== null ? `<span style="color:var(--dim)"> Δ${dlt}</span>` : '');
  const pair = (curL: number, curR: number, baseL: number[] | null, baseR: number[] | null, digits: number, unit: string) => {
    const dL = baseL && showBase ? fmt(curL - interp(bs.trav, baseL, m.wtL), digits) : null;
    const dR = baseR && showBase ? fmt(curR - interp(bs.trav, baseR, m.wtR), digits) : null;
    return cell(CY, `L ${fmt(curL, digits)}${unit}`, dL) + ' · ' + cell(OR, `R ${fmt(curR, digits)}${unit}`, dR);
  };
  $('cCamb').innerHTML = pair(m.cL.camber, m.cR.camber, bs?.cambL ?? null, bs?.cambR ?? null, 2, '°');
  const toeRin = sweep.toeR.map((d) => toeInches(d, gd));
  const toeLin = sweep.toeL.map((d) => toeInches(d, gd));
  const bsRateR = gainAt(sweep, toeRin, m.wtR);
  const bsRateL = gainAt(sweep, toeLin, m.wtL);
  $('cToe').innerHTML = pair(
    toeInches(m.cL.toe, gd), toeInches(m.cR.toe, gd),
    bs ? bs.toeL.map((d) => toeInches(d, gd)) : null,
    bs ? bs.toeR.map((d) => toeInches(d, gd)) : null,
    3, '"',
  ) + `<span style="color:var(--dim);margin-left:8px">slope: `
    + `<span style="color:${CY}">L ${fmt(bsRateL, 3)}</span> · `
    + `<span style="color:${OR}">R ${fmt(bsRateR, 3)}</span> "/in</span>`;
  $('cCast').innerHTML = pair(m.cL.casterLive, m.cR.casterLive, bs?.castL ?? null, bs?.castR ?? null, 2, '°');
  const rcCur = m.rc.rc ? m.rc.rc[1] : NaN;
  const rcD = showBase && isFinite(rcCur)
    ? fmt(rcCur - interp(bs.trav, bs.rcz, (m.wtL + m.wtR) / 2), 2) : null;
  $('cRc').innerHTML = isFinite(rcCur)
    ? cell(YL, `${rcCur.toFixed(2)}"`, rcD) : '—';
}

/* ---------------- IDE-style splitters ---------------- */
interface Layout { leftW: number; rightW: number; ctrlF: number }
const LAYOUT_KEY = 'clrLayout4';
const layout: Layout = {
  leftW: 340, rightW: 420, ctrlF: 0.5,
  ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}'),
};
function applyLayout(): void {
  const app = $('app');
  app.style.setProperty('--leftW', layout.leftW + 'px');
  app.style.setProperty('--rightW', layout.rightW + 'px');
  $('paneControls').style.flexGrow = String(Math.round(layout.ctrlF * 100));
  $('paneCharts').style.flexGrow = String(Math.round((1 - layout.ctrlF) * 100));
}
function wireSplitter(id: string, onMove: (e: PointerEvent) => void): void {
  const el = document.getElementById(id);
  if (!el) return;
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
wireSplitter('lsplit', (e) => {
  layout.leftW = Math.min(Math.max(e.clientX, 260), window.innerWidth * 0.5);
});
wireSplitter('vsplit', (e) => {
  layout.rightW = Math.min(Math.max(window.innerWidth - e.clientX, 300), window.innerWidth * 0.5);
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
    // Convention: LEFT wheel is the alignment reference — always calibrate it
    // straight (toe = 0). Any prior L toeIn in the setup is ignored so
    // total toe = R toe, matching how the user aligns the real car.
    setup.measured.L.toeIn = 0;
    (['R', 'L'] as Side[]).forEach((s) => {
      front.corners[s].spindle = calibrateSpindle(
        front, setup, s, setup.measured[s].camberDeg, setup.measured[s].toeIn,
      );
    });
    $('calMsg').textContent = '';
    rebuild(); rebuildEditor();
    $('calMsg').style.color = 'var(--good)';
    $('calMsg').textContent = 'spindles calibrated — L straight, R at your measured toe';
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
  if (!downAt) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;  // was an orbit drag
  const r = scene.canvas.getBoundingClientRect();
  const ndc = new Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1,
  );
  if (pickCb) {
    // scan pick in progress: route the click to the scan mesh
    const p = scan.pick(ndc, scene.cam);
    if (!p) { $('pickMsg').textContent = '⌖ missed the scan — click again  (Esc cancels)'; return; }
    const cb = pickCb;
    pickCb = null;
    cb(p);           // may chain into the next wizard step via startPick
    if (!pickCb) endPick();
    return;
  }
  // no pick queued → try to select a part by clicking its mesh in the scene
  const hit = scene.pickPart({ x: ndc.x, y: ndc.y });
  if (hit) selectPartFromScene(hit.part, hit.side ?? uiState.side);
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
        `aligned ✓ — LF↔RF pivot span ${res.frontSpanIn.toFixed(2)}" · lower pivots filled in`
        + (res.swappedLR ? ' · your L/R picks were mirrored — auto-corrected' : '')
        + ` · ${scan.info}`;
      scene.resetView();
      rebuildEditor();
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

/** The center-link end on a given side of the car — by geometry, not by
 *  pitman/idler naming (the box can be on either side). */
function centerLinkEnd(s: Side): [number, number, number] {
  const pit = front.chassis.steeringBox.pitmanEnd;
  const idl = front.chassis.idler.armEnd;
  const pitmanIsLeft = pit[1] > idl[1];
  return s === 'L' ? (pitmanIsLeft ? pit : idl) : (pitmanIsLeft ? idl : pit);
}

function pickDone(p: Vector3): void {
  scan.addMarker(p, 0x46d18a);
  setTimeout(() => { scan.clearMarkers(); scene.render(); }, 2500);
  rebuild();
  rebuildEditor();
}

/** All recipes measure rigid part geometry, so a full-droop scan is exact —
 *  see armPickLengths for the one caveat (out-of-plane drop comes from the
 *  part card, not the scan). */
/** Facing the car, its left is on YOUR right — humans mislabel sides all the
 *  time, so every side-specific pick is ROUTED by where it actually landed
 *  (y sign), and the label is just a hint. */
function sideOfPick(p: Vector3, intended: Side | null): Side {
  const actual: Side = p.y >= 0 ? 'L' : 'R';   // +y = LEFT (driver side)
  if (intended && actual !== intended) {
    $('scanStatus').style.color = 'var(--good)';
    $('scanStatus').textContent =
      `that pick is on the car's ${actual === 'R' ? 'RIGHT' : 'LEFT'} side — applied there (labels are hints, sides are detected)`;
  }
  return actual;
}

function handlePickReq(req: PickRequest): void {
  if (!scan.loaded) { scanNote('load a 3D scan first (scan card, bottom left)'); return; }
  if (!scan.aligned) { scanNote('align the scan first — Align scan button'); return; }
  const side = req.side ?? 'R';
  switch (req.kind) {
    case 'point':
      startPick(req.label, (p) => {
        let path = req.path;
        if (req.side) {
          const actual = sideOfPick(p, req.side);
          if (actual !== req.side) path = path.replace(`.sides.${req.side}.`, `.sides.${actual}.`);
        }
        setFrontPoint(front, path, [r3(p.x), r3(p.y), r3(p.z)]);
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
        const s = sideOfPick(p, req.side);
        const c = setup.corners[s];
        const ua = front.corners[s].upperArm;
        const cs = front.chassis.sides[s];
        ua.legFront.baseLength = r3(distTo(cs.upperFront, p) - c.heimTurnsFront / ua.legFront.heimPitchTPI);
        ua.legRear.baseLength = r3(distTo(cs.upperRear, p) - c.heimTurnsRear / ua.legRear.heimPitchTPI);
        pickDone(p);
      });
      break;
    case 'tro':   // tie rod is a rigid link; inner end is chassis-mounted
      startPick(`${side} tie rod OUTER end (steering arm ball)`, (p) => {
        const s = sideOfPick(p, req.side);
        const tri = centerLinkEnd(s);
        const c = setup.corners[s];
        const tr = front.corners[s].tieRod;
        tr.baseLength = r3(distTo(tri, p) - (c.tieRodTurns * (tr.endsThreaded ?? 2)) / tr.sleevePitchTPI);
        pickDone(p);
      });
      break;
    case 'lbj':   // axial + radius are pose-independent; drop from the card
      startPick(`${side} LOWER ball joint center`, (p) => {
        const s = sideOfPick(p, req.side);
        const corner = front.corners[s];
        const { axial, radial } = armPickLengths(front.chassis.sides[s], [p.x, p.y, p.z], corner.lowerArm.bjDrop);
        corner.lowerArm.bjAxial = r3(axial);
        corner.lowerArm.length = r3(radial);
        pickDone(p);
      });
      break;
    case 'shockseat':
      startPick(`${side} shock LOWER seat on the arm`, (p) => {
        const s = sideOfPick(p, req.side);
        const la = front.corners[s].lowerArm;
        const seat = armPickLengths(front.chassis.sides[s], [p.x, p.y, p.z], la.shockSeat.drop);
        la.shockSeat.axial = r3(seat.axial);
        la.shockSeat.radial = r3(seat.radial);
        pickDone(p);
      });
      break;
    case 'hubface':
      // single hub pick has no scan-pose ball joints to build the frame from —
      // it uses the LIVE model pose, so overlay the model on the scan first
      startPick(`${side} rotor / hub face center — pose the model onto the scan with the travel sliders first`, (p) => {
        const s = sideOfPick(p, req.side);
        if (!lastState) return;
        const c2 = s === 'R' ? lastState.cR : lastState.cL;
        const kf = kingpinFrame(c2.LBJ, c2.UBJ, s);
        const local = toKingpinLocal(kf, coreV(p.x, p.y, p.z));
        const sp2 = front.corners[s].spindle;
        sp2.calibrated = {
          ...sp2.calibrated,
          wcLocal: undefined,
          hubFaceLocal: [r3(local[0]), r3(local[1]), r3(local[2])],
        };
        pickDone(p);
      });
      break;
    case 'spindle':
      // 4 clicks measure the whole corner: the spindle's rigid geometry is
      // stored in its kingpin frame built from the picked LBJ/UBJ, so the
      // drooped pose doesn't matter (droop toe twists it by <1° — the pin
      // AXIS still comes from camber/toe calibration afterward). Side is
      // detected from the first pick, not the card you clicked.
      startPick(`${side} spindle 1/4 — LOWER ball joint center`, (lbj) => {
        const s = sideOfPick(lbj, req.side);
        scan.addMarker(lbj, 0x36c2ff); scene.render();
        startPick(`${s} spindle 2/4 — UPPER ball joint center`, (ubj) => {
          scan.addMarker(ubj, 0x36c2ff); scene.render();
          startPick(`${s} spindle 3/4 — tie rod OUTER ball center`, (tro) => {
            scan.addMarker(tro, 0x36c2ff); scene.render();
            startPick(`${s} spindle 4/4 — hub FACE center`, (hub) => {
              applySpindleAndArms(s, lbj, ubj, tro, hub);
              pickDone(hub);
            });
          });
        });
      });
      break;
  }
}

/** "Guide me through this part" — mini wizard that runs just the picks
 *  relevant to one part, chained via startPick. Falls back cleanly if a
 *  full-car wizard is already in progress. */
function partWizard(partId: PartId, side: Side | null): void {
  if (wizardRestore) { scanNote('a full-car wizard is running — cancel it first (Esc)'); return; }
  if (!scan.loaded) { scanNote('load a 3D scan first (scan section)'); return; }
  if (!scan.aligned) { scanNote('align the scan first — Measure whole car or Re-align'); return; }
  const s: Side = side ?? uiState.side;
  const picks: Array<() => void> = [];
  const v2t = (pt: Vector3): [number, number, number] => [r3(pt.x), r3(pt.y), r3(pt.z)];
  const push = (label: string, apply: (pt: Vector3) => void) => {
    picks.push(() => startPick(
      `[${picks.length + 0}/${picks.length + 0}] ${label}`,   // placeholder, replaced below
      (pt) => {
        scan.addMarker(pt, 0x46d18a); scene.render();
        apply(pt);
        const next = picks.shift();
        if (next) next();
        else {
          rebuild(); rebuildEditor();
          setTimeout(() => { scan.clearMarkers(); scene.render(); }, 2500);
        }
      },
    ));
  };

  switch (partId) {
    case 'chassis':
      push(`chassis pickup — ${s} LOWER FRONT pivot`, (pt) => setFrontPoint(front, `chassis.sides.${s}.lowerFront`, v2t(pt)));
      push(`chassis pickup — ${s} LOWER REAR pivot`, (pt) => setFrontPoint(front, `chassis.sides.${s}.lowerRear`, v2t(pt)));
      push(`chassis pickup — ${s} UPPER FRONT heim`, (pt) => setFrontPoint(front, `chassis.sides.${s}.upperFront`, v2t(pt)));
      push(`chassis pickup — ${s} UPPER REAR heim`, (pt) => setFrontPoint(front, `chassis.sides.${s}.upperRear`, v2t(pt)));
      break;
    case 'steering':
      push('steering: pitman PIVOT (box output)', (pt) => setFrontPoint(front, 'chassis.steeringBox.pivot', v2t(pt)));
      push('steering: pitman ARM END on center link (vertical-axis joint)', (pt) => setFrontPoint(front, 'chassis.steeringBox.pitmanEnd', v2t(pt)));
      push('steering: idler PIVOT', (pt) => setFrontPoint(front, 'chassis.idler.pivot', v2t(pt)));
      push('steering: idler ARM END on center link (vertical-axis joint)', (pt) => setFrontPoint(front, 'chassis.idler.armEnd', v2t(pt)));
      push('steering: TIE-ROD INNER — pitman side (fore/aft-axis joint on center link)', (pt) => {
        if (!front.chassis.steeringBox.tieRodInner) front.chassis.steeringBox.tieRodInner = [0, 0, 0];
        setFrontPoint(front, 'chassis.steeringBox.tieRodInner', v2t(pt));
      });
      push('steering: TIE-ROD INNER — idler side (fore/aft-axis joint on center link)', (pt) => {
        if (!front.chassis.idler.tieRodInner) front.chassis.idler.tieRodInner = [0, 0, 0];
        setFrontPoint(front, 'chassis.idler.tieRodInner', v2t(pt));
      });
      break;
    case 'lca':
      push(`${s} lower FRONT pivot`, (pt) => setFrontPoint(front, `chassis.sides.${s}.lowerFront`, v2t(pt)));
      push(`${s} lower REAR pivot`, (pt) => setFrontPoint(front, `chassis.sides.${s}.lowerRear`, v2t(pt)));
      push(`${s} LOWER ball joint center`, (pt) => {
        const c = front.corners[s];
        const { axial, radial } = armPickLengths(front.chassis.sides[s], [pt.x, pt.y, pt.z], c.lowerArm.bjDrop);
        c.lowerArm.bjAxial = r3(axial);
        c.lowerArm.length = r3(radial);
      });
      break;
    case 'uca':
      push(`${s} upper FRONT heim mount`, (pt) => setFrontPoint(front, `chassis.sides.${s}.upperFront`, v2t(pt)));
      push(`${s} upper REAR heim mount`, (pt) => setFrontPoint(front, `chassis.sides.${s}.upperRear`, v2t(pt)));
      push(`${s} UPPER ball joint center`, (pt) => {
        const c = setup.corners[s];
        const ua = front.corners[s].upperArm;
        const cs = front.chassis.sides[s];
        ua.legFront.baseLength = r3(distTo(cs.upperFront, pt) - c.heimTurnsFront / ua.legFront.heimPitchTPI);
        ua.legRear.baseLength = r3(distTo(cs.upperRear, pt) - c.heimTurnsRear / ua.legRear.heimPitchTPI);
      });
      break;
    case 'spindle':
      handlePickReq({ kind: 'spindle', path: '', side: s, label: `${s} spindle 4-click` });
      return;
    case 'tieRod':
      handlePickReq({ kind: 'tro', path: `corners.${s}.tieRod.baseLength`, side: s, label: `${s} tie rod outer` });
      return;
    case 'shock':
      push(`${s} shock CHASSIS mount (frame)`, (pt) => setFrontPoint(front, `chassis.sides.${s}.shockMountUpper`, v2t(pt)));
      push(`${s} shock LOWER seat on the arm`, (pt) => {
        const la = front.corners[s].lowerArm;
        const seat = armPickLengths(front.chassis.sides[s], [pt.x, pt.y, pt.z], la.shockSeat.drop);
        la.shockSeat.axial = r3(seat.axial);
        la.shockSeat.radial = r3(seat.radial);
      });
      break;
    case 'wheel':
      // hub face uses live pose — user should overlay the model onto the scan first
      handlePickReq({ kind: 'hubface', path: '', side: s, label: `${s} hub face center` });
      return;
  }
  const first = picks.shift();
  if (first) first();
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
  const tri = centerLinkEnd(side);
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
      if (res.swappedLR) {
        // the rest of the wizard says LEFT/RIGHT — warn that we corrected
        $('scanStatus').style.color = 'var(--good)';
        $('scanStatus').textContent = 'heads up: your L/R picks were mirrored — auto-corrected. LEFT = driver side.';
      }
      // side beacons for the corner steps: ORANGE = car RIGHT, CYAN = LEFT
      (['R', 'L'] as Side[]).forEach((s2) => {
        const cs2 = front.chassis.sides[s2];
        const col = s2 === 'R' ? 0xff6a1f : 0x36c2ff;
        [cs2.lowerFront, cs2.lowerRear].forEach((t) =>
          scan.addMarker(new Vector3(t[0], t[1], t[2]), col));
      });
      scene.resetView();
    },
  }));

  // 2) steering linkage — whichever side your box is on; tie rods attach to
  // the center-link at their OWN joint (separate from the arm end), routed
  // by y-sign, not by pitman/idler naming
  pt('steering: pitman PIVOT (steering box output shaft)', 'chassis.steeringBox.pivot');
  pt('steering: pitman ARM END (arm ball on the center link — vertical-axis joint)', 'chassis.steeringBox.pitmanEnd');
  pt('steering: idler PIVOT', 'chassis.idler.pivot');
  pt('steering: idler ARM END (arm ball on the center link — vertical-axis joint)', 'chassis.idler.armEnd');
  pt('steering: tie-rod INNER on the pitman side (fore/aft-axis joint on the center link)', 'chassis.steeringBox.tieRodInner');
  pt('steering: tie-rod INNER on the idler side (fore/aft-axis joint on the center link)', 'chassis.idler.tieRodInner');

  // 3) each corner: chassis mounts, then the spindle stack.
  // Side is DETECTED from where the picks land (y sign) — facing the car,
  // its left is on YOUR right, so labels are hints, never trusted. All 7
  // structural picks buffer and apply together once the corner's side is
  // known; the beacons (placed at alignment) show which side is which.
  let firstResolved: Side | null = null;
  (['R', 'L'] as Side[]).forEach((intended) => {
    const S = intended === 'R' ? 'RIGHT (orange beacons)' : 'LEFT (cyan beacons)';
    const got: (Vector3 | undefined)[] = [];
    let resolved: Side = intended;
    const v2t = (p: Vector3): [number, number, number] => [r3(p.x), r3(p.y), r3(p.z)];
    const grab = (label: string, idx: number, skippable: boolean, last = false) => steps.push({
      label: `${S}: ${label}`,
      skippable,
      apply: (p) => {
        got[idx] = p;
        if (!last) return;
        const ys = got.filter((q): q is Vector3 => !!q).map((q) => q.y);
        resolved = ys.reduce((a2, b2) => a2 + b2, 0) / ys.length >= 0 ? 'L' : 'R';
        if (resolved !== intended) {
          $('scanStatus').style.color = 'var(--good)';
          $('scanStatus').textContent =
            `your "${intended}" corner landed on the car's ${resolved} side — routed there automatically`;
        }
        if (firstResolved === resolved) {
          $('scanStatus').style.color = 'var(--bad)';
          $('scanStatus').textContent =
            `both corners resolved to the ${resolved} side — one set of picks is on the wrong side`;
        }
        firstResolved = resolved;
        if (got[0]) setFrontPoint(front, `chassis.sides.${resolved}.upperFront`, v2t(got[0]));
        if (got[1]) setFrontPoint(front, `chassis.sides.${resolved}.upperRear`, v2t(got[1]));
        if (got[2]) setFrontPoint(front, `chassis.sides.${resolved}.shockMountUpper`, v2t(got[2]));
        applySpindleAndArms(resolved, got[3]!, got[4]!, got[5]!, got[6]!);
      },
    });
    grab('upper heim mount — FRONT', 0, false);
    grab('upper heim mount — REAR', 1, false);
    grab('shock CHASSIS mount', 2, true);
    grab('LOWER ball joint center', 3, false);
    grab('UPPER ball joint center', 4, false);
    grab('tie rod OUTER ball center', 5, false);
    grab('hub FACE center', 6, false, true);
    steps.push({
      label: `${S}: shock LOWER seat on the arm`,
      skippable: true,
      apply: (p) => {
        const la = front.corners[resolved].lowerArm;
        const seat = armPickLengths(front.chassis.sides[resolved], [p.x, p.y, p.z], la.shockSeat.drop);
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
  rebuildEditor();
  syncAdjInputs();
  rebuild();                      // FIRST assembly of the measured car
  if ($('asmErr').style.display !== 'block') {
    captureBaseline();
    update();
    $('scanStatus').style.color = 'var(--good)';
    $('scanStatus').textContent = 'car measured from scan ✓ — now enter gauge camber/toe and Calibrate spindles';
    setTimeout(() => { scan.clearMarkers(); scene.render(); }, 4000);
  } else {
    // keep the pick markers up next to the red skeleton — that's the diagnosis
    $('scanStatus').style.color = 'var(--bad)';
    $('scanStatus').textContent = 'measured, but a corner won\'t assemble — see the red skeleton; re-pick the odd point (⌖). Everything is saved.';
  }
}

function cancelWizard(): void {
  if (!wizardRestore) return;
  front = JSON.parse(wizardRestore) as FrontEnd;
  wizardRestore = null;
  scan.clearMarkers();
  rebuildEditor();
  syncAdjInputs();
  rebuild();
}

/* ---------------- parts form ---------------- */
let focusedPointPath: string | null = null;

function refreshHighlight(): void {
  let t: [number, number, number] | null = null;
  if (focusedPointPath?.startsWith('bj:')) {
    // virtual path for the BJ/hub editors: position at the CURRENT pose
    const [, s, kind] = focusedPointPath.split(':');
    t = getSolvedBJ({ front, setup, fa, live: () => lastState }, s as Side, kind as BJKind);
  } else if (focusedPointPath) {
    t = getFrontPoint(front, focusedPointPath);
  }
  scene.setHighlight(t ? coreV(t[0], t[1], t[2]) : null);
  scene.render();
}

let uiState: UIState = defaultUIState();

/** Rerender the currently focused part editor into #partEditor and reflect
 *  nav state in the DOM (button highlights, mode attribute). */
function rebuildEditor(): void {
  const host = $('partEditor');
  if (host) {
    renderPartEditor(
      host, { front, setup, fa, live: () => lastState },
      uiState.selectedPart, uiState.side,
      {
        onChange: (structural) => { rebuild(); if (structural) rebuildEditor(); refreshHighlight(); },
        onPick: handlePickReq,
        onFocusPoint: (path) => { focusedPointPath = path; refreshHighlight(); },
        onPartGuide: partWizard,
      },
    );
  }
  syncNavHighlights();
}

function syncNavHighlights(): void {
  document.body.dataset.mode = uiState.mode;
  $('modeSwitch').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.uimode === uiState.mode);
  });
  $('partList').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.part === uiState.selectedPart);
  });
  const sw = $('sideSwitch');
  if (sw) {
    sw.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.uiside === uiState.side);
    });
    // hide L/R toggle for parts that don't care
    const hasSide = uiState.selectedPart ? PART_HAS_SIDE[uiState.selectedPart] : false;
    sw.parentElement!.style.display = hasSide ? '' : 'none';
  }
  // subtle emissive tint on the selected part in the 3D scene
  const part = uiState.selectedPart;
  const side = part && PART_HAS_SIDE[part] ? uiState.side : null;
  scene.setPartHighlight(part, side);
}

/** Public entry for mode / part / side changes — persists + rerenders. */
export function selectPart(partId: PartId): void {
  uiState.selectedPart = partId;
  saveUIState(uiState);
  rebuildEditor();
}
function setMode(m: 'build' | 'tune' | 'replay'): void {
  uiState.mode = m;
  saveUIState(uiState);
  syncNavHighlights();
  // charts pane may have been hidden — re-measure canvases now that they're visible.
  // Applies going into Tune (charts appear) and going into Replay (track map appears).
  scene.resize(); update();
}
function setSide(s: Side): void {
  uiState.side = s;
  saveUIState(uiState);
  rebuildEditor();
}
// Called from 3D click handling (M3).
export function selectPartFromScene(partId: PartId, side: Side): void {
  uiState.selectedPart = partId;
  if (PART_HAS_SIDE[partId]) uiState.side = side;
  saveUIState(uiState);
  rebuildEditor();
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
  rebuild(); rebuildEditor(); syncAdjInputs();
});
$('hpReset').addEventListener('click', () => {
  localStorage.removeItem(AUTOSAVE_KEY);
  ({ front, setup } = defaultState());
  rebuild(); rebuildEditor(); syncAdjInputs(); captureBaseline(); update();
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
      rebuild(); rebuildEditor(); syncAdjInputs(); captureBaseline(); update();
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
uiState = loadUIState();

/* mode switch / part list / side toggle — clicked buttons update uiState */
$('modeSwitch').querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.uimode as 'build' | 'tune' | 'replay')));
$('partList').querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
  b.addEventListener('click', () => selectPart(b.dataset.part as PartId)));
$('sideSwitch').querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
  b.addEventListener('click', () => setSide(b.dataset.uiside as Side)));

/* mobile: floating "☰ Controls" toggles the right dock as a slide-in drawer */
const toggleDrawer = () => {
  const open = document.body.dataset.drawer === 'right';
  if (open) delete document.body.dataset.drawer;
  else document.body.dataset.drawer = 'right';
  scene.resize(); update();
};
$('drawerToggle').addEventListener('click', toggleDrawer);
$('drawerBackdrop').addEventListener('click', toggleDrawer);

/* ---------------- replay mode wiring ---------------- */
const replayState: ReplayUIState = {
  bundle: null,
  selectedLap: null,
  playing: false,
  currentTSec: 0,
  lapDurationSec: 0,
  speedMult: 1,
  loadingMsg: '',
  errorMsg: '',
  rideRefPickSec: null,
};
let currentLapFrames: LapFrames | null = null;
let currentMapping: SensorMapping = {};
let replayEngine: Engine | null = null;
const replayCallbacks = {
  onBundle: (bundle: Bundle) => {
    replayState.bundle = bundle;
    currentMapping = resolveMapping(bundle.sensors);
    replayState.selectedLap = null;
    currentLapFrames = null;
    replayEngine?.destroy();
    replayEngine = null;
    renderReplayRail($('replayRail'), replayState, replayCallbacks);
  },
  onSelectLap: (lapNumber: number) => {
    if (!replayState.bundle) return;
    replayState.selectedLap = lapNumber;
    try {
      currentLapFrames = replayState.bundle.fetchLap(lapNumber, currentMapping);
      replayState.currentTSec = 0;
      replayState.lapDurationSec = currentLapFrames.durationSec;
      replayState.playing = false;
      // create the engine with the new lap's duration
      replayEngine?.destroy();
      replayEngine = createEngine({
        durationSec: currentLapFrames.durationSec,
        onTick: (t) => {
          replayState.currentTSec = t;
          applyFrameAt(t);
          drawLapCharts(t);
          tickReplayUI($('replayRail'), replayState);
        },
        onEnd: () => {
          replayState.playing = false;
          tickReplayUI($('replayRail'), replayState);
        },
      });
      replayEngine.setSpeed(replayState.speedMult);
      computeLapChartData();
      renderReplayRail($('replayRail'), replayState, replayCallbacks);
      applyFrameAt(0);
      drawLapCharts(0);
    } catch (err) {
      replayState.errorMsg = `lap ${lapNumber} failed: ${(err as Error).message}`;
      renderReplayRail($('replayRail'), replayState, replayCallbacks);
    }
  },
  onPlayPause: () => {
    if (!replayEngine) return;
    replayEngine.toggle();
    replayState.playing = replayEngine.isPlaying();
    tickReplayUI($('replayRail'), replayState);
  },
  onSeek: (tSec: number) => {
    replayState.currentTSec = tSec;
    if (replayEngine) replayEngine.seek(tSec);
    else { applyFrameAt(tSec); tickReplayUI($('replayRail'), replayState); }
    drawLapCharts(tSec);
  },
  onSpeedChange: (m: number) => {
    replayState.speedMult = m;
    replayEngine?.setSpeed(m);
  },
  onMappingChange: (m: SensorMapping) => {
    currentMapping = m;
    if (replayState.bundle && replayState.selectedLap !== null) {
      currentLapFrames = replayState.bundle.fetchLap(replayState.selectedLap, currentMapping);
      computeLapChartData();
      applyFrameAt(replayState.currentTSec);
      drawLapCharts(replayState.currentTSec);
    }
  },
  onPickRideRef: (sessionSec: number) => {
    if (!replayState.bundle) return;
    // ±2 s window around the click
    replayState.bundle.setRideRefFromWindow(sessionSec, 2);
    replayState.rideRefPickSec = sessionSec;
    // re-fetch the current lap so shocks are in the new reference frame
    if (replayState.selectedLap !== null) {
      currentLapFrames = replayState.bundle.fetchLap(replayState.selectedLap, currentMapping);
      computeLapChartData();
      applyFrameAt(replayState.currentTSec);
      drawLapCharts(replayState.currentTSec);
    }
    renderReplayRail($('replayRail'), replayState, replayCallbacks);
  },
};
$('replayRail').innerHTML = buildReplayRailHTML();
wireReplayRail($('replayRail'), replayState, replayCallbacks);

/** Pre-computed lap-chart data — evenly-sampled solver output over the lap.
 *  Recomputed on lap select or mapping change; not on every tick (too slow). */
interface LapChartData {
  tSec: number[];
  cambL: number[]; cambR: number[];
  toeLin: number[]; toeRin: number[];
  shockL: number[]; shockR: number[];
  speedMph: number[];
}
let lapChartData: LapChartData | null = null;
const LAP_CHART_SAMPLES = 200;

function computeLapChartData(): void {
  lapChartData = null;
  if (!currentLapFrames || !fa) return;
  const gd = setup.toeGaugeDia;
  const frames = currentLapFrames;
  const dur = frames.durationSec;
  const tSec: number[] = new Array(LAP_CHART_SAMPLES);
  const cambL: number[] = new Array(LAP_CHART_SAMPLES);
  const cambR: number[] = new Array(LAP_CHART_SAMPLES);
  const toeLin: number[] = new Array(LAP_CHART_SAMPLES);
  const toeRin: number[] = new Array(LAP_CHART_SAMPLES);
  const sL: number[] = new Array(LAP_CHART_SAMPLES);
  const sR: number[] = new Array(LAP_CHART_SAMPLES);
  const spdArr: number[] = new Array(LAP_CHART_SAMPLES);
  const lerp = (a: Float32Array, i0: number, i1: number, f: number): number => {
    const v0 = a[i0], v1 = a[i1];
    if (!isFinite(v0)) return isFinite(v1) ? v1 : 0;
    if (!isFinite(v1)) return v0;
    return v0 + f * (v1 - v0);
  };
  for (let i = 0; i < LAP_CHART_SAMPLES; i++) {
    const t = dur * (i / (LAP_CHART_SAMPLES - 1));
    tSec[i] = t;
    const idx = binarySearchLE(frames.tSec, t);
    const i0 = Math.max(0, idx), i1 = Math.min(frames.tSec.length - 1, idx + 1);
    const t0 = frames.tSec[i0], t1 = frames.tSec[i1];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    const travL = lerp(frames.shockL, i0, i1, f);
    const travR = lerp(frames.shockR, i0, i1, f);
    sL[i] = travL; sR[i] = travR;
    try {
      const s = solveFrontState(fa, front.chassis.wheelbase, {
        travL, travR, steerDeg: 0, mode: 'shock',
      });
      cambL[i] = s.cL.camber; cambR[i] = s.cR.camber;
      toeLin[i] = toeInches(s.cL.toe, gd); toeRin[i] = toeInches(s.cR.toe, gd);
    } catch {
      cambL[i] = NaN; cambR[i] = NaN; toeLin[i] = NaN; toeRin[i] = NaN;
    }
    spdArr[i] = lerp(frames.speedMph, i0, i1, f);
  }
  lapChartData = { tSec, cambL, cambR, toeLin, toeRin, shockL: sL, shockR: sR, speedMph: spdArr };
}

function drawLapCharts(currentTSec: number): void {
  if (!lapChartData) return;
  const d = lapChartData;
  const CY = '#36c2ff', OR = '#ff6a1f';
  chartMulti(document.getElementById('rchCamb') as HTMLCanvasElement, d.tSec, [
    { ys: d.cambL, color: CY, markerX: currentTSec },
    { ys: d.cambR, color: OR, markerX: currentTSec },
  ]);
  chartMulti(document.getElementById('rchToe') as HTMLCanvasElement, d.tSec, [
    { ys: d.toeLin, color: CY, markerX: currentTSec },
    { ys: d.toeRin, color: OR, markerX: currentTSec },
  ]);
  chartMulti(document.getElementById('rchShock') as HTMLCanvasElement, d.tSec, [
    { ys: d.shockL, color: CY, markerX: currentTSec },
    { ys: d.shockR, color: OR, markerX: currentTSec },
  ]);
  chartMulti(document.getElementById('rchSpeed') as HTMLCanvasElement, d.tSec, [
    { ys: d.speedMph, color: '#ffd23f', markerX: currentTSec },
  ]);
  const fmtRC = (a: number[]) => {
    const i = Math.max(0, Math.min(a.length - 1,
      Math.round((currentTSec / (d.tSec[d.tSec.length - 1] || 1)) * (a.length - 1))));
    return a[i];
  };
  const nb = (id: string, v: number, digits: number, unit: string) => {
    const el = document.getElementById(id); if (el) el.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${unit}`;
  };
  nb('rCamb', fmtRC(d.cambL), 2, '°');
  nb('rToe', fmtRC(d.toeLin), 3, '"');
  nb('rShock', fmtRC(d.shockL), 3, '"');
  nb('rSpd', fmtRC(d.speedMph), 0, ' mph');
}

/** Apply a single frame of telemetry to the sim: interpolate shock arrays
 *  at tSec and drive `solveFrontState({ mode: 'shock', ... })`. M4 will call
 *  this from the RAF loop; for now it's used on scrub + lap-select. */
function applyFrameAt(tSec: number): void {
  if (!currentLapFrames || !fa) return;
  const { tSec: ts, shockL, shockR, speedMph, lat, lon } = currentLapFrames;
  const idx = binarySearchLE(ts, tSec);
  const i0 = Math.max(0, idx), i1 = Math.min(ts.length - 1, idx + 1);
  const t0 = ts[i0], t1 = ts[i1];
  const f = t1 > t0 ? (tSec - t0) / (t1 - t0) : 0;
  const lerp = (a: Float32Array): number => {
    const v0 = a[i0], v1 = a[i1];
    if (!isFinite(v0)) return isFinite(v1) ? v1 : 0;
    if (!isFinite(v1)) return v0;
    return v0 + f * (v1 - v0);
  };
  const travL = lerp(shockL), travR = lerp(shockR);
  const state = solveFrontState(fa, front.chassis.wheelbase, {
    travL, travR, steerDeg: 0, mode: 'shock',
  });
  lastState = state;
  scene.update(fa, state, toggles());
  updateHUD(state);
  // find last known GPS + speed near tSec
  const spd = findLastFinite(speedMph, i1);
  const speedEl = document.getElementById('speedNum');
  if (speedEl) speedEl.textContent = isFinite(spd) ? spd.toFixed(0) : '—';
  updateTrackMap(lat, lon, speedMph, i1);
}

function binarySearchLE(arr: Float32Array, x: number): number {
  let lo = 0, hi = arr.length - 1;
  if (arr.length === 0 || x <= arr[0]) return 0;
  if (x >= arr[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (arr[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function findLastFinite(arr: Float32Array, endIdx: number): number {
  for (let i = endIdx; i >= 0; i--) if (isFinite(arr[i])) return arr[i];
  return NaN;
}

/** Stub — M5 fleshes this out. Right now just clears/paints a scan-map. */
function updateTrackMap(lat: Float32Array, lon: Float32Array, speedMph: Float32Array, curIdx: number): void {
  const canvas = document.getElementById('trackMapCanvas') as HTMLCanvasElement | null;
  if (!canvas || !currentLapFrames) return;
  const dpr = Math.min(devicePixelRatio, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  // find lat/lon range, ignore NaN
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    if (isFinite(lat[i]) && isFinite(lon[i])) {
      if (lat[i] < minLat) minLat = lat[i]; if (lat[i] > maxLat) maxLat = lat[i];
      if (lon[i] < minLon) minLon = lon[i]; if (lon[i] > maxLon) maxLon = lon[i];
    }
  }
  if (!isFinite(minLat) || minLat === maxLat) return;
  const pad = 8;
  const rngLat = maxLat - minLat, rngLon = maxLon - minLon;
  const scale = Math.min((w - 2 * pad) / rngLon, (h - 2 * pad) / rngLat);
  const cx = (w - rngLon * scale) / 2 - minLon * scale;
  const cy = (h - rngLat * scale) / 2 + maxLat * scale;
  const X = (lo: number) => cx + lo * scale;
  const Y = (la: number) => cy - la * scale;
  // polyline of the whole lap
  g.strokeStyle = '#6b7787'; g.lineWidth = 1.5;
  g.beginPath();
  let started = false;
  for (let i = 0; i < lat.length; i++) {
    if (!isFinite(lat[i])) continue;
    const px = X(lon[i]), py = Y(lat[i]);
    if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
  }
  g.stroke();
  // current position dot
  const li = findLastFiniteIdx(lat, curIdx);
  if (li >= 0) {
    g.fillStyle = '#ff6a1f';
    g.beginPath(); g.arc(X(lon[li]), Y(lat[li]), 5, 0, 7); g.fill();
    g.strokeStyle = '#0d1014'; g.lineWidth = 1.5; g.stroke();
  }
  const title = document.getElementById('trackMapTitle');
  if (title) title.textContent = `TRACK — lap ${replayState.selectedLap ?? '?'}`;
}
function findLastFiniteIdx(arr: Float32Array, endIdx: number): number {
  for (let i = endIdx; i >= 0; i--) if (isFinite(arr[i])) return i;
  return -1;
}

rebuildEditor();
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
