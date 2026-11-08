# zzlibrary

面向个人的多端资料管理与阅读器（个人资料库）。核心特色是 **虚拟图书馆书架**：时间分段是书架层、三级分类是单座书架、二级分类是一排书架；Y-Z 侧视与 X-Z 弹性时间轴长卷（跨层年代对齐）两种视图。

**1.0（release_v1.0）为本地优先离线版**：资料全部保存在本机，不联网、不上云，跨设备云同步将在后续版本提供；设置页提供「备份整库到本机目录」作为数据安全兜底。业务逻辑全部收进 `@zzlibrary/core`（纯 TS，所有端共用），新功能只写一份。

## 技术栈

- **域核心** `packages/core`：纯 TS 业务逻辑（日期/时间分段/聚合/包状态/入库规则），全端共用
- **服务端** `packages/server`：Hono + node:sqlite + sharp——API、入库、封面/书脊生成、Range 流；Node ≥ 24（用内置 node:sqlite）
- **Web** `web/`：React 19 + TypeScript + Vite + Tailwind CSS
- **共享包** `packages/shared`：TS 类型 + API 客户端
- **移动端 / 桌面端**（规划中）：Expo（含鸿蒙 RNOH）/ Tauri，嵌入 core

## 开发

```bash
# 服务端（Node >= 24）
npm install
npm run dev -w @zzlibrary/server   # :8000，ZZLIB_DATA_DIR / ZZLIB_PORT 可覆盖

# 前端
npm run dev -w @zzlibrary/web      # http://localhost:5173，/api 代理到 8000

# 测试
npm test -w @zzlibrary/core && npm test -w @zzlibrary/server
```

默认账号 `admin / zzlibrary`（用环境变量 `ZZLIB_USERNAME` / `ZZLIB_PASSWORD` 修改，密码支持 pbkdf2 哈希）。

## 文档

需求与里程碑见 [docs/需求说明.md](docs/需求说明.md)。
