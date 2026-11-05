"""书架聚合（多分类路径版）：

某一级分类下的资料包 = 至少一条路径 l1_id 命中的包。
- 组（二级分类）按路径的 l2_id 分组，空 → 「未分类」组
- 书架按路径的 l3_id 划分，空 → 「未细分」书架
- (包, l2, l3) 三元组去重：同一包多条路径落在同一书架只算一本
- 组/l1 的 total 与各层计数均按**去重后的包数**统计
- 时间分段按**每层（三级分类）独立计算**：三级覆盖 > 二级覆盖 > 全局默认；
  组内统一 range（各层分段并集 ∪ 藏书日期）供比例时间轴跨层对齐
"""
from __future__ import annotations

from collections import defaultdict
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Category, Package, PackagePath, SegmentConfig
from ..schemas import SegmentConfigIn, SegmentConfigOut, display_date
from .segmentation import Segment, compute_grid, index_for

GLOBAL_DEFAULT = SegmentConfigIn(mode="year")


def resolve_config(db: Session, l2_id: int | None, l3_id: int | None = None) -> SegmentConfigIn:
    """三级覆盖 > 二级覆盖 > 全局默认。"""
    cfg = None
    if l3_id is not None:
        cfg = db.execute(
            select(SegmentConfig).where(SegmentConfig.scope == "l3", SegmentConfig.l3_id == l3_id)
        ).scalar_one_or_none()
    if cfg is None and l2_id is not None:
        cfg = db.execute(
            select(SegmentConfig).where(SegmentConfig.scope == "l2", SegmentConfig.l2_id == l2_id)
        ).scalar_one_or_none()
    if cfg is None:
        cfg = db.execute(select(SegmentConfig).where(SegmentConfig.scope == "global")).scalar_one_or_none()
    if cfg is None:
        return GLOBAL_DEFAULT
    return SegmentConfigIn(mode=cfg.mode, params=cfg.params or {})


def resolve_config_with_scope(
    db: Session, l2_id: int | None, l3_id: int | None = None
) -> tuple[SegmentConfigIn, str]:
    """同 resolve_config，附带生效来源（default/global/l2/l3）。"""
    if l3_id is not None:
        row = db.execute(
            select(SegmentConfig).where(SegmentConfig.scope == "l3", SegmentConfig.l3_id == l3_id)
        ).scalar_one_or_none()
        if row is not None:
            return SegmentConfigIn(mode=row.mode, params=row.params or {}), "l3"
    if l2_id is not None:
        row = db.execute(
            select(SegmentConfig).where(SegmentConfig.scope == "l2", SegmentConfig.l2_id == l2_id)
        ).scalar_one_or_none()
        if row is not None:
            return SegmentConfigIn(mode=row.mode, params=row.params or {}), "l2"
    row = db.execute(select(SegmentConfig).where(SegmentConfig.scope == "global")).scalar_one_or_none()
    if row is not None:
        return SegmentConfigIn(mode=row.mode, params=row.params or {}), "global"
    return GLOBAL_DEFAULT, "default"


def _ref(c: Category | None) -> dict | None:
    return {"id": c.id, "name": c.name} if c else None


def build_shelves(db: Session, l1: Category, pkgs: list[Package], include_packages: bool = False) -> dict:
    """pkgs 应为「至少一条路径 l1_id == l1.id」的包（调用方过滤）。

    include_packages=True 时书架内嵌每本书的放置信息（segment_key + 包摘要），供 3D 场景渲染。
    """
    # (包, 路径) 对 → 按 (pkg, l2, l3) 去重
    pairs: dict[tuple[int, int | None, int | None], tuple[Package, PackagePath]] = {}
    for p in pkgs:
        for path in p.paths:
            if path.l1_id != l1.id:
                continue
            key = (p.id, path.l2_id, path.l3_id)
            if key not in pairs:
                pairs[key] = (p, path)

    cat_ids: set[int] = set()
    for _p, path in pairs.values():
        if path.l2_id is not None:
            cat_ids.add(path.l2_id)
        if path.l3_id is not None:
            cat_ids.add(path.l3_id)
    cats: dict[int, Category] = {
        c.id: c
        for c in db.execute(select(Category).where(Category.id.in_(cat_ids))).scalars()
    } if cat_ids else {}

    by_l2: dict[int | None, list[tuple[Package, PackagePath]]] = defaultdict(list)
    for key, pp in pairs.items():
        by_l2[key[1]].append(pp)

    defined_l2 = sorted(
        (cats[i] for i in by_l2 if i is not None and i in cats),
        key=lambda c: (c.sort_order, c.id),
    )
    ordered_keys: list[int | None] = [c.id for c in defined_l2]
    if None in by_l2:
        ordered_keys.append(None)

    groups_payload = []
    seen_pkg_ids_total: set[int] = set()
    for l2_key in ordered_keys:
        group_pairs = by_l2[l2_key]
        group_pkg_ids = {p.id for p, _ in group_pairs}
        seen_pkg_ids_total |= group_pkg_ids
        l2_cat = cats.get(l2_key) if l2_key is not None else None

        # 书架按 l3 分组（组内每包每架至多一次）
        by_l3: dict[int | None, set[int]] = defaultdict(set)
        pkg_map = {p.id: p for p, _ in group_pairs}
        for p, path in group_pairs:
            by_l3[path.l3_id].add(p.id)
        defined_l3 = sorted(
            (cats[i] for i in by_l3 if i is not None and i in cats),
            key=lambda c: (c.sort_order, c.id),
        )
        ordered_l3: list[int | None] = [c.id for c in defined_l3]
        if None in by_l3:
            ordered_l3.append(None)

        shelves_payload = []
        group_start: date | None = None
        group_end: date | None = None
        has_undated = False
        for l3_key in ordered_l3:
            shelf_pkg_ids = by_l3[l3_key]
            shelf_pkgs = [pkg_map[pid] for pid in shelf_pkg_ids]
            config, scope = resolve_config_with_scope(db, l2_key, l3_key)
            grid: list[Segment] = compute_grid([p.publish_date for p in shelf_pkgs], config)

            counts = {seg.key: 0 for seg in grid}
            placements = []
            for p in shelf_pkgs:
                if p.publish_date is None:
                    has_undated = True
                if grid:
                    seg_key = grid[index_for(grid, p.publish_date)].key
                    counts[seg_key] += 1
                    if include_packages:
                        placements.append(
                            {
                                "segment_key": seg_key,
                                "package": {
                                    "id": p.id,
                                    "title": p.title,
                                    "authors": list(p.authors or []),
                                    "publish_date": display_date(p.publish_date),
                                    "created_at": p.created_at.isoformat(),
                                    "file_count": p.file_count,
                                    "formats": sorted({f.format for f in p.files}),
                                    "status": p.status,
                                },
                            }
                        )

            # 层的时间跨度：分段网格并集 ∪ 该层藏书日期（比例时间轴跨层对齐用）
            shelf_start = min(
                [seg.start for seg in grid if seg.start is not None]
                + [p.publish_date for p in shelf_pkgs if p.publish_date is not None],
                default=None,
            )
            shelf_end = max(
                [seg.end for seg in grid if seg.end is not None]
                + [p.publish_date for p in shelf_pkgs if p.publish_date is not None],
                default=None,
            )
            if shelf_start is not None:
                group_start = shelf_start if group_start is None else min(group_start, shelf_start)
            if shelf_end is not None:
                group_end = shelf_end if group_end is None else max(group_end, shelf_end)

            l3_cat = cats.get(l3_key) if l3_key is not None else None
            shelf_payload = {
                "l3": _ref(l3_cat),
                "segments": [
                    {
                        "key": seg.key,
                        "label": seg.label,
                        "alias": seg.alias,
                        "start": display_date(seg.start),
                        "end": display_date(seg.end),
                        "count": counts.get(seg.key, 0),
                    }
                    for seg in grid
                ],
                "config": SegmentConfigOut(
                    scope=scope,
                    l2_id=l2_key,
                    l3_id=l3_key,
                    mode=config.mode,
                    params=config.params,
                ),
                "counts": counts,
                "total": len(shelf_pkg_ids),
            }
            if include_packages:
                shelf_payload["packages"] = placements
            shelves_payload.append(shelf_payload)

        groups_payload.append(
            {
                "l2": _ref(l2_cat),
                "range": (
                    {"start": display_date(group_start), "end": display_date(group_end)}
                    if group_start is not None and group_end is not None
                    else None
                ),
                "has_undated": has_undated,
                "shelves": shelves_payload,
                "total": len(group_pkg_ids),
            }
        )

    return {
        "l1": {"id": l1.id, "name": l1.name},
        "groups": groups_payload,
        "total": len(seen_pkg_ids_total),
    }


def filter_shelf_packages(
    pkgs: list[Package],
    l1_id: int,
    l2_id: int | None,
    l2_is_none: bool,
    l3_id: int | None,
    l3_is_none: bool,
    grid: list[Segment] | None,
    segment_key: str | None,
) -> list[Package]:
    """按 一级/二级/三级/时间段 过滤书架上的包（去重，按发布时间、包名排序）。"""
    target_idx: int | None = None
    if grid and segment_key:
        for i, seg in enumerate(grid):
            if seg.key == segment_key:
                target_idx = i
                break
        if target_idx is None:
            return []

    result = []
    seen: set[int] = set()

    def l2_ok(path: PackagePath) -> bool:
        if l2_is_none:
            return path.l2_id is None
        if l2_id is not None:
            return path.l2_id == l2_id
        return True  # 不限

    def l3_ok(path: PackagePath) -> bool:
        if l3_is_none:
            return path.l3_id is None
        if l3_id is not None:
            return path.l3_id == l3_id
        return True  # 不限

    for p in pkgs:
        matched = any(path.l1_id == l1_id and l2_ok(path) and l3_ok(path) for path in p.paths)
        if not matched or p.id in seen:
            continue
        if target_idx is not None:
            if grid[target_idx].key == "undated":
                if p.publish_date is not None:
                    continue
            elif grid[target_idx].key != "other":
                if p.publish_date is None:
                    continue
            if index_for(grid, p.publish_date) != target_idx:
                continue
        seen.add(p.id)
        result.append(p)
    result.sort(key=lambda p: (p.publish_date or "", p.title))  # 规范文本字典序 = 时间序
    return result
