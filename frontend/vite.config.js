import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = 'http://localhost:5000';

// The console talks to the backend through the dev server, so no CORS or base URL config is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': api, '/t': api, '/u': api },
  },
});
