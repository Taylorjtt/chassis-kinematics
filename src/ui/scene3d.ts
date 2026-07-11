/*
 * 3D scene (spec §6): arms, knuckle as a body (LBJ -> boss -> UBJ) with the
 * spindle pin + hub locating the wheel, tire torus + rim, spring/shock,
 * steering linkage, roll center + migration trail. Ported from v4, now on
 * bundled three.js with real OrbitControls.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Vec3 } from '../core/math';
import { CornerStatic, CornerSolution } from '../core/assembly';
import { FrontAssembly } from '../core/trim';
import { FrontState } from '../core/metrics';

const T = (v: Vec3) => new THREE.Vector3(v.x, v.y, v.z);
const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const COL = {
  low: 0x9aa7b5, up: 0xb6c3d1, upr: 0xff8a3d, tire: 0x22282f, rim: 0x39424d,
  tie: 0x46d18a, link: 0x36c2ff, arm: 0xffd23f, spring: 0xff6a1f,
  shock: 0x6b7787, frame: 0x3a4654, hub: 0xcdd6e0,
};

export interface DisplayToggles {
  construct: boolean; trail: boolean; shock: boolean; wire: boolean; ghost: boolean;
}

interface WheelGroup extends THREE.Group {
  _tire: THREE.Mesh; _rim: THREE.Mesh; _ring: THREE.Mesh; _cap: THREE.Mesh;
  _rebuild(radius: number, width: number): void;
}

interface SideVis {
  lowA1: THREE.Mesh; lowA2: THREE.Mesh; upA1: THREE.Mesh; upA2: THREE.Mesh;
  uprLow: THREE.Mesh; uprHigh: THREE.Mesh; pin: THREE.Mesh; hub: THREE.Mesh;
  arm: THREE.Mesh; tie: THREE.Mesh;
  bjL: THREE.Mesh; bjU: THREE.Mesh;
  wheel: WheelGroup;
  shockBody: THREE.Mesh; shockShaft: THREE.Mesh;
  swingLine: THREE.Line; icDot: THREE.Mesh;
}

export class Scene3D {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private visR: SideVis; private visL: SideVis;
  private linkPitman: THREE.Mesh; private linkIdler: THREE.Mesh; private linkCenter: THREE.Mesh;
  private pivPit: THREE.Mesh; private pivIdl: THREE.Mesh;
  private rcDot: THREE.Mesh; private rcLineR: THREE.Line; private rcLineL: THREE.Line;
  private trail: THREE.Vector3[] = [];
  private trailLine: THREE.Line;
  private frameLines: THREE.Line[] = [];
  private ghostLines: THREE.Line[] = [];
  private ghostSet = false;
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.scene.background = new THREE.Color(0x0d1014);
    this.camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, 0.5, 1000);
    this.camera.up.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const keyL = new THREE.DirectionalLight(0xffffff, 0.9);
    keyL.position.set(40, -30, 60); this.scene.add(keyL);
    const fillL = new THREE.DirectionalLight(0x88aaff, 0.35);
    fillL.position.set(-40, 40, 20); this.scene.add(fillL);
    const grid = new THREE.GridHelper(140, 28, 0x2a3340, 0x1a2027);
    grid.rotation.x = Math.PI / 2; this.scene.add(grid);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.resetView();
    this.controls.addEventListener('change', () => this.render());

    this.visR = this.makeSide(0xff6a1f);
    this.visL = this.makeSide(0x36c2ff);
    this.linkPitman = this.rod(0.42, COL.arm);
    this.linkIdler = this.rod(0.42, COL.arm);
    this.linkCenter = this.rod(0.48, COL.link);
    this.pivPit = this.ball(0.8, COL.frame);
    this.pivIdl = this.ball(0.8, COL.frame);
    this.rcDot = this.ball(1.0, 0xffd23f);
    (this.rcDot.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5;
    this.rcLineR = this.lineObj(0xffd23f, false);
    this.rcLineL = this.lineObj(0xffd23f, false);
    this.trailLine = this.lineObj(0xffd23f, false);
    const tm = this.trailLine.material as THREE.LineBasicMaterial;
    tm.transparent = true; tm.opacity = 0.6;
    for (let i = 0; i < 6; i++) this.frameLines.push(this.lineObj(COL.frame, false));
    // baseline ghost: dashed outline of the pre-adjustment geometry (7 lines/side)
    for (let i = 0; i < 14; i++) {
      const l = this.lineObj(0x77879c, true);
      const m = l.material as THREE.LineDashedMaterial;
      m.transparent = true; m.opacity = 0.55;
      l.visible = false;
      this.ghostLines.push(l);
    }
  }

  /** Snapshot the given solved state as the dashed baseline ghost. */
  setGhost(fa: FrontAssembly, m: FrontState): void {
    const circle = (center: Vec3, axis: Vec3, r: number): THREE.Vector3[] => {
      const n = T(axis).normalize();
      let u = V3(1, 0, 0);
      if (Math.abs(n.dot(u)) > 0.9) u = V3(0, 0, 1);
      const a = u.clone().cross(n).normalize(), b = n.clone().cross(a).normalize();
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 32; i++) {
        const t = (i / 32) * Math.PI * 2;
        pts.push(T(center).add(a.clone().multiplyScalar(Math.cos(t) * r)).add(b.clone().multiplyScalar(Math.sin(t) * r)));
      }
      return pts;
    };
    const sides: Array<[CornerStatic, CornerSolution]> = [[fa.statR, m.cR], [fa.statL, m.cL]];
    sides.forEach(([stat, c], si) => {
      const o = si * 7;
      this.setLine(this.ghostLines[o + 0], [T(stat.lowerFront), T(c.LBJ)]);
      this.setLine(this.ghostLines[o + 1], [T(stat.lowerRear), T(c.LBJ)]);
      this.setLine(this.ghostLines[o + 2], [T(stat.upperFront), T(c.UBJ)]);
      this.setLine(this.ghostLines[o + 3], [T(stat.upperRear), T(c.UBJ)]);
      this.setLine(this.ghostLines[o + 4], [T(c.LBJ), T(c.UBJ)]);
      this.setLine(this.ghostLines[o + 5], [T(c.TRI), T(c.TRO)]);
      this.setLine(this.ghostLines[o + 6], circle(c.WC, c.spin, stat.wheel.radius));
    });
    this.ghostSet = true;
  }

  /** For the scan importer: raycasting needs the camera + canvas, and the
   *  scan group lives directly in the scene. */
  get canvas(): HTMLCanvasElement { return this.renderer.domElement; }
  get cam(): THREE.PerspectiveCamera { return this.camera; }
  addObject(obj: THREE.Object3D): void { this.scene.add(obj); }
  removeObject(obj: THREE.Object3D): void { this.scene.remove(obj); }

  resetView(): void {
    this.camera.position.set(
      98 * Math.sin(1.15) * Math.cos(-0.9),
      98 * Math.sin(1.15) * Math.sin(-0.9),
      9 + 98 * Math.cos(1.15),
    );
    this.controls.target.set(0, 0, 9);
    this.controls.update();
  }

  resize(): void {
    this.camera.aspect = this.host.clientWidth / this.host.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
    this.render();
  }

  clearTrail(): void { this.trail = []; }

  render(): void { this.renderer.render(this.scene, this.camera); }

  /* ---------- primitives (v4 port) ---------- */
  private rod(r: number, c: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 1, 14),
      new THREE.MeshStandardMaterial({ color: c, metalness: 0.55, roughness: 0.45 }),
    );
    this.scene.add(m); return m;
  }
  private setRod(m: THREE.Mesh, p1: THREE.Vector3, p2: THREE.Vector3): void {
    const dir = p2.clone().sub(p1), len = dir.length();
    if (len < 1e-6) { m.visible = false; return; }
    m.visible = true;
    m.position.copy(p1.clone().add(p2).multiplyScalar(0.5));
    m.quaternion.setFromUnitVectors(V3(0, 1, 0), dir.clone().normalize());
    m.scale.set(1, len, 1);
  }
  private ball(r: number, c: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 16, 16),
      new THREE.MeshStandardMaterial({ color: c, metalness: 0.3, roughness: 0.5, emissive: c, emissiveIntensity: 0.15 }),
    );
    this.scene.add(m); return m;
  }
  private lineObj(c: number, dashed: boolean): THREE.Line {
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color: c, dashSize: 1.2, gapSize: 0.8 })
      : new THREE.LineBasicMaterial({ color: c });
    const l = new THREE.Line(new THREE.BufferGeometry(), mat);
    this.scene.add(l);
    (l as unknown as { _dashed: boolean })._dashed = dashed;
    return l;
  }
  private setLine(l: THREE.Line, pts: THREE.Vector3[]): void {
    l.geometry.setFromPoints(pts);
    if ((l as unknown as { _dashed: boolean })._dashed) l.computeLineDistances();
  }

  private makeWheel(rimCol: number): WheelGroup {
    const g = new THREE.Group() as WheelGroup;
    this.scene.add(g);
    const mk = (R: number, W: number) => ({
      tire: new THREE.TorusGeometry(R - W * 0.28, W * 0.32, 12, 30),
      rim: new THREE.CylinderGeometry(R - W * 0.55, R - W * 0.55, W * 0.55, 24),
      ring: new THREE.TorusGeometry(R - W * 0.55, 0.4, 8, 26),
      cap: new THREE.CylinderGeometry(1.6, 1.6, W * 0.62, 14),
    });
    const g0 = mk(11, 8);
    g._tire = new THREE.Mesh(g0.tire, new THREE.MeshStandardMaterial({ color: COL.tire, metalness: 0.1, roughness: 0.85 }));
    g._tire.rotation.x = Math.PI / 2; g.add(g._tire);
    g._rim = new THREE.Mesh(g0.rim, new THREE.MeshStandardMaterial({ color: COL.rim, metalness: 0.6, roughness: 0.35 }));
    g.add(g._rim);
    g._ring = new THREE.Mesh(g0.ring, new THREE.MeshStandardMaterial({ color: rimCol, metalness: 0.6, roughness: 0.4 }));
    g._ring.rotation.x = Math.PI / 2; g.add(g._ring);
    g._cap = new THREE.Mesh(g0.cap, new THREE.MeshStandardMaterial({ color: rimCol, metalness: 0.7, roughness: 0.3 }));
    g.add(g._cap);
    g._rebuild = (R: number, W: number) => {
      const gg = mk(R, W);
      g._tire.geometry.dispose(); g._tire.geometry = gg.tire;
      g._rim.geometry.dispose(); g._rim.geometry = gg.rim;
      g._ring.geometry.dispose(); g._ring.geometry = gg.ring;
      g._cap.geometry.dispose(); g._cap.geometry = gg.cap;
    };
    return g;
  }

  private makeSide(rimCol: number): SideVis {
    return {
      lowA1: this.rod(0.42, COL.low), lowA2: this.rod(0.42, COL.low),
      upA1: this.rod(0.38, COL.up), upA2: this.rod(0.38, COL.up),
      uprLow: this.rod(0.5, COL.upr), uprHigh: this.rod(0.5, COL.upr),
      pin: this.rod(0.34, COL.hub),
      hub: this.rod(1.15, COL.hub),
      arm: this.rod(0.36, COL.arm), tie: this.rod(0.3, COL.tie),
      bjL: this.ball(0.65, 0xff5d6c), bjU: this.ball(0.65, 0xff5d6c),
      wheel: this.makeWheel(rimCol),
      shockBody: this.rod(0.55, COL.shock), shockShaft: this.rod(0.26, 0xcdd6e0),
      swingLine: this.lineObj(0x7a8aa0, true), icDot: this.ball(0.6, 0x7a8aa0),
    };
  }

  private drawCorner(v: SideVis, stat: CornerStatic, c: CornerSolution): void {
    const LBJ = T(c.LBJ), UBJ = T(c.UBJ), WC = T(c.WC), TRO = T(c.TRO), TRI = T(c.TRI);
    const spin = T(c.spin);
    this.setRod(v.lowA1, T(stat.lowerFront), LBJ); this.setRod(v.lowA2, T(stat.lowerRear), LBJ);
    this.setRod(v.upA1, T(stat.upperFront), UBJ); this.setRod(v.upA2, T(stat.upperRear), UBJ);
    // knuckle body: LBJ -> spindle boss -> UBJ (boss pushed toward the wheel)
    const boss = LBJ.clone().lerp(UBJ, 0.5).lerp(WC, 0.32);
    this.setRod(v.uprLow, LBJ, boss); this.setRod(v.uprHigh, boss, UBJ);
    const hubIn = WC.clone().sub(spin.clone().multiplyScalar(stat.wheel.width * 0.32));
    this.setRod(v.pin, boss, WC);
    this.setRod(v.hub, hubIn, WC);
    this.setRod(v.arm, boss, TRO);
    this.setRod(v.tie, TRI, TRO);
    v.bjL.position.copy(LBJ); v.bjU.position.copy(UBJ);
    v.wheel._rebuild(stat.wheel.radius, stat.wheel.width);
    v.wheel.position.copy(WC);
    v.wheel.quaternion.setFromUnitVectors(V3(0, 1, 0), spin);
    const kLow = T(stat.lowArm.point(stat.attShockLow, c.theta));
    const mid = kLow.clone().lerp(T(stat.shockUpper0), 0.5);
    this.setRod(v.shockBody, kLow, mid); this.setRod(v.shockShaft, mid, T(stat.shockUpper0));
  }

  update(fa: FrontAssembly, m: FrontState, tg: DisplayToggles): void {
    this.drawCorner(this.visR, fa.statR, m.cR);
    this.drawCorner(this.visL, fa.statL, m.cL);
    for (const v of [this.visR, this.visL]) {
      (v.wheel._tire.material as THREE.MeshStandardMaterial).wireframe = tg.wire;
      (v.wheel._rim.material as THREE.MeshStandardMaterial).wireframe = tg.wire;
      v.shockBody.visible = tg.shock; v.shockShaft.visible = tg.shock;
    }
    this.setRod(this.linkPitman, T(m.st.Pp), T(m.st.CLL));
    this.setRod(this.linkIdler, T(m.st.Pi), T(m.st.CLR));
    this.setRod(this.linkCenter, T(m.st.CLL), T(m.st.CLR));
    this.pivPit.position.copy(T(m.st.Pp)); this.pivIdl.position.copy(T(m.st.Pi));
    this.setLine(this.frameLines[0], [T(fa.statR.lowerFront), T(fa.statL.lowerFront)]);
    this.setLine(this.frameLines[1], [T(fa.statR.lowerRear), T(fa.statL.lowerRear)]);
    this.setLine(this.frameLines[2], [T(fa.statR.upperFront), T(fa.statL.upperFront)]);
    this.setLine(this.frameLines[3], [T(fa.statR.upperRear), T(fa.statL.upperRear)]);
    this.setLine(this.frameLines[4], [T(fa.statR.lowerFront), T(fa.statR.upperFront)]);
    this.setLine(this.frameLines[5], [T(fa.statL.lowerFront), T(fa.statL.upperFront)]);

    this.ghostLines.forEach((l) => { l.visible = tg.ghost && this.ghostSet; });

    const showC = tg.construct && !!m.rc.rc;
    this.visR.swingLine.visible = showC; this.visL.swingLine.visible = showC;
    const haveICs = !!(m.rc.icR && m.rc.icL);
    this.visR.icDot.visible = haveICs; this.visL.icDot.visible = haveICs;
    this.rcLineR.visible = showC; this.rcLineL.visible = showC;
    this.rcDot.visible = !!m.rc.rc;
    if (m.rc.icR && m.rc.icL) {
      const icR = V3(0, m.rc.icR[0], m.rc.icR[1]), icL = V3(0, m.rc.icL[0], m.rc.icL[1]);
      this.visR.icDot.position.copy(icR); this.visL.icDot.position.copy(icL);
      if (showC) {
        this.setLine(this.visR.swingLine, [V3(0, m.cR.CPy, 0), icR]);
        this.setLine(this.visL.swingLine, [V3(0, m.cL.CPy, 0), icL]);
      }
    }
    if (m.rc.rc) {
      const rcP = V3(0, m.rc.rc[0], m.rc.rc[1]);
      this.rcDot.position.copy(rcP);
      if (showC && m.rc.icR && m.rc.icL) {
        this.setLine(this.rcLineR, [V3(0, m.cR.CPy, 0), V3(0, m.rc.icR[0], m.rc.icR[1])]);
        this.setLine(this.rcLineL, [V3(0, m.cL.CPy, 0), V3(0, m.rc.icL[0], m.rc.icL[1])]);
      }
      if (tg.trail) {
        const last = this.trail[this.trail.length - 1];
        if (!last || Math.hypot(last.y - rcP.y, last.z - rcP.z) > 0.05) {
          this.trail.push(rcP.clone());
          if (this.trail.length > 120) this.trail.shift();
        }
        this.setLine(this.trailLine, this.trail);
        this.trailLine.visible = this.trail.length > 1;
      } else this.trailLine.visible = false;
    }
    this.render();
  }
}
