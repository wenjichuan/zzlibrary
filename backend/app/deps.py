"""路由公共依赖与校验工具。"""
from __future__ import annotations

from typing import Generator

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Category


def get_db(request: Request) -> Generator[Session, None, None]:
    yield from request.app.state.get_db()


def require_session(request: Request) -> str:
    return request.app.state.require_session(request)


def get_category(db: Session, cid: int | None) -> Category | None:
    if cid is None:
        return None
    return db.get(Category, cid)


def resolve_category_chain(
    db: Session,
    l1_id: int | None,
    l2_id: int | None,
    l3_id: int | None,
) -> tuple[int | None, int | None, int | None]:
    """校验并推导分类链：l3 必须属于 l2，l2 必须属于 l1；给出下级时自动补全上级。"""
    l1 = l2 = l3 = None
    if l3_id is not None:
        l3 = get_category(db, l3_id)
        if l3 is None or l3.level != 3:
            raise HTTPException(422, "三级分类不存在")
    if l2_id is not None or l3 is not None:
        effective_l2 = l2_id if l2_id is not None else (l3.parent_id if l3 else None)
        l2 = get_category(db, effective_l2)
        if l2 is None or l2.level != 2:
            raise HTTPException(422, "二级分类不存在")
        if l3 is not None and l3.parent_id != l2.id:
            raise HTTPException(422, f"三级分类「{l3.name}」不属于二级分类「{l2.name}」")
    if l1_id is not None or l2 is not None:
        effective_l1 = l1_id if l1_id is not None else l2.parent_id
        l1 = get_category(db, effective_l1)
        if l1 is None or l1.level != 1:
            raise HTTPException(422, "一级分类不存在")
        if l2 is not None and l2.parent_id != l1.id:
            raise HTTPException(422, f"二级分类「{l2.name}」不属于一级分类「{l1.name}」")
    return (l1.id if l1 else None, l2.id if l2 else None, l3.id if l3 else None)


def resolve_paths(db: Session, paths) -> list[tuple[int | None, int | None, int | None]]:
    """逐条校验分类路径并去重（PathIn 列表 → (l1,l2,l3) 元组列表）。

    每条路径最终必须能落到一个一级分类（给出 l2 时自动补全 l1）。
    """
    resolved: list[tuple[int | None, int | None, int | None]] = []
    seen: set[tuple[int | None, int | None, int | None]] = set()
    for p in paths or []:
        tri = resolve_category_chain(db, p.l1_id, p.l2_id, p.l3_id)
        if tri[0] is None:
            raise HTTPException(422, "分类路径必须包含一级分类")
        if tri not in seen:
            seen.add(tri)
            resolved.append(tri)
    return resolved


def parse_id_filter(raw: str | None) -> tuple[int | None, bool]:
    """查询参数解析：数字 → (id, False)；'none' → (None, True)；缺失 → (None, False)。"""
    if raw is None or raw == "":
        return None, False
    if raw == "none":
        return None, True
    try:
        return int(raw), False
    except ValueError:
        raise HTTPException(422, f"分类参数无效：{raw}") from None
