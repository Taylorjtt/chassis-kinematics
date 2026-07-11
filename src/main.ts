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
import { buildPartsForm, setFrontPoint } from './ui/panels';
import { AlignPicks, ScanManager, ScanUnits, UNIT_TO_INCHES } from './ui/scan';

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
    construct: on('tConstruct'), trail: on('tTrail'), shock: on('tShock'),
    wire: on('tWire'), ghost: on('tGhost'),
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
['tConstruct', 'tTrail', 'tShock', 'tWire', 'tFront', 'tGhost'].forEach((id) => {
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
  $('pickMsg').textContent = '⌖ Click on the scan: ' + label + '  (Esc cancels)';
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
    scan.clearMarkers();
    endPick();
    scene.render();
  }
});

let alignPicks: Vector3[] = [];
function alignWizard(): void {
  if (!scan.loaded) return;
  alignPicks = [];
  scan.clearMarkers();
  const labels = [
    'FLOOR point 1 of 3 (spread them out)',
    'FLOOR point 2 of 3',
    'FLOOR point 3 of 3',
    'LEFT hub / spindle center',
    'RIGHT hub / spindle center',
    'any point near the FRONT of the car',
  ];
  const next = (): void => {
    if (alignPicks.length < 6) {
      startPick(labels[alignPicks.length], (p) => {
        alignPicks.push(p);
        scan.addMarker(p);
        scene.render();
        next();
      });
    } else {
      const picks: AlignPicks = {
        ground: alignPicks.slice(0, 3),
        hubL: alignPicks[3], hubR: alignPicks[4], front: alignPicks[5],
      };
      const actual = parseFloat(($('scanScaleActual') as HTMLInputElement).value);
      const units = ($('scanUnits') as HTMLSelectElement).value as ScanUnits;
      const res = scan.applyAlignment(
        picks,
        isFinite(actual) && actual > 0
          ? { actualHubDistIn: actual }
          : { unitToInches: UNIT_TO_INCHES[units] },
      );
      alignPicks = [];
      $('scanStatus').style.color = 'var(--good)';
      $('scanStatus').textContent =
        `aligned ✓ — hub-to-hub ${res.hubDistIn.toFixed(2)}" · ${scan.info}`;
      scene.resetView();
      update();
    }
  };
  next();
}

function scanNote(msg: string): void {
  $('scanStatus').style.color = 'var(--bad)';
  $('scanStatus').textContent = msg;
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
    $('scanScaleRow').style.display = 'flex';
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
  $('scanScaleRow').style.display = 'none';
  $('scanStatus').textContent = '';
  scene.render();
});

/* ---------------- parts form ---------------- */
function rebuildForm(): void {
  buildPartsForm($('hpForm'), { front, setup }, () => { rebuildForm(); rebuild(); }, (path, label) => {
    if (!scan.loaded) { scanNote('load a 3D scan first (scan card, bottom left)'); return; }
    if (!scan.aligned) { scanNote('align the scan first — Align scan button'); return; }
    startPick(label, (p) => {
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      setFrontPoint(front, path, [r3(p.x), r3(p.y), r3(p.z)]);
      scan.addMarker(p, 0x46d18a);
      setTimeout(() => { scan.clearMarkers(); scene.render(); }, 2500);
      rebuildForm();
      rebuild();
    });
  });
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
