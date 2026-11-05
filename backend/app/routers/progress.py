"""阅读进度：按包内文件记录，多端同步；包状态由文件进度聚合。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, selectinload

from ..deps import get_db, require_session
from ..models import FileItem, ReadingProgress
from ..schemas import ProgressIn, ProgressOut
from ..services.status import recompute_package_status

router = APIRouter(prefix="/api/progress", tags=["progress"])


@router.get("/{file_id}", response_model=ProgressOut | None)
def get_progress(
    file_id: int,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    f = db.get(FileItem, file_id)
    if f is None:
        raise HTTPException(404, "文件不存在")
    return ProgressOut.model_validate(f.progress) if f.progress else None


@router.put("/{file_id}", response_model=ProgressOut)
def put_progress(
    file_id: int,
    payload: ProgressIn,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    f = db.get(FileItem, file_id, options=(selectinload(FileItem.package),))
    if f is None:
        raise HTTPException(404, "文件不存在")
    progress = f.progress
    if progress is None:
        progress = ReadingProgress(locator=payload.locator, percent=payload.percent)
        progress.file = f  # 建立双向关系，包状态重算才能看到
        db.add(progress)
    else:
        progress.locator = payload.locator
        progress.percent = payload.percent
    db.flush()
    # 重算所属包状态
    recompute_package_status(f.package)
    db.flush()
    return ProgressOut.model_validate(progress)
