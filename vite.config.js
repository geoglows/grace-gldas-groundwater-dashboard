import {defineConfig, loadEnv} from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  // Only genuine standalone preview deploys are served at the domain root.
  // Production AND the staging custom environment are served under the portal
  // subpath (/grace-groundwater/), so both must honor VITE_BASE_PATH. VERCEL_ENV
  // is 'preview' for a custom environment, so key off VERCEL_TARGET_ENV, which
  // carries the custom environment name ('staging').
  const targetEnv = env.VERCEL_TARGET_ENV || env.VERCEL_ENV;
  const servedAtRoot =
    env.VERCEL === '1' && targetEnv !== 'production' && targetEnv !== 'staging';

  return {
    base: servedAtRoot ? '/' : env.VITE_BASE_PATH || '/',
    plugins: [tailwindcss()],
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
    server: {
      watch: {
        ignored: [
          '**/data_processors/**',
        ],
      },
    },
  };
});
