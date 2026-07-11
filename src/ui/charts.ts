/* Analysis strip charts (v4 chartMulti port): L+R series with live markers. */

export interface ChartSeries {
  ys: number[];
  color: string;
  markerX?: number;
  dash?: number[];      // e.g. [5,4] for baseline overlays
  width?: number;
}

export function chartMulti(canvas: HTMLCanvasElement, xs: number[], series: ChartSeries[]): void {
  const dpr = Math.min(devicePixelRatio, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  let all: number[] = [];
  series.forEach((s) => { all = all.concat(s.ys.filter(isFinite)); });
  if (!all.length) return;
  let ymin = Math.min(...all), ymax = Math.max(...all);
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const pad = (ymax - ymin) * 0.15;
  ymin -= pad; ymax += pad;
  const xmin = xs[0], xmax = xs[xs.length - 1];
  const X = (x: number) => ((x - xmin) / (xmax - xmin)) * (w - 10) + 5;
  const Y = (y: number) => h - 8 - ((y - ymin) / (ymax - ymin)) * (h - 16);
  g.strokeStyle = '#283340'; g.lineWidth = 1;
  if (ymin < 0 && ymax > 0) { g.beginPath(); g.moveTo(5, Y(0)); g.lineTo(w - 5, Y(0)); g.stroke(); }
  g.beginPath(); g.moveTo(X(0), 5); g.lineTo(X(0), h - 5); g.stroke();
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
