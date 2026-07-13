# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

CLR Suspension Builder: a parts-based SLA (double wishbone) front-suspension
simulator for a dirt circle track car. The car is **built from parts**
(chassis pickup points, control arms, spindle, tie rods) and **alignment is
an output** — camber, caster, toe, track width, scrub, and roll center fall
out of the solved assembly. There is no camber input anywhere; never add one.
Full spec: `CLR_SUSPENSION_SPEC.md`. The validated v4 prototype this ports is
`reference/suspension_sim.html` — treat its solver as ground truth.

Long-term goal: grow into a whole-car sim (rear 4-link, DAQ shock-travel
replay). Keep `src/core/` free of DOM/three.js imports so it can.

## Commands

```sh
npm run dev       # Vite dev server (localhost:5173)
npm test          # vitest, ~90 tests — run after ANY core change
npm run build     # tsc --noEmit && vite build
npx vitest run tests/assembly.test.ts   # single file
```

`.npmrc` pins `os=win32` because the user-level `~/.npmrc` sets `os=linux`,
which makes npm install Linux native binaries on this Windows machine. Do not
remove it; use a clean `npm install` after deleting node_modules if rollup
native modules go missing.

## Architecture

```
src/core/     renderer-free solver — NEVER import DOM/three.js here
  math.ts       own Vec3/Quat (THREE-compatible semantics), solveRoot
                (Newton + bracket-scan fallback), intersect2D
  parts.ts      serializable part specs + Setup state (turns, slugs, ride)
  assembly.ts   solver chain, kingpin frame, diagnostics, arm-fit search
  trim.ts       ride trim ("jack bolt"), travel solvers, travelLimits,
                assembleFront (the recompute-everything entry point)
  metrics.ts    camber/toe/caster/KPI/scrub/RC/Ackermann, sweeps, clamping
  calibrate.ts  spindle pin back-solve from measured camber/toe
src/state/    setup.ts — save/load (versioned), v4 importer, armPickLengths
src/ui/       scene3d.ts (three.js), scan.ts (3D-scan import + alignment),
              panels.ts (part cards), charts.ts, frontview.ts
src/main.ts   app shell: state, rebuild/update loop, pick recipes, wizard
tests/        vitest — spec §7 invariants are regression-locked; keep them
```

Data flow: `parts + setup → assembleFront → CornerStatic (reference geometry,
trimmed) → solveFrontState(travel, steer) → FrontState → scene/HUD/charts`.
Every wrench input calls `rebuild()` (re-assembles, auto-saves, re-sweeps)
then `update()` (solves the current slider state and redraws).

## Hard-won conventions — do not "fix" these

- **Frame: x forward, z up, +y = the driver's LEFT** (right-handed).
  Sides are ALWAYS named from the driver's seat — the user (a racer) insists,
  and the physics forces it: the spec's original "y right, z up, x fwd" is a
  left-handed declaration and was corrected when real scans met the math.
  Save files are versioned; v1 saves get side labels migrated on load.
- Toe-in positive, reported in inches across a configurable gauge diameter.
  Camber negative = top in. Shock travel positive = compression.
- Ride trim must run the FULL chain including the tie-rod ψ solve (ψ moves
  wheel height — v4 lesson, test-enforced round trip < 0.001").
- Tie-rod turns couple into camber ≈ sin(caster)·steer. Real physics; the
  test asserts the relationship, don't suppress it.
- Tie rods connect to the center-link end **on their own side by geometry**
  (y comparison), never by pitman/idler naming — the steering box can be on
  either side of the chassis.
- Deliberate deviation from v4: the calibration toe-rotation sign is flipped
  (v4 had a latent bug masked by its default measToe = 0).
- Travel is clamped to `travelLimits` — beyond them the upper-arm constraint
  has no root and the knuckle would visually shrink. Never render an
  unconverged solve as if it were real.
- Every side-specific scan pick is ROUTED by where it lands (y sign);
  labels are hints. Facing a car flips left/right for humans.
- Hardware: adjusters are 3/4"-16 (16 TPI). Heim = 0.0625"/turn per leg,
  independently front/rear. LH/RH tie-rod sleeve = 0.125"/turn
  (`endsThreaded: 2`). The user's EinScan exports are in millimeters.

## Scan workflow (the core use case)

Load scan → "Measure whole car" wizard: align off the four lower-arm chassis
pivots + one hub (all frame-fixed, so a wheels-off full-droop scan on stands
is exact) → guided picks for every chassis/spindle point → assemble ONCE at
the end. Part measurements use pose-independent rigid quantities (arm swing
radius, heim-to-BJ distances, spindle locals in its kingpin frame), so droop
doesn't matter. Pin ANGLES can't be scanned — they come from the camber/toe
gauge calibration (§5). Assembly failures render a red measured-geometry
skeleton + reach numbers; single points are re-picked with their ⌖ buttons.

## UI expectations the user has set

- Everything auto-saves to localStorage (`clrAutosave`), including states
  that don't assemble — scan measurements must survive reloads.
- Baseline system: dashed ghost in 3D, Δ readouts under the adjustments,
  dashed baseline curves + live Δ readouts in every chart.
- BJ/hub coordinate fields and the magenta crosshair follow the CURRENT
  travel-slider pose so they line up with a drooped scan.
- Big controls: −/+ steppers, Shift+↑↓ = 0.01" nudge, H hides the sim model,
  S skips a wizard step, Esc cancels/undoes.
