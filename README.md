# zzlibrary

面向个人的多端资料管理与阅读器（个人资料库）。核心特色是 **虚拟图书馆书架**：时间分段是书架层、三级分类是单座书架、二级分类是一排书架；Y-Z 侧视与 X-Z 比例时间轴（跨层年代对齐）两种视图。

## 技术栈

- **后端** `backend/`：Python FastAPI + SQLAlchemy + SQLite，单账号会话认证，EPUB/PDF/TXT/MD/HTML/docx/pptx/xlsx 元数据抽取与封面/书脊贴图后端渲染
- **Web** `web/`：React 19 + TypeScript + Vite + Tailwind CSS
- **共享包** `packages/shared`：TS 类型 + API 客户端（Web 与 Expo 共用）
- **移动端** `mobile/`（规划中）：Expo + expo-gl，复用 3D 书架场景包

## 开发

```bash
# 后端（依赖装入 uv 管理的 base venv）
uv pip install --python <你的base venv python> -r backend/pyproject.toml --extra dev
cd backend && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# 前端（Node >= 20）
npm install
npm run dev -w @zzlibrary/web   # http://localhost:5173，/api 代理到 8000
```

默认账号 `admin / zzlibrary`（用环境变量 `ZZLIB_USERNAME` / `ZZLIB_PASSWORD` 修改，密码支持 pbkdf2 哈希：`python -m app.hash_password`）。

## 文档

需求与里程碑见 [docs/需求说明.md](docs/需求说明.md)。
