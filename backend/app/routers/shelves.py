"""书架聚合 API：3D 书架视图的数据源（以资料包为单位，多分类路径）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..deps import get_db, parse_id_filter, require_session
from ..models import Category, Package, PackagePath
from ..schemas import ShelfPackage, display_date
from ..services.aggregate import build_shelves, filter_shelf_packages, resolve_config
from ..services.segmentation import compute_grid

router = APIRouter(prefix="/api/shelves", tags=["shelves"])


def _l1_or_404(db: Session, l1_id: int) -> Category:
    c = db.get(Category, l1_id)
    if c is None or c.level != 1:
        raise HTTPException(404, "一级分类不存在")
    return c


def _load_l1_packages(db: Session, l1_id: int) -> list[Package]:
    """加载至少一条路径属于该一级分类的包。"""
    return list(
        db.execute(
            select(Package)
            .where(
                select(PackagePath.id).where(
                    PackagePath.package_id == Package.id,
                    PackagePath.l1_id == l1_id,
                ).exists()
            )
            .options(selectinload(Package.files), selectinload(Package.paths))
        ).scalars()
    )


@router.get("")
def shelves(
    l1: int = Query(...),
    with_packages: bool = Query(False),
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    l1_cat = _l1_or_404(db, l1)
    pkgs = _load_l1_packages(db, l1)
    return build_shelves(db, l1_cat, pkgs, include_packages=with_packages)


@router.get("/packages", response_model=list[ShelfPackage])
def shelf_packages(
    l1: int = Query(...),
    l2: str | None = Query(None),
    l3: str | None = Query(None),
    segment: str | None = Query(None),
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    l1_cat = _l1_or_404(db, l1)
    l2_id, l2_none = parse_id_filter(l2)
    l3_id, l3_none = parse_id_filter(l3)
    if l2_id is None and not l2_none:
        raise HTTPException(422, "必须指定二级分类（数字 id 或 none）")

    pkgs = _load_l1_packages(db, l1_cat.id)
    group_pkgs = [
        p for p in pkgs
        if any(
            path.l1_id == l1_cat.id and (path.l2_id is None if l2_none else path.l2_id == l2_id)
            for path in p.paths
        )
    ]
    # 组内去重后的包日期（同一包多条路径只计一次）；指定三级时用该层的覆盖配置
    group_unique = {p.id: p for p in group_pkgs}.values()
    grid = compute_grid(
        [p.publish_date for p in group_unique],
        resolve_config(
            db,
            l2_id if not l2_none else None,
            l3_id if not l3_none else None,
        ),
    )
    result = filter_shelf_packages(pkgs, l1_cat.id, l2_id, l2_none, l3_id, l3_none, grid, segment)
    return [
        ShelfPackage(
            id=p.id,
            title=p.title,
            authors=list(p.authors or []),
            publish_date=display_date(p.publish_date),
            file_count=p.file_count,
            formats=sorted({f.format for f in p.files}),
            status=p.status,
        )
        for p in result
    ]
