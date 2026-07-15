/*
 * Demo defaults for the hosted CLR site build.
 *
 * On boot the sim checks for shipped demo assets and — when a first-time
 * visitor arrives — hydrates state from them so the sim opens fully loaded.
 * Assets live under `public/` and are copied through to `dist/` by Vite:
 *   demo-car.json     — saved parts + setup (small)
 *   demo-lap.zip      — hero telemetry bundle (small, ~3 MB)
 *   demo-session.zip  — full telemetry bundle (~22 MB, background-loaded)
 *   demo-scan.glb     — pre-aligned scan mesh (optional; skipped if missing)
 *
 * A missing asset is not an error — the demo boot degrades gracefully. That
 * keeps `npm run dev` working during development (no need to fetch a bundle
 * every reload) and doesn't fail the sim if the CDN is slow.
 */

import { FrontEnd, Setup } from '../core/parts';
import { loadStateJSON } from './setup';

const DEMO_CAR_PATH = 'demo-car.json';
const DEMO_LAP_PATH = 'demo-lap.zip';
const DEMO_SESSION_PATH = 'demo-session.zip';
const DEMO_SCAN_PATH = 'demo-scan.glb';

/** Resolve a demo asset path relative to Vite's base URL. */
function assetUrl(rel: string): string {
  // import.meta.env.BASE_URL — '/' in dev, '/tools/suspension-builder/' on the site build
  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  return `${base}/${rel}`;
}

/** Fetch demo-car.json + parse into { front, setup }. Returns null if the
 *  file isn't shipped (dev builds without the demo assets). */
export async function fetchDemoCar(): Promise<{ front: FrontEnd; setup: Setup } | null> {
  try {
    const res = await fetch(assetUrl(DEMO_CAR_PATH), { cache: 'default' });
    if (!res.ok) return null;
    const text = await res.text();
    const loaded = loadStateJSON(text);
    return { front: loaded.front, setup: loaded.setup };
  } catch { return null; }
}

/** Fetch the hero telemetry bundle as a Blob (or null if not shipped). */
export async function fetchDemoHeroBundle(): Promise<Blob | null> {
  try {
    const res = await fetch(assetUrl(DEMO_LAP_PATH), { cache: 'default' });
    return res.ok ? await res.blob() : null;
  } catch { return null; }
}

/** Fetch the full session bundle as a Blob (background load). */
export async function fetchDemoFullBundle(): Promise<Blob | null> {
  try {
    const res = await fetch(assetUrl(DEMO_SESSION_PATH), { cache: 'default' });
    return res.ok ? await res.blob() : null;
  } catch { return null; }
}

/** Fetch the pre-aligned scan mesh (Blob or null). */
export async function fetchDemoScan(): Promise<Blob | null> {
  try {
    const res = await fetch(assetUrl(DEMO_SCAN_PATH), { cache: 'default' });
    return res.ok ? await res.blob() : null;
  } catch { return null; }
}

/** Are the core demo assets shipped in this build? Used to gate demo UI
 *  affordances (Reset to CLR demo, splash logo, etc.). */
export async function hasDemoAssets(): Promise<boolean> {
  try {
    const res = await fetch(assetUrl(DEMO_CAR_PATH), { method: 'HEAD' });
    return res.ok;
  } catch { return false; }
}
