import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiOrigin =
  process.env['FS_BILLING_API_ORIGIN'] ?? 'http://127.0.0.1:3000';
const proxy = { '/api': apiOrigin };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
});
