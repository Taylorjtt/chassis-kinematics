/* 2D front-view roll-center construction (v4 drawFront port). */
import { FrontAssembly } from '../core/trim';
import { FrontState } from '../core/metrics';

const fmt = (n: number, d: number) => (n >= 0 ? '+' : '') + n.toFixed(d);

export function drawFrontView(
  canvas: HTMLCanvasElement, info: HTMLElement, fa: FrontAssembly, m: FrontState,
): void {
  const dpr = Math.min(devicePixelRatio, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const wheelR = fa.statR.wheel.radius, wheelW = fa.statR.wheel.width;
  const yMax = Math.max(Math.abs(m.cR.WC.y), Math.abs(m.cL.WC.y)) + wheelW / 2 + 4;
  const zMax = Math.max(fa.statR.UBJ0.z, fa.statL.UBJ0.z, m.rc.rc ? m.rc.rc[1] : 0, wheelR * 2) + 3;
  const zMin = -2.5;
  const s = Math.min((w - 16) / (2 * yMax), (h - 14) / (zMax - zMin));
  const X = (y: number) => w / 2 + y * s;
  const Y = (z: number) => h - 8 - (z - zMin) * s;
  function seg(y1: number, z1: number, y2: number, z2: number, col: string, width: number, dash?: number[]) {
    g.strokeStyle = col; g.lineWidth = width;
    g.setLineDash(dash || []);
    g.beginPath(); g.moveTo(X(y1), Y(z1)); g.lineTo(X(y2), Y(z2)); g.stroke();
    g.setLineDash([]);
  }
  function pt(y: number, z: number, col: string, r: number) {
    g.fillStyle = col; g.beginPath(); g.arc(X(y), Y(z), r, 0, 7); g.fill();
  }
  seg(-yMax, 0, yMax, 0, '#3a4654', 1.5);
  seg(0, zMin, 0, zMax, '#283340', 1, [4, 4]);
  const sides = [
    { c: m.cR, st: fa.statR, col: '#ff6a1f', ic: m.rc.icR },
    { c: m.cL, st: fa.statL, col: '#36c2ff', ic: m.rc.icL },
  ];
  sides.forEach((sd) => {
    const lm = { y: (sd.st.lowerFront.y + sd.st.lowerRear.y) / 2, z: (sd.st.lowerFront.z + sd.st.lowerRear.z) / 2 };
    const um = { y: (sd.st.upperFront.y + sd.st.upperRear.y) / 2, z: (sd.st.upperFront.z + sd.st.upperRear.z) / 2 };
    const tw = sd.st.wheel.width / 2;
    g.strokeStyle = sd.col; g.lineWidth = 1;
    g.strokeRect(X(sd.c.WC.y - tw), Y(sd.c.WC.z + sd.st.wheel.radius), 2 * tw * s, 2 * sd.st.wheel.radius * s);
    seg(lm.y, lm.z, sd.c.LBJ.y, sd.c.LBJ.z, sd.col, 2);
    seg(um.y, um.z, sd.c.UBJ.y, sd.c.UBJ.z, sd.col, 2);
    seg(sd.c.LBJ.y, sd.c.LBJ.z, sd.c.UBJ.y, sd.c.UBJ.z, sd.col, 1.2);
    pt(sd.c.LBJ.y, sd.c.LBJ.z, '#ff5d6c', 2.5); pt(sd.c.UBJ.y, sd.c.UBJ.z, '#ff5d6c', 2.5);
    if (sd.ic) {
      seg(sd.c.LBJ.y, sd.c.LBJ.z, sd.ic[0], sd.ic[1], '#7a8aa0', 0.8, [5, 4]);
      seg(sd.c.UBJ.y, sd.c.UBJ.z, sd.ic[0], sd.ic[1], '#7a8aa0', 0.8, [5, 4]);
      seg(sd.c.CPy, 0, sd.ic[0], sd.ic[1], sd.col, 0.9, [2, 3]);
      pt(sd.ic[0], sd.ic[1], '#7a8aa0', 3);
    }
  });
  if (m.rc.rc) {
    pt(m.rc.rc[0], m.rc.rc[1], '#ffd23f', 4);
    g.strokeStyle = '#ffd23f'; g.lineWidth = 1;
    g.beginPath(); g.arc(X(m.rc.rc[0]), Y(m.rc.rc[1]), 6.5, 0, 7); g.stroke();
  }
  const fvsa = (ic: [number, number] | null, cpy: number) =>
    ic ? Math.hypot(ic[0] - cpy, ic[1]).toFixed(1) : '—';
  info.textContent =
    'FVSA  R ' + fvsa(m.rc.icR, m.cR.CPy) + '"   L ' + fvsa(m.rc.icL, m.cL.CPy) + '"'
    + (m.rc.rc ? ('    RC  y ' + fmt(m.rc.rc[0], 2) + '"  z ' + m.rc.rc[1].toFixed(2) + '"') : '    RC —');
}
