import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Read VITE_* settings from the one .env at the project root.
  envDir: '../..',
  server: {
    port: 5173,
    // Fail instead of picking another port: the server only accepts this exact origin.
    strictPort: true,
  },
});
