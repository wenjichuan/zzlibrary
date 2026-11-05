"""应用工厂与入口（uvicorn app.main:app）。"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import REPO_ROOT, Settings, default_settings
from .db import Base, make_engine, make_session_factory, migrate, migrate_package_dirs
from .routers import auth, categories, packages, progress, segment_config, shelves
from .security import SessionManager, make_auth_dependency
from .db import make_db_dependency

logger = logging.getLogger("zzlibrary")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or default_settings()
    settings.ensure_dirs()
    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    sessions = SessionManager(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        Base.metadata.create_all(engine)
        migrate(engine)
        migrate_package_dirs(settings)
        # 存量对账：按当前规则重算所有包状态（幂等；规则演进/历史手动值在此归位）
        from .services.status import recompute_all_package_statuses

        with session_factory() as db:
            changed = recompute_all_package_statuses(db)
        if changed:
            logger.info("包状态存量对账：重算了 %d 个包", changed)
        # 启动兜底：清掉超期暂存（否则只在下次上传时才懒清理）
        from .routers.packages import _purge_stale_staging

        _purge_stale_staging(settings)
        if settings.password == "zzlibrary":
            logger.warning(
                "正在使用默认密码 zzlibrary（环境变量 ZZLIB_PASSWORD 可修改；"
                "也支持 pbkdf2$... 哈希，可用 python -m app.hash_password 生成）"
            )
        yield

    app = FastAPI(title="zzlibrary", version="0.1.0", lifespan=lifespan)

    app.state.settings = settings
    app.state.get_db = make_db_dependency(session_factory)
    app.state.sessions = sessions
    app.state.require_session = make_auth_dependency(settings, sessions)

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    for router in (auth.router, categories.router, packages.router, shelves.router, segment_config.router, progress.router):
        app.include_router(router)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.exception_handler(404)
    async def _spa_fallback(request, exc):  # 生产模式：Web SPA 深链回退到 index.html
        dist = REPO_ROOT / "web" / "dist"
        if request.url.path.startswith("/api") or not (dist / "index.html").exists():
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        return FileResponse(dist / "index.html")

    dist = REPO_ROOT / "web" / "dist"
    if (dist / "assets").exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    return app


app = create_app()
