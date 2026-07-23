import {defineConfig, loadEnv} from 'vite';
import tailwindcss from '@tailwindcss/vite';

// The base path is baked into the bundle at BUILD time — index.html, every JS
// chunk, the worker URL, and every asset URL are emitted with it as a prefix.
// A build whose base does not match where it is actually served fails
// completely and confusingly: the browser requests /<stale-base>/assets/*.js
// and the CDN answers 404 (or 503, which is what CloudFront returns when no
// cache behavior matches the path) for every single module. There is exactly
// one knob — VITE_BASE_PATH — and the resolved value is printed below so a
// mismatch is visible in the deploy log instead of only in a broken browser.
const normalizeBase = (value) => {
  const trimmed = (value ?? '').trim();
  if (!trimmed || trimmed === '/') return '/';
  // An absolute origin (e.g. https://cdn.example.com/app) is passed through so
  // assets can be served from a different host than index.html.
  if (/^https?:\/\//i.test(trimmed)) return `${trimmed.replace(/\/+$/, '')}/`;
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
};

export default defineConfig(({mode, command}) => {
  const env = loadEnv(mode, '.', '');
  // Only genuine standalone preview deploys are served at the domain root.
  // Production AND the staging custom environment are served under the portal
  // subpath, so both must honor VITE_BASE_PATH. VERCEL_ENV is 'preview' for a
  // custom environment, so key off VERCEL_TARGET_ENV, which carries the custom
  // environment name ('staging').
  const targetEnv = env.VERCEL_TARGET_ENV || env.VERCEL_ENV;
  const servedAtRoot =
    env.VERCEL === '1' && targetEnv !== 'production' && targetEnv !== 'staging';

  const base = servedAtRoot ? '/' : normalizeBase(env.VITE_BASE_PATH);

  if (command === 'build') {
    console.log(
      `[vite] base=${base}  (VITE_BASE_PATH=${env.VITE_BASE_PATH ?? '<unset>'}, ` +
      `VERCEL_TARGET_ENV=${targetEnv ?? '<unset>'}, servedAtRoot=${servedAtRoot})\n` +
      `[vite] this build only works when served from ${base} — a mismatch 404/503s every asset.`,
    );
  }

  return {
    base,
    plugins: [tailwindcss()],
    build: {
      // The ArcGIS SDK explodes into ~1300 tiny ES modules. Vite's default
      // behavior injects a <link rel="modulepreload"> for the entire entry
      // import graph (~465 tags), so the browser fires ~465 concurrent HTTP/2
      // requests at the CDN the instant it parses <head> — before the app even
      // runs. That synchronized avalanche over a single connection trips
      // CloudFront's per-connection concurrency limit, which answers 503 for a
      // large fraction of them (the browser reports net::ERR_ABORTED 503). The
      // same requests spread across separate connections never fail.
      //
      // Two mitigations, together:
      //  1. modulePreload.polyfill stays but we cap the preload avalanche by
      //     dropping the blanket preload — modules load as imports resolve.
      //  2. manualChunks consolidates vendor code into a handful of larger
      //     chunks so there are far fewer requests to begin with.
      modulePreload: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@arcgis') || id.includes('@esri')) return 'arcgis';
            if (id.includes('zarrita') || id.includes('numcodecs')) return 'zarr';
            if (id.includes('chart.js') || id.includes('date-fns')) return 'charts';
            return 'vendor';
          },
        },
      },
    },
    define: {
      global: 'globalThis',
    },
    optimizeDeps: {
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
      },
    },
    // The global-frame loaders are ES module workers (see globalFramesClient.js);
    // building them as ESM keeps their import graph shared with the main bundle
    // instead of duplicating zarrita into an IIFE.
    worker: {
      format: 'es',
    },
    server: {
      watch: {
        ignored: [
          '**/data_processors/**',
        ],
      },
    },
  };
});
