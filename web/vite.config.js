import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 开发期：前端 5173，API/SSE 代理到后端 8788
export default defineConfig({
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        // SSE 需要保持长连接
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('connection', 'keep-alive'));
        },
      },
    },
  },
});
