import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The guardian pages (SMS links /i/<code> and /l/<code>). In development the page and the server
// look like one site: /g/... (API and live updates) is passed on to the server.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'VITE_');
  const api = process.env.VITE_API_URL ?? env.VITE_API_URL ?? 'http://localhost:3000';
  return {
    plugins: [react()],
    // Read VITE_* settings from the one .env at the project root.
    envDir: '../..',
    server: {
      // Must match GUARDIAN_WEB_URL (the address in the SMS links).
      port: 5175,
      strictPort: true,
      proxy: { '^/g/': { target: api, ws: true, changeOrigin: true } },
    },
    preview: { port: 5175, strictPort: true },
  };
});
