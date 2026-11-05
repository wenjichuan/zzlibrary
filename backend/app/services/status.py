"""包状态推导：由**可读文件**的阅读进度聚合；存储列 + 写入路径增量维护。

读多写少（进度写入低频，列表/书架/按状态筛选高频且需要索引），
故 status 作为物化缓存存列上，仅在写入事件（写进度、包内文件增删、入库）时重算受影响的包。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..models import FileItem, Package
from .ingest import KNOWN_FORMATS

READ_DONE_THRESHOLD = 98.0


def recompute_package_status(pkg: Package) -> None:
    """任一可读文件在读→在读；全部可读文件读完→已读；全未读→未读。

    不可读格式（无阅读深度，如 zip/bin 等未知格式）中性，不参与聚合；
    无可读文件的包 status=""（界面显示「—」）。
    """
    states = []
    for f in pkg.files:
        if f.format not in KNOWN_FORMATS:
            continue
        p = f.progress
        if p is None:
            states.append("未读")
        elif p.percent >= READ_DONE_THRESHOLD:
            states.append("已读")
        else:
            states.append("在读")
    if not states:
        pkg.status = ""
    elif all(s == "已读" for s in states):
        pkg.status = "已读"
    elif any(s == "在读" for s in states):
        pkg.status = "在读"
    else:
        pkg.status = "未读"


def recompute_all_package_statuses(db: Session) -> int:
    """存量迁移/启动对账：按当前规则重算所有包。幂等，返回发生变化的包数。"""
    changed = 0
    pkgs = db.scalars(
        select(Package).options(selectinload(Package.files).selectinload(FileItem.progress))
    ).all()
    for pkg in pkgs:
        before = pkg.status
        recompute_package_status(pkg)
        if pkg.status != before:
            changed += 1
    db.commit()
    return changed
