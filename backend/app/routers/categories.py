"""分类树管理。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import get_category, get_db, require_session
from ..models import Category
from ..schemas import CategoryCreate, CategoryOut, CategoryUpdate

router = APIRouter(prefix="/api/categories", tags=["categories"])


def _tree(db: Session, parent_id: int | None = None) -> list[CategoryOut]:
    nodes = db.execute(
        select(Category).where(Category.parent_id == parent_id).order_by(Category.sort_order, Category.id)
    ).scalars().all()
    return [
        CategoryOut(
            id=n.id,
            level=n.level,
            parent_id=n.parent_id,
            name=n.name,
            sort_order=n.sort_order,
            children=_tree(db, n.id),
        )
        for n in nodes
    ]


@router.get("")
def list_categories(db: Session = Depends(get_db), _user: str = Depends(require_session)):
    return _tree(db)


@router.post("", status_code=201)
def create_category(
    payload: CategoryCreate,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    parent = get_category(db, payload.parent_id) if payload.parent_id else None
    if payload.parent_id and parent is None:
        raise HTTPException(422, "上级分类不存在")
    level = (parent.level + 1) if parent else 1
    if level > 3:
        raise HTTPException(422, "最多支持三级分类")
    max_order = db.execute(
        select(Category.sort_order).where(Category.parent_id == (parent.id if parent else None)).order_by(Category.sort_order.desc()).limit(1)
    ).scalar()
    node = Category(
        name=payload.name.strip(),
        level=level,
        parent_id=parent.id if parent else None,
        sort_order=(max_order + 1) if max_order is not None else 0,
    )
    db.add(node)
    db.flush()
    return CategoryOut(
        id=node.id, level=node.level, parent_id=node.parent_id, name=node.name, sort_order=node.sort_order
    )


@router.patch("/{cid}")
def update_category(
    cid: int,
    payload: CategoryUpdate,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    node = get_category(db, cid)
    if node is None:
        raise HTTPException(404, "分类不存在")

    if payload.name is not None:
        node.name = payload.name.strip()
    if payload.sort_order is not None:
        node.sort_order = payload.sort_order
    if payload.parent_id is not None:
        new_parent = get_category(db, payload.parent_id) if payload.parent_id else None
        if payload.parent_id and new_parent is None:
            raise HTTPException(422, "目标上级分类不存在")
        has_children = db.execute(
            select(Category.id).where(Category.parent_id == node.id).limit(1)
        ).first()
        if has_children:
            raise HTTPException(422, "该分类包含子分类，不能移动（请先移走子分类）")
        if new_parent is None:
            if node.level != 1:
                raise HTTPException(422, "只有一级分类可以移到顶层")
            node.parent_id = None
        else:
            if new_parent.level + 1 != node.level:
                raise HTTPException(422, f"「{node.name}」是{'一二三'[node.level - 1]}级分类，只能移到同级分类之下")
            if new_parent.id == node.id:
                raise HTTPException(422, "不能把自己作为上级")
            node.parent_id = new_parent.id
    db.flush()
    return CategoryOut(
        id=node.id, level=node.level, parent_id=node.parent_id, name=node.name, sort_order=node.sort_order
    )


@router.delete("/{cid}")
def delete_category(
    cid: int,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    node = get_category(db, cid)
    if node is None:
        raise HTTPException(404, "分类不存在")
    has_children = db.execute(select(Category.id).where(Category.parent_id == node.id).limit(1)).first()
    if has_children:
        raise HTTPException(422, "该分类包含子分类，请先删除子分类")

    # 引用该分类的包路径由外键级联删除（FK ondelete=CASCADE + PRAGMA foreign_tables=ON）
    db.delete(node)
    db.flush()
    return {"ok": True}
