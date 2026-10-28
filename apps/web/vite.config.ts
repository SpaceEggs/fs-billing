import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiOrigin =
  process.env['FS_BILLING_API_ORIGIN'] ?? 'http://127.0.0.1:3000';
const proxy = { '/api': apiOrigin };

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // React 每一页都要，版本也很少变：单独成块，入口块只留应用自己的代码，升级应用时缓存仍可复用。
          groups: [
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
