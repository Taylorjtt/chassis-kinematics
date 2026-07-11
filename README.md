# CLR Suspension Builder

Parts-based front suspension simulator for dirt circle track (SLA / double
wishbone). You build the car from parts — chassis pickups, control arms,
spindle, tie rods — and **alignment is an output**: camber, caster, toe,
track width, scrub, and roll center all fall out of the solved geometry.
There is no camber input anywhere in the app.

Successor to the validated single-file prototype in
`reference/suspension_sim.html` (v4); the solver chain is a direct port and
the vitest suite locks in its invariants. See `CLR_SUSPENSION_SPEC.md` for
the full spec.

## Run it

```sh
npm install
npm run dev       # dev server
npm test          # vitest suite (solver / parts / importer invariants)
npm run build     # typecheck + production build to dist/
```

Note: `.npmrc` in this repo pins `os=win32` because the user-level
`~/.npmrc` sets `os=linux`, which breaks npm's native binaries on Windows.

## Layout

```
src/core/    math.ts (vec/quat, solveRoot, intersect2D) · parts.ts (domain
             model) · assembly.ts (solver chain) · trim.ts (ride trim,
             travel) · metrics.ts · calibrate.ts (spindle pin back-solve §5)
src/state/   setup.ts — save/load + v4-file importer (auto-detected)
src/ui/      scene3d.ts (three.js) · frontview.ts · charts.ts · panels.ts
tests/       vitest: v4 invariants + part-level checks (65 tests)
reference/   suspension_sim.html — the v4 prototype, ground truth
```

## Conventions (hard-won — do not "fix")

- Frame: x forward, z up, **+y = the driver's LEFT** (the right-handed third
  axis — note the spec's original "y right, z up, x fwd" is a left-handed
  declaration and was corrected once real scans met the math). Sides are
  always labeled from the DRIVER's perspective. Left geometry is real, never
  implicitly mirrored; side-symmetric part locals use a kingpin/forward/
  **outboard** basis so one part card fits either side. Save files carry a
  version; v1 saves (pre-fix) get their side labels migrated on load.
- Toe-in positive, reported in inches across a configurable gauge diameter.
  Camber negative = top in. Shock travel positive = compression.
- Ride trim runs the FULL chain including the tie-rod ψ solve (ψ moves the
  wheel height).
- Tie-rod turns couple into camber ≈ sin(caster)·steer — real physics.
- Deliberate deviation from v4: the calibration toe rotation sign is
  flipped (v4 had a latent bug, masked by its default measured toe of 0,
  where entering toe-in produced a wheel reporting toe-out).

## Roadmap (spec §8)

Heim-turns UX, part cards, and garage library are in. Next: DAQ import
(per-corner shock travel traces replayed through the model) and rear 4-link
integration toward the unified CLR Setup Suite — keep `src/core/` free of
DOM/renderer imports so it can grow into the whole-car sim.
