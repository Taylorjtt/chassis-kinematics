/*
 * Demo-mode boot: fetch shipped demo assets in parallel, hydrate a fresh
 * Replay session, and hand back everything main.ts needs to open the sim on
 * the best lap paused.
 *
 * Two-tier bundle load:
 *   1. Hero (demo-lap.zip): small, ~3 MB — fetched IN THE MAIN PATH. Sim is
 *      interactive as soon as this resolves.
 *   2. Full (demo-session.zip): 22 MB — fetched via `fetchFullBundleInBackground`
 *      after the sim is live. Caller swaps in-place when it resolves.
 */

import type { FrontEnd, Setup } from '../../core/parts';
import { fetchDemoCar, fetchDemoFullBundle, fetchDemoHeroBundle } from '../../state/demoDefaults';
import { loadBundle } from './bundle';
import type { Bundle } from './bundle';

export interface DemoBootResult {
  car: { front: FrontEnd; setup: Setup } | null;
  bundle: Bundle | null;
  bestLap: number | null;
}

/** Fetch demo car + hero telemetry bundle in parallel; return the pieces
 *  main.ts needs to open Replay mode primed on the best lap. Any missing
 *  asset returns null in its slot — the caller handles graceful degradation.
 */
export async function bootDemoMode(): Promise<DemoBootResult> {
  const [car, heroBlob] = await Promise.all([
    fetchDemoCar(),
    fetchDemoHeroBundle(),
  ]);
  let bundle: Bundle | null = null;
  let bestLap: number | null = null;
  if (heroBlob) {
    try {
      bundle = await loadBundle(heroBlob);
      // best lap = smallest positive lapTimeMs among valid laps
      const valid = bundle.laps.filter((l) => l.isValid && l.lapTimeMs > 0);
      if (valid.length) {
        bestLap = valid.reduce((a, b) => (a.lapTimeMs <= b.lapTimeMs ? a : b)).lapNumber;
      }
    } catch (err) {
      console.warn('demo hero bundle failed to load:', err);
    }
  }
  return { car, bundle, bestLap };
}

/** After the sim is live, fetch the full session bundle. Caller invokes on
 *  the returned Promise; when it resolves with a Bundle, swap it in place of
 *  the hero bundle. Uses requestIdleCallback so the first-paint isn't delayed. */
export function fetchFullBundleInBackground(): Promise<Bundle | null> {
  return new Promise((resolve) => {
    const kick = async () => {
      const blob = await fetchDemoFullBundle();
      if (!blob) { resolve(null); return; }
      try { resolve(await loadBundle(blob)); }
      catch (err) { console.warn('demo full bundle failed to load:', err); resolve(null); }
    };
    // Prefer idle callback; fall back to a small timeout on Safari
    if ('requestIdleCallback' in window) {
      (window as unknown as { requestIdleCallback: (cb: () => void) => void })
        .requestIdleCallback(kick);
    } else {
      setTimeout(kick, 500);
    }
  });
}
