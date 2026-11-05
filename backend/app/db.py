"""数据库引擎与会话。每个 app 实例绑定独立的 Settings（便于测试隔离）。"""
from __future__ import annotations

from pathlib import Path
from typing import Generator

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def make_engine(db_path: Path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _record):  # pragma: no cover
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


def migrate(engine) -> None:
    """轻量结构迁移（create_all 不会改已有表）。

    segment_configs 增加 l3_id（三级分类覆盖）时，旧行 l2 唯一约束与多行 l3 覆盖冲突，
    需要重建表后拷贝数据。
    """
    insp = inspect(engine)
    if not insp.has_table("segment_configs"):
        return
    columns = {c["name"] for c in insp.get_columns("segment_configs")}
    if "l3_id" in columns:
        return
    from .models import SegmentConfig  # 延迟导入避免循环

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE segment_configs RENAME TO segment_configs_old"))
    Base.metadata.create_all(engine, tables=[SegmentConfig.__table__])
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO segment_configs (scope, l2_id, mode, params) "
                "SELECT scope, l2_id, mode, params FROM segment_configs_old"
            )
        )
        conn.execute(text("DROP TABLE segment_configs_old"))


def make_session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def make_db_dependency(session_factory) -> Generator[Session, None, None]:
    def get_db():
        db = session_factory()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    return get_db


def migrate_package_dirs(settings) -> None:
    """包目录从 {id} 迁移为 {入库日期}_{id}_{包名}（幂等，可重复执行）。"""
    import re
    import sqlite3
    from pathlib import Path as _P

    files_root = settings.files_dir
    if not settings.db_path.exists() or not files_root.exists():
        return

    def _clean(name: str) -> str:
        name = re.sub(r'[\/:*?"<>|\x00-\x1f]', "_", name).strip(". ")
        return name[:40] or "未命名"

    con = sqlite3.connect(settings.db_path)
    try:
        rows = con.execute("SELECT id, title, created_at FROM packages").fetchall()
        for pid, title, created in rows:
            old = files_root / str(pid)
            if not old.is_dir():
                continue
            date_part = str(created)[:10] or "unknown"
            new = files_root / f"{date_part}_{pid}_{_clean(title or '')}"
            if new == old or new.exists():
                continue
            old.rename(new)
            con.execute(
                "UPDATE files SET file_path = REPLACE(file_path, ?, ?) WHERE package_id = ?",
                (f"files/{pid}/", f"files/{new.name}/", pid),
            )
        con.commit()
    finally:
        con.close()
