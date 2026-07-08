import {defineConfig} from 'vite';

export default defineConfig({
  define: {
    global: 'globalThis',
  },
  server: {
    watch: {
      ignored: [
        '**/data_processors/**',
      ],
    },
  },
});
