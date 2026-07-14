/* Analysis strip charts (v4 chartMulti port): L+R series with live markers,
 * tick marks on both axes so the scale is readable at a glance. */

export interface ChartSeries {
  ys: number[];
  color: string;
  markerX?: number;
  dash?: number[];      // e.g. [5,4] for baseline overlays
  width?: number;
}

/** "Nice" tick spacing for the given data range and target tick count. */
function niceStep(range: number, target = 5): number {
  if (range <= 0 || !isFinite(range)) return 1;
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * pow;
}

/** Format tick label — trim trailing zeros, keep short. */
function fmtTick(v: number, step: number): string {
  if (Math.abs(v) < step * 1e-6) return '0';
  const digits = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return v.toFixed(digits);
}

export function chartMulti(canvas: HTMLCanvasElement, xs: number[], series: ChartSeries[]): void {
  const dpr = Math.min(devicePixelRatio, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  let all: number[] = [];
  series.forEach((s) => { all = all.concat(s.ys.filter(isFinite)); });
  if (!all.length) return;
  let ymin = Math.min(...all), ymax = Math.max(...all);
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const pad = (ymax - ymin) * 0.12;
  ymin -= pad; ymax += pad;
  const xmin = xs[0], xmax = xs[xs.length - 1];

  // margins for tick labels (left = y-axis values, bottom = x-axis)
  const ML = 36, MR = 6, MT = 6, MB = 16;
  const w = W - ML - MR, h = H - MT - MB;
  const X = (x: number) => ML + ((x - xmin) / (xmax - xmin)) * w;
  const Y = (y: number) => MT + h - ((y - ymin) / (ymax - ymin)) * h;

  // grid + tick labels
  const yStep = niceStep(ymax - ymin, 5);
  const yStart = Math.ceil(ymin / yStep) * yStep;
  g.font = '10px SF Mono, ui-monospace, Menlo, monospace';
  g.fillStyle = '#5c6774';
  g.strokeStyle = '#1e2733';
  g.lineWidth = 1;
  g.textBaseline = 'middle';
  g.textAlign = 'right';
  for (let v = yStart; v <= ymax + yStep * 1e-6; v += yStep) {
    const y = Y(v);
    g.beginPath(); g.moveTo(ML, y); g.lineTo(W - MR, y); g.stroke();
    g.fillText(fmtTick(v, yStep), ML - 4, y);
  }

  const xStep = niceStep(xmax - xmin, 6);
  const xStart = Math.ceil(xmin / xStep) * xStep;
  g.textBaseline = 'top';
  g.textAlign = 'center';
  for (let v = xStart; v <= xmax + xStep * 1e-6; v += xStep) {
    const x = X(v);
    g.beginPath(); g.moveTo(x, MT); g.lineTo(x, MT + h); g.stroke();
    g.fillText(fmtTick(v, xStep), x, MT + h + 3);
  }

  // emphasized zero lines (over the grid)
  g.strokeStyle = '#3a4654'; g.lineWidth = 1;
  if (ymin < 0 && ymax > 0) { g.beginPath(); g.moveTo(ML, Y(0)); g.lineTo(W - MR, Y(0)); g.stroke(); }
  if (xmin < 0 && xmax > 0) { g.beginPath(); g.moveTo(X(0), MT); g.lineTo(X(0), MT + h); g.stroke(); }

  // outer frame
  g.strokeStyle = '#283340';
  g.strokeRect(ML, MT, w, h);

  // series
  series.forEach((s) => {
    g.strokeStyle = s.color; g.lineWidth = s.width ?? 2;
    g.setLineDash(s.dash ?? []);
    g.beginPath();
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      if (!isFinite(s.ys[i])) { started = false; continue; }
      const px = X(xs[i]), py = Y(s.ys[i]);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
    }
    g.stroke();
    g.setLineDash([]);
    if (s.markerX !== undefined && isFinite(s.markerX)) {
      const mx = X(s.markerX);
      let my: number | null = null;
      for (let i = 1; i < xs.length; i++) {
        if (s.markerX >= xs[i - 1] && s.markerX <= xs[i] && isFinite(s.ys[i]) && isFinite(s.ys[i - 1])) {
          const f = (s.markerX - xs[i - 1]) / (xs[i] - xs[i - 1]);
          my = Y(s.ys[i - 1] + f * (s.ys[i] - s.ys[i - 1]));
          break;
        }
      }
      if (my !== null) { g.fillStyle = s.color; g.beginPath(); g.arc(mx, my, 3.2, 0, 7); g.fill(); }
    }
  });
}

export function seriesRange(a: number[]): number {
  const v = a.filter(isFinite);
  return v.length ? Math.max(...v) - Math.min(...v) : 0;
}
