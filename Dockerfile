# zzlibrary 服务端镜像（自包含构建：仓库代码进 → bundle 出）
# 构建：docker build -t zzlibrary .
# 运行：docker run -d -p 8000:8000 -v /path/to/data:/data ghcr.io/wenobug/zzlibrary
# 注：本地无 Docker 环境，本文件经 CI（release.yml）构建验证。

# —— 构建阶段：npm ci + server bundle + web 构建 ——
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
# 全工作区安装（sharp 预编译件随平台自动选择 linux-x64）
RUN npm ci
COPY packages ./packages
COPY web ./web
COPY scripts ./scripts
COPY tsconfig.base.json* ./
RUN node scripts/build-server.mjs \
  && cd web && npm run build

# —— 运行阶段：只带 bundle + web 产物 ——
FROM node:24-slim
WORKDIR /app
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/web/dist ./web/dist
# 数据目录独立卷；应用根=/app（dist-server 父目录，根解析零配置）
ENV ZZLIB_DATA_DIR=/data \
    NODE_ENV=production
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist-server/index.js"]
