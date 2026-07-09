import {defineConfig, loadEnv} from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const isVercelNonProd =
    env.VERCEL === '1' && env.VERCEL_ENV !== 'production';

  return {
    base: isVercelNonProd ? '/' : env.VITE_BASE_PATH || '/',
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
