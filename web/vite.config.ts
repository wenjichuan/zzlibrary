import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // workspace 内 TS 源直引（域核心与各端共用一份；勿走 node_modules 预打包）
      "@zzlibrary/core": fileURLToPath(new URL("../packages/core/src/index.ts", import.meta.url)),
    },
  },
  server: {
    host: true, // 监听局域网（手机等设备访问）
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  preview: {
    host: true,
    proxy: {
      // vite preview 也带 /api 代理——生产构建验证不再静默 404
      "/api": "http://127.0.0.1:8000",
    },
  },
  build: {
    outDir: "dist",
  },
});
