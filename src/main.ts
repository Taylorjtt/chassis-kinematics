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
import { defaultState, loadStateJSON, serializeState } from './state/setup';
import { Scene3D } from './ui/scene3d';
import { chartMulti, seriesRange } from './ui/charts';
import { drawFrontView } from './ui/frontview';
import { buildPartsForm } from './ui/panels';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number, d: number) => (n >= 0 ? '+' : '') + n.toFixed(d);

/* ---------------- state ---------------- */
let { front, setup } = defaultState() as { front: FrontEnd; setup: Setup };
let fa: FrontAssembly | null = null;
let sweep: SweepData | null = null;
let mode: TravelMode = 'wheel';

const scene = new Scene3D($('scene'));

function rebuild(): void {
  try {
    fa = assembleFront(front, setup);
    sweep = computeSweep(fa);
    $('asmErr').style.display = 'none';
  } catch (err) {
    // keep the last good assembly on screen so the user can back out
    $('asmErr').textContent = 'ASSEMBLY: ' + (err as Error).message;
    $('asmErr').style.display = 'block';
  }
  scene.clearTrail();
  syncLegLengths();
  updateDeltas();
  update();
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
    construct: on('tConstruct'), trail: on('tTrail'), spring: on('tSpring'),
    wire: on('tWire'), ghost: on('tGhost'),
  };
}

/* ---------------- baseline ghost + deltas ----------------
 * Real wrench moves change the geometry by hundredths of an inch — correct,
 * but invisible at model scale. Snapshot a baseline, draw it as a dashed
 * ghost, and report the alignment deltas right where you wrench. */
let baseline: FrontAssembly | null = null;
function captureBaseline(): void {
  if (!fa) return;
  baseline = fa;
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

function drawCharts(m: FrontState): void {
  if (!sweep) return;
  const gd = setup.toeGaugeDia;
  const tv = sweep.trav;
  chartMulti($('chCamb') as HTMLCanvasElement, tv, [
    { ys: sweep.cambR, color: '#ff6a1f', markerX: m.wtR },
    { ys: sweep.cambL, color: '#36c2ff', markerX: m.wtL },
  ]);
  chartMulti($('chToe') as HTMLCanvasElement, tv, [
    { ys: sweep.toeR.map((d) => toeInches(d, gd)), color: '#ff6a1f', markerX: m.wtR },
    { ys: sweep.toeL.map((d) => toeInches(d, gd)), color: '#36c2ff', markerX: m.wtL },
  ]);
  chartMulti($('chRc') as HTMLCanvasElement, tv, [
    { ys: sweep.rcz, color: '#ffd23f', markerX: (m.wtR + m.wtL) / 2 },
  ]);
  $('cCamb').textContent = 'R ' + seriesRange(sweep.cambR).toFixed(2) + '° / L ' + seriesRange(sweep.cambL).toFixed(2) + '°';
  $('cToe').textContent = 'R ' + seriesRange(sweep.toeR.map((d) => toeInches(d, gd))).toFixed(3) + '" / L '
    + seriesRange(sweep.toeL.map((d) => toeInches(d, gd))).toFixed(3) + '"';
  $('cRc').textContent = seriesRange(sweep.rcz).toFixed(2) + '" travel';
}

/* ---------------- IDE-style splitters ---------------- */
interface Layout { rightW: number; bottomH: number; ctrlF: number }
const LAYOUT_KEY = 'clrLayout2';
const layout: Layout = {
  rightW: 500, bottomH: 440, ctrlF: 0.55,
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
['tConstruct', 'tTrail', 'tSpring', 'tWire', 'tFront', 'tGhost'].forEach((id) => {
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

/* ---------------- parts form ---------------- */
function rebuildForm(): void {
  buildPartsForm($('hpForm'), { front, setup }, () => { rebuildForm(); rebuild(); });
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

/* boot */
rebuildForm();
syncAdjInputs();
rebuild();
captureBaseline();
update();
