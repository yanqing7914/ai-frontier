import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Local browser runs use the root path; hosted deployments can provide a base path.
  base: process.env.LOCAL_DEV === 'true' ? '/' : undefined,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
      // Keep Vite aligned with the TypeScript path used by existing client modules.
      '@client': path.resolve(__dirname, 'client'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
});
