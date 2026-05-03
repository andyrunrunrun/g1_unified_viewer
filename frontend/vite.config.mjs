import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  plugins: [vue()],
  optimizeDeps: {
    exclude: ['mujoco-js']
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://127.0.0.1:8050',
      '/static': 'http://127.0.0.1:8050',
      '/policy-plugins': 'http://127.0.0.1:8050'
    }
  }
});
