import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 客户端（前端）独立构建。
 *
 * 两种跑法：
 *   1. **同源**（默认）：dev server 把 `/api`、`/ws`、`/healthz` 代理到本地服务端，
 *      构建产物交给服务端用 `PUBLIC_DIR` 托管。零配置。
 *   2. **前后端分离**：设 `VITE_API_BASE=https://api.example.com` 再构建，
 *      客户端所有请求与 WS 都指向它（见 src/lib/endpoint.ts），
 *      服务端那边要设 `CORS_ORIGINS` 允许这个来源。
 *
 * 代理目标可用 `VITE_PROXY_TARGET` 改（默认本地 3000），
 * 这样把客户端指到另一台机器的服务端时不用改代码。
 */
const proxyTarget = process.env['VITE_PROXY_TARGET'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true },
      '/healthz': { target: proxyTarget, changeOrigin: true },
      '/ws': { target: proxyTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
