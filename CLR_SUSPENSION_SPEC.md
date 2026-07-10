# CLR Suspension Builder — Claude Code Implementation Spec

Parts-based front suspension simulator for dirt circle track (SLA / double
wishbone). Successor to a validated single-file prototype
(`suspension_sim.html`, v4 — include it in the repo at `reference/` and read
it; the solver and tests there are the ground truth to port).

## 1. Vision

You **build the car from parts**, the way it's actually built: a chassis with
pickup points, control arms, a spindle, tie rods — each a physical part with
its own geometry. The assembly solver bolts them together and **alignment is
an output**: camber, caster, toe, track width, scrub, roll center all fall out
of the geometry. There is no camber input anywhere in the app. Change a part
or an adjustment and the measurements change the way they would on the real
car.

Target user: a racer with a tape measure, camber gauge, and toe plates —
not an engineer with a CAD model. Every input must be something you can
measure or read off a part's spec sheet.

## 2. The actual car (primary target hardware)

- **Chassis**: fabricated; measured pickup points (measure once).
- **Upper control arms**: manufactured A-frames with **heim joints at the
  chassis pickups**. Two legs (front + rear), each leg's effective length
  adjustable by threading the heim (model thread pitch so adjustments can be
  entered in *turns* as well as inches). Legs converge to the upper BJ.
- **Lower control arms**: stock GM-style stamped arms. Fixed spec: pivot-axis
  to BJ length, BJ drop, spring pocket location on the arm.
- **Spindle**: GM "long" spindle, 3-piece (spindle body + bolt-on steering
  arm + brake bracket). Model body and steering arm as separate sub-parts so
  steering arms can be swapped independently. Do **not** hardcode guessed
  dimensions; provide a part card with fields + the calibration fallback (§5).
- **Steering**: pitman / center link (drag link) / idler, tie rods with
  adjustable sleeves.
- Left/right fully independent (circle track asymmetry is the norm).

## 3. Domain model (core/parts)

Every part is a plain serializable object with a `kind`, a `spec` (the part's
own geometry in its own local frame), and versionable identity so a garage/
parts-bin library is possible later.

```
Chassis {
  // frame coordinates (x fwd, y right, z up), origin on frame reference
  lowerPickups: {front: P, rear: P}         // per side
  upperPickups: {front: P, rear: P}         // heim mount centers, per side
  springPocketUpper: P                       // per side
  shockMountUpper: P                         // per side
  steeringBox: {pivot: P, pitmanEnd: P}
  idler: {pivot: P, armEnd: P}
  // pose over ground = SETUP, not chassis: rideHeightRef or per-corner heights
}
LowerArm {                                   // stock part, fixed
  length      // pivot axis -> BJ center (perpendicular radius)
  bjAxial     // BJ fore/aft position along pivot axis from front pivot
  bjDrop      // BJ below (+) the pivot axis plane
  springSeat  // {axial, radial, drop} on the arm
  shockSeat   // same form
}
UpperArm {                                   // heim-adjustable A-frame
  legFront: {baseLength, heimPitchTPI, turns} // effective length = base + turns/TPI
  legRear:  {baseLength, heimPitchTPI, turns}
  // BJ located by the two leg lengths from the two pickups (triangulation in
  // the arm plane) + bjDrop out of plane
  bjDrop
}
Spindle {                                    // GM long 3-piece
  height        // LBJ center -> UBJ center distance (rigid)
  // machined pin geometry relative to the kingpin (LBJ->UBJ) frame:
  pin: {heightAboveLBJ, inclinationDeg, sweepDeg, snoutLength} // -> hub face
  steeringArm: {length, drop, sweepDeg, side: 'front'|'rear'}  // bolt-on piece
  calibrated?: {pinDir: V3}    // from §5 calibration; overrides inclination/sweep
}
TieRod { baseLength, sleevePitchTPI, turns }
WheelTire { radius (loaded), width, offsetToHubFace }
```

**Setup state** (separate from parts — what you change between races):
per-corner ride height (or frame heights + rake), heim turns, tie rod turns,
slug/shim offsets if any mount is slotted, steering wheel angle, per-corner
travel (wheel or shock — DAQ shock travel is a first-class input).

## 4. Assembly solver (core/solve) — port from v4, it is validated

Solve per corner, warm-started, all root-finding via the v4 `solveRoot`
(Newton w/ numeric derivative + bracket-scan bisection fallback):

1. **Lower arm** angle θ rotates the BJ about the pickup axis.
2. **UBJ**: root-solve upper arm angle φ s.t. |UBJ−LBJ| = spindle.height.
   (Upper BJ position from the two heim leg lengths — recompute the arm's
   local BJ location whenever turns change.)
3. **Upright pose**: rigid transform anchored at LBJ; quaternion maps
   reference kingpin dir -> current, then rotate ψ about current kingpin.
4. **ψ from tie rod**: root-solve so |TRO(ψ) − TRI| = tieRod effective length.
   TRI from the pitman/center-link/idler 4-bar (root-solve idler angle β to
   hold center-link length; warm-start β).
5. **Ride trim**: after any part/setup change, root-solve θ so the wheel
   center returns to target ride height ("jack bolt"). The trim solve MUST go
   through the full chain incl. step 4 — ψ affects wheel height (v4 lesson;
   test enforces round-trip < 0.001").
6. **Wheel**: hub face = LBJ + pin geometry transformed by upright pose; tire
   located on the snout by WheelTire.offsetToHubFace. Contact patch under WC.

**Sign/coordinate invariants (hard-won, keep tests for them):**
- Frame: x fwd, y right (+), z up; left side geometry is real, never mirrored
  implicitly. Any rotation built from a side-symmetric quantity (camber!)
  must be mirrored with the side sign — v4 had a left-camber sign bug; the
  regression test must stay.
- Toe-in positive; toe reported in **inches across a configurable gauge
  diameter** (tape method), plus total toe (= what "LF straight, measure RF"
  reads). Camber negative = top in. Shock travel positive = compression.

**Metrics (core/metrics)**: camber, toe (in), caster, KPI, scrub radius,
mechanical trail (kingpin ground intercept), camber gain (local slope),
motion ratio (dShock/dWheel, numeric), per-side FVSA + instant centers,
roll center (front-view construction) + migration trail, Ackermann % (cot
difference vs track/wheelbase) + toe-out-on-turns, track width.

## 5. Spindle calibration fallback

Machined pin angles can't be tape-measured. Flow: assemble with the spindle's
pin fields blank -> app prompts for **measured camber + toe at known ride
height** -> back-solve `pinDir` in the kingpin frame -> store on the part as
`calibrated`. From then on the spindle is a reusable part card; alignment is
fully position-driven. (This is exactly v4's `wheelAxis0` construction —
port it, including the side-sign fix.)

## 6. App structure

```
src/
  core/        math.ts (vec/quat helpers, solveRoot, intersect2D)
               parts.ts  assembly.ts  metrics.ts  trim.ts
  state/       setup.ts (parts + setup state, save/load, v4-file importer)
  ui/          scene3d.ts (three.js: arms, knuckle w/ boss, spindle pin, hub,
                 tire torus+rim, spring/shock, steering linkage, RC + trails)
               frontview.ts (2D RC construction canvas — port from v4)
               charts.ts (camber / bump steer(in) / RC height vs travel, L+R)
               panels/ (parts editor, adjustments-in-turns, motion, display)
  tests/       vitest: port ALL 36 v4 checks + new part-level ones
reference/     suspension_sim.html (v4), measurement worksheet PDF
```

- Vite + TypeScript + three.js (real OrbitControls now — no CDN constraint).
- No backend; save/load = JSON files. Keep reading v4 setup files (write a
  converter: v4 hardpoints -> chassis + derived part specs).
- Visual bar from v4 to keep: dark telemetry aesthetic (#0d1014 bg, orange
  #ff6a1f right / cyan #36c2ff left / yellow #ffd23f RC), mono tabular HUD,
  knuckle as a body (LBJ->boss->UBJ) with pin + hub locating the wheel.

## 7. Test invariants to port (all pass in v4; keep numbers as fixtures)

- Static camber/toe == calibration inputs at reference; trim θ ≈ 0 at baseline.
- Wheel- and shock-travel round trips < 0.01"; full-chain trim (ψ included).
- L/R symmetry when parts are symmetric; left-camber-sign regression test.
- Bump: camber more negative; motion ratio in (0.3, 1.2); RC exists near
  center at rest, migrates laterally in roll.
- Adjustment directionality: upper legs longer -> camber positive; lower arm
  longer -> camber negative + track wider + ride re-trimmed; front-vs-rear
  heim split changes caster with small camber cross-talk; tie rod turns move
  toe with camber coupling ≈ sin(caster)·steer (real physics — don't "fix").
- Part rigidity under adjustment: arm swing radius and spindle height
  preserved to <0.02".

## 8. Milestones

1. Repo scaffold; port math + solver + metrics with vitest suite green.
2. Parts model + assembly from parts; v4-file importer; calibration flow.
3. 3D scene + HUD + charts + front-view (feature parity with v4).
4. Heim-turns adjustment UX; spindle/steering-arm part cards; garage library.
5. Later: DAQ import (per-corner shock travel traces -> replay through the
   model), rear 4-link integration toward the unified CLR Setup Suite.
