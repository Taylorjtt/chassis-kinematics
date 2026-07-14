/*
 * Replay-mode left-rail UI: session loader, sensor mapping, lap picker,
 * playback controls. Wire-up done by main.ts via the callbacks passed here.
 *
 * DOM structure is built once at boot; contents are re-rendered on state
 * changes. Uses vanilla querySelector like the rest of the app.
 */
import type { Bundle, SensorMapping } from './bundle';
import { formatLapTime } from './bundle';
import { currentRole, resolveMapping, saveInvert, saveRole } from './mapping';

export interface ReplayUICallbacks {
  onBundle: (bundle: Bundle) => void;
  onSelectLap: (lapNumber: number) => void;
  onPlayPause: () => void;
  onSeek: (tSec: number) => void;
  onSpeedChange: (mult: number) => void;
  onMappingChange: (mapping: SensorMapping) => void;
  /** User clicked the session speed strip to set ride ref from that moment. */
  onPickRideRef: (sessionSec: number) => void;
}

export interface ReplayUIState {
  bundle: Bundle | null;
  selectedLap: number | null;
  playing: boolean;
  currentTSec: number;
  lapDurationSec: number;
  speedMult: number;
  loadingMsg: string;
  errorMsg: string;
  /** Session-relative seconds where the user picked the ride reference. */
  rideRefPickSec: number | null;
}

export function buildReplayRailHTML(): string {
  return `
    <div class="grp replayLoader">
      <h3>Session bundle</h3>
      <div class="cardhelp">Drop or pick a <code>.zip</code> exported from the
        racing-telemetry app. Everything runs locally — the sim reads the
        bundle's SQLite directly.</div>
      <div class="dropZone" id="replayDrop">
        <div class="dropZoneText">Drop .zip here or click to browse</div>
      </div>
      <input type="file" id="replayFile" accept=".zip" style="display:none">
      <div class="err" id="replayStatus"></div>
    </div>
    <div class="grp replaySession" id="replaySession" style="display:none">
      <h3>Session</h3>
      <div class="sessionSummary" id="sessionSummary"></div>
    </div>
    <div class="grp replayMapping" id="replayMapping" style="display:none">
      <h3>Sensor mapping &amp; ride reference</h3>
      <div class="cardhelp">Which BLE sensor is on which corner? Auto-detected
        from your sensor names — override if wrong. Invert flips sign if the
        sensor reads extension positive instead of compression.</div>
      <div class="rideRefRow" id="rideRefRow"></div>
      <div class="rideRefPickHelp">Click on the speed trace to pick a "car at rest" moment (before the green flag, on pit road, etc.). We'll average shock readings in a ±2 s window.</div>
      <canvas id="sessionSpeedCanvas" class="sessionSpeedCanvas"></canvas>
      <div class="mappingList" id="mappingList"></div>
    </div>
    <div class="grp replayLaps" id="replayLaps" style="display:none">
      <h3>Laps</h3>
      <div class="lapList" id="lapList"></div>
    </div>
    <div class="grp replayPlay" id="replayPlay" style="display:none">
      <h3>Playback</h3>
      <div class="playRow">
        <button class="b primary" id="playPause">▶ Play</button>
        <select id="playSpeed" title="playback speed">
          <option value="0.25">0.25×</option>
          <option value="0.5">0.5×</option>
          <option value="1" selected>1×</option>
          <option value="2">2×</option>
        </select>
      </div>
      <div class="scrubRow">
        <input type="range" id="scrub" min="0" max="100" step="0.01" value="0">
        <div class="scrubTime" id="scrubTime">0.000 / 0.000 s</div>
      </div>
    </div>
  `;
}

export function wireReplayRail(host: HTMLElement, state: ReplayUIState, cbs: ReplayUICallbacks): void {
  const drop = host.querySelector<HTMLDivElement>('#replayDrop')!;
  const fileInput = host.querySelector<HTMLInputElement>('#replayFile')!;
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) loadFile(f);
    fileInput.value = '';
  });

  async function loadFile(file: File): Promise<void> {
    state.loadingMsg = `loading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`;
    state.errorMsg = '';
    renderReplayRail(host, state, cbs);
    try {
      const { loadBundle } = await import('./bundle');
      const bundle = await loadBundle(file);
      state.bundle = bundle;
      state.loadingMsg = '';
      cbs.onBundle(bundle);
    } catch (err) {
      state.errorMsg = `bundle failed: ${(err as Error).message}`;
      state.loadingMsg = '';
    }
    renderReplayRail(host, state, cbs);
  }

  const playBtn = host.querySelector<HTMLButtonElement>('#playPause')!;
  playBtn.addEventListener('click', () => cbs.onPlayPause());
  const spd = host.querySelector<HTMLSelectElement>('#playSpeed')!;
  spd.addEventListener('change', () => cbs.onSpeedChange(parseFloat(spd.value)));
  const scrub = host.querySelector<HTMLInputElement>('#scrub')!;
  scrub.addEventListener('input', () => {
    // range value is 0..100 (a percentage); convert to seconds
    const pct = parseFloat(scrub.value) / 100;
    cbs.onSeek(pct * state.lapDurationSec);
  });

  // click on the session-speed strip → pick a ride-reference moment
  const speedCanvas = host.querySelector<HTMLCanvasElement>('#sessionSpeedCanvas')!;
  speedCanvas.addEventListener('click', (e) => {
    if (!state.bundle) return;
    const rect = speedCanvas.getBoundingClientRect();
    const ML = 22, MR = 4;
    const pw = rect.width - ML - MR;
    const x = e.clientX - rect.left - ML;
    const pct = Math.max(0, Math.min(1, x / pw));
    const xmax = state.bundle.sessionSpeed.tSec[state.bundle.sessionSpeed.tSec.length - 1] || 1;
    const sessionSec = pct * xmax;
    cbs.onPickRideRef(sessionSec);
  });
}

export function renderReplayRail(host: HTMLElement, state: ReplayUIState, cbs: ReplayUICallbacks): void {
  const status = host.querySelector<HTMLDivElement>('#replayStatus')!;
  status.textContent = state.errorMsg || state.loadingMsg;
  status.style.color = state.errorMsg ? 'var(--bad)' : 'var(--dim)';

  const sessionBox = host.querySelector<HTMLDivElement>('#replaySession')!;
  const mappingBox = host.querySelector<HTMLDivElement>('#replayMapping')!;
  const lapsBox = host.querySelector<HTMLDivElement>('#replayLaps')!;
  const playBox = host.querySelector<HTMLDivElement>('#replayPlay')!;

  if (!state.bundle) {
    sessionBox.style.display = 'none';
    mappingBox.style.display = 'none';
    lapsBox.style.display = 'none';
    playBox.style.display = 'none';
    return;
  }
  const b = state.bundle;
  sessionBox.style.display = '';
  mappingBox.style.display = '';
  lapsBox.style.display = '';

  const summary = host.querySelector<HTMLDivElement>('#sessionSummary')!;
  const totalMin = (b.session.durationMs / 60000).toFixed(1);
  const bestT = formatLapTime(b.session.bestLapTimeMs);
  const track = b.session.trackName ?? '(no track)';
  summary.innerHTML = `<div class="sessionKey">Track</div><div class="sessionVal">${track}</div>`
    + `<div class="sessionKey">Duration</div><div class="sessionVal">${totalMin} min</div>`
    + `<div class="sessionKey">Laps</div><div class="sessionVal">${b.session.totalLaps}</div>`
    + `<div class="sessionKey">Best lap</div><div class="sessionVal">${bestT}</div>`;

  const mapping = resolveMapping(b.sensors);
  const shocks = b.sensors.filter((s) => s.sensorType.startsWith('shock'));

  // ride reference banner: shows how the "zero" was picked and lets the user
  // recompute from a specific window (M7)
  const refBox = host.querySelector<HTMLDivElement>('#rideRefRow')!;
  const sourceLabel = b.rideRef.source === 'stopped' ? 'auto — from samples where speed ≈ 0'
    : b.rideRef.source === 'median' ? 'session median (no stopped samples found)'
    : state.rideRefPickSec !== null
      ? `user-picked · t = ${state.rideRefPickSec.toFixed(1)} s`
      : 'user-set';
  refBox.innerHTML = `<div class="rideRefHead"><b>Ride reference</b> · ${sourceLabel}</div>`;
  drawSessionSpeed(host, state);

  const mappingList = host.querySelector<HTMLDivElement>('#mappingList')!;
  mappingList.innerHTML = shocks.map((s) => {
    const role = currentRole(s.macAddress, mapping);
    const ref = b.rideRef.refByMac[s.macAddress];
    const refCount = b.rideRef.countByMac[s.macAddress];
    const refStr = isFinite(ref)
      ? `ride ref ${ref.toFixed(3)} ${escHtml(s.units)}${refCount ? ` (n=${refCount})` : ''}`
      : 'no ride ref';
    return `<div class="mapRow" data-mac="${s.macAddress}">
      <div class="mapName">${escHtml(s.sensorName)} <span class="mapMac">${s.macAddress.slice(-8)}</span></div>
      <select class="mapRole" data-mac="${s.macAddress}">
        <option value="none"${role === null ? ' selected' : ''}>—</option>
        <option value="fl"${role === 'fl' ? ' selected' : ''}>Front Left</option>
        <option value="fr"${role === 'fr' ? ' selected' : ''}>Front Right</option>
      </select>
      <label class="mapInvert"><input type="checkbox" class="mapInvertBox" data-mac="${s.macAddress}"${
        (mapping.flMac === s.macAddress && mapping.flInvert) || (mapping.frMac === s.macAddress && mapping.frInvert)
        ? ' checked' : ''
      }> invert</label>
      <div class="mapRideRef">${refStr}</div>
    </div>`;
  }).join('');
  mappingList.querySelectorAll<HTMLSelectElement>('.mapRole').forEach((sel) => {
    sel.addEventListener('change', () => {
      saveRole(sel.dataset.mac!, sel.value as 'fl' | 'fr' | 'none');
      cbs.onMappingChange(resolveMapping(b.sensors));
      renderReplayRail(host, state, cbs);   // re-render to refresh other selects (roles are unique)
    });
  });
  mappingList.querySelectorAll<HTMLInputElement>('.mapInvertBox').forEach((cb) => {
    cb.addEventListener('change', () => {
      saveInvert(cb.dataset.mac!, cb.checked);
      cbs.onMappingChange(resolveMapping(b.sensors));
    });
  });

  const lapList = host.querySelector<HTMLDivElement>('#lapList')!;
  lapList.innerHTML = b.laps.map((l) => {
    const isBest = l.lapTimeMs === b.session.bestLapTimeMs && b.session.bestLapTimeMs > 0;
    const sel = l.lapNumber === state.selectedLap ? ' on' : '';
    return `<button class="lapBtn${sel}${isBest ? ' best' : ''}" data-lap="${l.lapNumber}">`
      + `<span class="lapNum">L${l.lapNumber}</span>`
      + `<span class="lapT">${formatLapTime(l.lapTimeMs)}</span>`
      + (isBest ? '<span class="lapBadge">best</span>' : '')
      + `</button>`;
  }).join('');
  lapList.querySelectorAll<HTMLButtonElement>('.lapBtn').forEach((btn) => {
    btn.addEventListener('click', () => cbs.onSelectLap(parseInt(btn.dataset.lap!, 10)));
  });

  // playback panel visibility follows lap selection
  playBox.style.display = state.selectedLap !== null ? '' : 'none';
  const playBtn = host.querySelector<HTMLButtonElement>('#playPause')!;
  playBtn.textContent = state.playing ? '⏸ Pause' : '▶ Play';
  const scrub = host.querySelector<HTMLInputElement>('#scrub')!;
  const pct = state.lapDurationSec > 0 ? (state.currentTSec / state.lapDurationSec) * 100 : 0;
  if (document.activeElement !== scrub) scrub.value = String(pct);
  const scrubTime = host.querySelector<HTMLDivElement>('#scrubTime')!;
  scrubTime.textContent = `${state.currentTSec.toFixed(3)} / ${state.lapDurationSec.toFixed(3)} s`;
}

/** Draw the session-wide speed strip in the mapping panel — the "click here
 *  to pick your ride reference" chart. */
function drawSessionSpeed(host: HTMLElement, state: ReplayUIState): void {
  const canvas = host.querySelector<HTMLCanvasElement>('#sessionSpeedCanvas');
  if (!canvas || !state.bundle) return;
  const s = state.bundle.sessionSpeed;
  const dpr = Math.min(devicePixelRatio, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  // find y range
  let ymax = 0;
  for (let i = 0; i < s.mph.length; i++) if (isFinite(s.mph[i]) && s.mph[i] > ymax) ymax = s.mph[i];
  ymax = Math.max(ymax, 10);
  const xmax = s.tSec[s.tSec.length - 1] || 1;
  const ML = 22, MR = 4, MT = 4, MB = 12;
  const pw = w - ML - MR, ph = h - MT - MB;
  const X = (t: number) => ML + (t / xmax) * pw;
  const Y = (v: number) => MT + ph - (v / ymax) * ph;

  // baseline + frame
  g.strokeStyle = '#283340'; g.lineWidth = 1;
  g.strokeRect(ML, MT, pw, ph);
  // y=0 line
  g.beginPath(); g.moveTo(ML, Y(0)); g.lineTo(w - MR, Y(0)); g.stroke();

  // speed trace
  g.strokeStyle = '#ffd23f'; g.lineWidth = 1.4;
  g.beginPath();
  let started = false;
  for (let i = 0; i < s.tSec.length; i++) {
    if (!isFinite(s.mph[i])) { started = false; continue; }
    const px = X(s.tSec[i]), py = Y(s.mph[i]);
    if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
  }
  g.stroke();

  // picked window (±2 s highlight)
  if (state.rideRefPickSec !== null) {
    const cx = X(state.rideRefPickSec);
    const halfPx = (2 / xmax) * pw;
    g.fillStyle = 'rgba(255,106,31,0.18)';
    g.fillRect(cx - halfPx, MT, halfPx * 2, ph);
    g.strokeStyle = '#ff6a1f'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx, MT); g.lineTo(cx, MT + ph); g.stroke();
  }

  // axis ticks
  g.fillStyle = '#5c6774'; g.font = '9px SF Mono, ui-monospace, Menlo, monospace';
  g.textBaseline = 'top'; g.textAlign = 'center';
  const step = xmax > 600 ? 120 : xmax > 300 ? 60 : xmax > 60 ? 30 : 10;
  for (let t = 0; t <= xmax; t += step) {
    const px = X(t);
    g.fillText(String(t | 0), px, MT + ph + 2);
  }
  g.textBaseline = 'middle'; g.textAlign = 'right';
  g.fillText(String(Math.round(ymax)), ML - 3, MT + 6);
  g.fillText('0', ML - 3, Y(0));
}

/** Just update the play/scrub/time widgets during RAF ticks — full render is
 *  overkill for 60fps updates. Called from the replay engine. */
export function tickReplayUI(host: HTMLElement, state: ReplayUIState): void {
  const scrub = host.querySelector<HTMLInputElement>('#scrub');
  const scrubTime = host.querySelector<HTMLDivElement>('#scrubTime');
  const playBtn = host.querySelector<HTMLButtonElement>('#playPause');
  if (!scrub || !scrubTime || !playBtn) return;
  const pct = state.lapDurationSec > 0 ? (state.currentTSec / state.lapDurationSec) * 100 : 0;
  if (document.activeElement !== scrub) scrub.value = String(pct);
  scrubTime.textContent = `${state.currentTSec.toFixed(3)} / ${state.lapDurationSec.toFixed(3)} s`;
  playBtn.textContent = state.playing ? '⏸ Pause' : '▶ Play';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
