"""时间分段配置：全局默认 + 按二级分类覆盖 + 按三级分类覆盖。

生效优先级：三级覆盖 > 二级覆盖 > 全局默认（见 services/aggregate.resolve_config）。
自定义区间支持别名（alias，如朝代名）与宽松日期（YYYY / YYYY-MM / YYYY-MM-DD）。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import get_category, get_db, require_session
from ..models import Category, SegmentConfig
from ..schemas import SegmentConfigBundle, SegmentConfigIn, SegmentConfigOut
from ..services.segmentation import parse_range

router = APIRouter(prefix="/api/segment-config", tags=["segment-config"])


def _validate(payload: SegmentConfigIn) -> None:
    if payload.mode == "n_years":
        n = payload.params.get("n")
        if not isinstance(n, int) or not 1 <= n <= 100:
            raise HTTPException(422, "n_years 模式需要在 params.n 提供 1~100 的整数")
    elif payload.mode == "custom":
        ranges = payload.params.get("ranges")
        if not isinstance(ranges, list) or not ranges:
            raise HTTPException(422, "custom 模式需要在 params.ranges 提供至少一个区间")
        for r in ranges:
            if not isinstance(r, dict) or parse_range(r) is None:
                raise HTTPException(
                    422,
                    f"区间格式无效：{r}（需要 start/end，支持 YYYY / YYYY-MM / YYYY-MM-DD；alias 可选）",
                )


def _out(cfg: SegmentConfig) -> SegmentConfigOut:
    return SegmentConfigOut(
        scope=cfg.scope, l2_id=cfg.l2_id, l3_id=cfg.l3_id, mode=cfg.mode, params=cfg.params or {}
    )


@router.get("", response_model=SegmentConfigBundle)
def get_configs(db: Session = Depends(get_db), _user: str = Depends(require_session)):
    global_cfg = db.execute(
        select(SegmentConfig).where(SegmentConfig.scope == "global")
    ).scalar_one_or_none()
    overrides = db.execute(
        select(SegmentConfig)
        .where(SegmentConfig.scope.in_(["l2", "l3"]))
        .order_by(SegmentConfig.l2_id, SegmentConfig.l3_id)
    ).scalars().all()
    return SegmentConfigBundle(
        global_=_out(global_cfg)
        if global_cfg
        else SegmentConfigOut(scope="global", l2_id=None, mode="year", params={}),
        overrides=[_out(o) for o in overrides],
    )


def _upsert(
    db: Session, scope: str, l2_id: int | None, l3_id: int | None, payload: SegmentConfigIn
) -> SegmentConfig:
    stmt = select(SegmentConfig).where(SegmentConfig.scope == scope)
    if l2_id is not None:
        stmt = stmt.where(SegmentConfig.l2_id == l2_id)
    else:
        stmt = stmt.where(SegmentConfig.l2_id.is_(None))
    if l3_id is not None:
        stmt = stmt.where(SegmentConfig.l3_id == l3_id)
    else:
        stmt = stmt.where(SegmentConfig.l3_id.is_(None))
    cfg = db.execute(stmt).scalar_one_or_none()
    if cfg is None:
        cfg = SegmentConfig(scope=scope, l2_id=l2_id, l3_id=l3_id, mode=payload.mode, params=payload.params)
        db.add(cfg)
    else:
        cfg.mode = payload.mode
        cfg.params = payload.params
    db.flush()
    return cfg


@router.put("", response_model=SegmentConfigOut)
def put_global(
    payload: SegmentConfigIn,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    _validate(payload)
    return _out(_upsert(db, "global", None, None, payload))


@router.put("/{l2_id}", response_model=SegmentConfigOut)
def put_l2_override(
    l2_id: int,
    payload: SegmentConfigIn,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    l2 = get_category(db, l2_id)
    if l2 is None or l2.level != 2:
        raise HTTPException(404, "二级分类不存在")
    _validate(payload)
    return _out(_upsert(db, "l2", l2_id, None, payload))


@router.delete("/{l2_id}")
def delete_l2_override(
    l2_id: int,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    cfg = db.execute(
        select(SegmentConfig).where(SegmentConfig.scope == "l2", SegmentConfig.l2_id == l2_id)
    ).scalar_one_or_none()
    if cfg is None:
        raise HTTPException(404, "该二级分类没有覆盖配置")
    db.delete(cfg)
    db.flush()
    return {"ok": True}


@router.put("/l3/{l3_id}", response_model=SegmentConfigOut)
def put_l3_override(
    l3_id: int,
    payload: SegmentConfigIn,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    l3 = get_category(db, l3_id)
    if l3 is None or l3.level != 3 or l3.parent_id is None:
        raise HTTPException(404, "三级分类不存在")
    _validate(payload)
    return _out(_upsert(db, "l3", l3.parent_id, l3_id, payload))


@router.delete("/l3/{l3_id}")
def delete_l3_override(
    l3_id: int,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    cfg = db.execute(
        select(SegmentConfig).where(SegmentConfig.scope == "l3", SegmentConfig.l3_id == l3_id)
    ).scalar_one_or_none()
    if cfg is None:
        raise HTTPException(404, "该三级分类没有覆盖配置")
    db.delete(cfg)
    db.flush()
    return {"ok": True}
