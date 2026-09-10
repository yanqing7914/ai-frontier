import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:13002';

export default defineConfig({
  root: path.resolve(__dirname),
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@client': path.resolve(__dirname, 'client'),
      '@': path.resolve(__dirname, 'client/src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.CLIENT_DEV_PORT || 5173),
    strictPort: true,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
