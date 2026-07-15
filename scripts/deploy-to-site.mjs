#!/usr/bin/env node
/*
 * Build the sim for the closed-loop-racing-site deploy target and copy the
 * output into the site's public/tools/ directory. Also refreshes the site's
 * Next.js iframe page so it points at the new bundle path.
 *
 * Usage: npm run deploy:site
 */

import { execSync } from 'child_process';
import { cpSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIM_ROOT = resolve(__dirname, '..');
const SITE_ROOT = resolve(SIM_ROOT, '../closed-loop-racing-site');
const SITE_TOOLS_DIR = resolve(SITE_ROOT, 'public/tools/suspension-builder');
const SITE_PAGE = resolve(SITE_ROOT, 'src/app/(main)/tools/front-suspension-sim/page.tsx');

if (!existsSync(SITE_ROOT)) {
  console.error(`site repo not found at ${SITE_ROOT}`);
  process.exit(1);
}

// Sanity-check the demo assets before building
for (const f of ['demo-car.json', 'demo-lap.zip', 'demo-session.zip']) {
  const p = resolve(SIM_ROOT, 'public', f);
  if (!existsSync(p)) {
    console.warn(`WARNING: public/${f} is missing — demo boot will degrade for this asset`);
  } else {
    const sz = statSync(p).size / 1e6;
    console.log(`public/${f}: ${sz.toFixed(2)} MB`);
  }
}

console.log('\nbuilding sim for site deploy...');
execSync('npm run build', {
  cwd: SIM_ROOT,
  env: { ...process.env, DEPLOY_TARGET: 'site' },
  stdio: 'inherit',
});

console.log(`\ncopying dist → ${SITE_TOOLS_DIR}`);
if (existsSync(SITE_TOOLS_DIR)) rmSync(SITE_TOOLS_DIR, { recursive: true });
mkdirSync(SITE_TOOLS_DIR, { recursive: true });
cpSync(resolve(SIM_ROOT, 'dist'), SITE_TOOLS_DIR, { recursive: true });

// Update the site's iframe page to point at the new sim
if (existsSync(SITE_PAGE)) {
  const src = readFileSync(SITE_PAGE, 'utf8');
  // Update the sim path but keep any query string (e.g. ?demo=1) intact
  const updated = src.replace(
    /src="\/tools\/[^"?]+\.html(\?[^"]*)?"/g,
    (_m, qs = '') => `src="/tools/suspension-builder/index.html${qs || '?demo=1'}"`,
  );
  if (updated !== src) {
    writeFileSync(SITE_PAGE, updated);
    console.log(`updated iframe src in ${SITE_PAGE}`);
  } else {
    console.log(`iframe src in ${SITE_PAGE} already points at the new sim (no change)`);
  }
} else {
  console.warn(`WARNING: could not find ${SITE_PAGE} — update the iframe src manually`);
}

console.log('\ndeploy complete.');
console.log(`  next: cd ${SITE_ROOT} && npm run dev → visit /tools/front-suspension-sim`);
