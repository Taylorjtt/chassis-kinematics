import { defineConfig } from 'vite';

/**
 * When shipping to closedloopracing.com, DEPLOY_TARGET=site is set so all
 * asset URLs (including the dynamic sql-wasm.wasm import) resolve under the
 * site's tools subpath. Local `npm run dev` and standalone dist keep the
 * relative-URL default so they work at any root.
 */
export default defineConfig({
  base: process.env.DEPLOY_TARGET === 'site' ? '/tools/suspension-builder/' : './',
  build: { target: 'es2022' },
});
