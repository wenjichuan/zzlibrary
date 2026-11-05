"""资料包：暂存入库（stage→commit）、列表检索、详情/编辑/删除、
包内文件管理、封面/书脊/文件流服务。"""
from __future__ import annotations

import json
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Iterator

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from PIL import Image
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..config import Settings
from ..deps import (
    get_db,
    parse_id_filter,
    require_session,
    resolve_paths,
)
from ..models import Category, FileItem, Package, PackagePath, ReadingProgress
from ..schemas import (
    FileAddIn,
    FileDetail,
    display_date,
    FileOut,
    FileUpdate,
    PackageCommitIn,
    PackageDetail,
    PackageMeta,
    PackageOut,
    PackagePage,
    PackageUpdate,
    PathOut,
    ProgressOut,
    StageDiscardIn,
    StageMetaOut,
    StageOut,
    CategoryRef,
)
from ..services import art, ingest
from ..services.status import recompute_package_status

router = APIRouter(prefix="/api", tags=["packages"])

MEDIA_TYPES = {
    "epub": "application/epub+zip",
    "pdf": "application/pdf",
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "html": "text/html; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "mp4": "video/mp4",
    "m4v": "video/mp4",
    "webm": "video/webm",
    "mov": "video/quicktime",
    "mkv": "video/x-matroska",
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
    "flac": "audio/flac",
    "jpg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}

STAGING_TTL = 24 * 3600
CHUNK = 512 * 1024


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _sanitize_filename(name: str) -> str:
    name = name.replace("\\", "_").replace("/", "_").replace(":", "_").replace("?", "_").replace("*", "_").replace('"', "_").replace("<", "_").replace(">", "_").replace("|", "_")
    name = re.sub(r"[\x00-\x1f]", "", name).strip(". ")
    return name[:120] or "file"


def _package_dir_name(pkg: Package) -> str:
    """包目录名：{入库日期}_{包id}_{包名快照}——资源管理器离库可读；id 保证唯一。

    包名是入库时的快照，之后改名不回写目录（程序逻辑只依赖 id/file_path）。
    """
    date_part = pkg.created_at.strftime("%Y-%m-%d") if pkg.created_at else "unknown"
    return f"{date_part}_{pkg.id}_{_sanitize_filename(pkg.title)[:40]}"


def _package_dir(settings: Settings, pkg: Package) -> Path:
    dir_path = settings.files_dir / _package_dir_name(pkg)
    if not dir_path.exists() and pkg.files:
        # 快照名与库内路径不一致（历史目录/改名前入库）→ 以库内记录为准
        recorded = Path(str(settings.data_dir / pkg.files[0].file_path)).parent
        if recorded.is_dir():
            return recorded
    return dir_path


def _purge_stale_staging(settings: Settings) -> None:
    now = time.time()
    if not settings.staging_dir.exists():
        return
    for entry in settings.staging_dir.iterdir():
        try:
            if entry.is_dir() and now - entry.stat().st_mtime > STAGING_TTL:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def get_package_or_404(db: Session, package_id: int) -> Package:
    pkg = db.get(Package, package_id, options=(selectinload(Package.files), selectinload(Package.paths)))
    if pkg is None:
        raise HTTPException(404, "资料包不存在")
    return pkg


def _ref(c: Category | None) -> dict | None:
    return {"id": c.id, "name": c.name} if c else None


def _package_out(db: Session, pkg: Package, cat_cache: dict[int, Category]) -> PackageOut:
    def cat(cid: int | None) -> Category | None:
        if cid is None:
            return None
        c = cat_cache.get(cid) or db.get(Category, cid)
        cat_cache[cid] = c
        return c

    classifications: list[PathOut] = []
    for p in pkg.paths:
        l1c = cat(p.l1_id)
        if l1c is None:
            continue  # 防御：悬挂路径（正常不会出现）
        l2c, l3c = cat(p.l2_id), cat(p.l3_id)
        classifications.append(
            PathOut(
                l1=CategoryRef(id=l1c.id, name=l1c.name),
                l2=CategoryRef(id=l2c.id, name=l2c.name) if l2c else None,
                l3=CategoryRef(id=l3c.id, name=l3c.name) if l3c else None,
            )
        )

    return PackageOut(
        id=pkg.id,
        title=pkg.title,
        authors=list(pkg.authors or []),
        classifications=classifications,
        publish_date=display_date(pkg.publish_date),
        publisher=pkg.publisher,
        tags=list(pkg.tags or []),
        status=pkg.status,
        file_count=pkg.file_count,
        total_size=pkg.total_size,
        notes=pkg.notes,
        created_at=pkg.created_at,
    )


def _file_cover_path(settings: Settings, f: FileItem) -> Path:
    return settings.art_dir / "filecovers" / f"{f.id}.png"


def _regenerate_package_art(settings: Settings, pkg: Package, cover_img: Image.Image | None) -> None:
    cover = art.normalize_cover(cover_img, pkg.title)
    cover_path = settings.art_dir / "covers" / f"{pkg.id}.png"
    cover.save(cover_path, format="PNG")
    palette = art.palette_from_cover(Image.open(cover_path), pkg.title)
    spine = art.make_spine(pkg.title, palette)
    spine.save(settings.art_dir / "spines" / f"{pkg.id}.png", format="PNG")


def _sync_counts(pkg: Package) -> None:
    pkg.file_count = len(pkg.files)
    pkg.total_size = sum(f.file_size for f in pkg.files)


# ---------- 入库两步：stage -> commit ----------

@router.post("/packages/stage", response_model=StageOut)
def stage_file(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    settings = _settings(request)
    if not file.filename:
        raise HTTPException(422, "缺少文件名")
    fmt = ingest.detect_format(file.filename)  # 不限格式：未知扩展名原样登记

    _purge_stale_staging(settings)
    stage_id = uuid.uuid4().hex
    staging_dir = settings.staging_dir / stage_id
    staging_dir.mkdir(parents=True, exist_ok=True)
    target = staging_dir / "file"
    size = 0
    with open(target, "wb") as out:
        while chunk := file.file.read(CHUNK):
            size += len(chunk)
            out.write(chunk)

    meta = ingest.extract_meta(target, file.filename, fmt)
    has_cover = meta.cover is not None
    if has_cover:
        meta.cover.save(staging_dir / "cover.png")

    (staging_dir / "meta.json").write_text(
        json.dumps(
            {
                "filename": _sanitize_filename(file.filename),
                "format": fmt,
                "size": size,
                "page_count": meta.page_count,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    return StageOut(
        stage_id=stage_id,
        filename=file.filename,
        size=size,
        format=fmt,
        meta=StageMetaOut(
            title=meta.title or _sanitize_filename(Path(file.filename).stem),
            authors=meta.authors,
            publish_date=display_date(meta.publish_date),
            publisher=meta.publisher,
            page_count=meta.page_count,
        ),
        has_cover=has_cover,
    )


@router.post("/packages/stage/discard")
def discard_stages(
    payload: StageDiscardIn,
    request: Request,
    _user: str = Depends(require_session),
):
    """主动废弃暂存文件（放弃入库/从向导移除文件时立即删除，不等 24h TTL）。"""
    settings = _settings(request)
    removed = 0
    for sid in payload.stage_ids:
        if not re.fullmatch(r"[0-9a-f]{32}", sid):
            continue  # 非法 id 静默跳过（防路径注入）
        d = settings.staging_dir / sid
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    _purge_stale_staging(settings)  # 顺手做一次懒清理
    return {"ok": True, "removed": removed}


@router.get("/packages/stage/{stage_id}/cover")
def stage_cover(
    stage_id: str,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    path = _settings(request).staging_dir / stage_id / "cover.png"
    if not path.exists():
        raise HTTPException(404, "该文件没有可预览的封面")
    return FileResponse(path, media_type="image/png")


@router.post("/packages", response_model=PackageDetail, status_code=201)
def commit_package(
    payload: PackageCommitIn,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    settings = _settings(request)
    staged = []
    for stage_id in payload.stage_ids:
        staging_dir = settings.staging_dir / stage_id
        if not (staging_dir / "file").exists():
            raise HTTPException(404, f"暂存文件已过期（{stage_id[:8]}…），请重新上传")
        staged.append((staging_dir, json.loads((staging_dir / "meta.json").read_text(encoding="utf-8"))))

    meta: PackageMeta = payload.meta
    resolved_paths = resolve_paths(db, meta.classifications)

    pkg = Package(
        title=meta.title.strip(),
        authors=[a.strip() for a in meta.authors if a and a.strip()],
        publish_date=meta.publish_date,
        publisher=(meta.publisher or "").strip() or None,
        tags=[t.strip() for t in meta.tags if t and t.strip()],
        notes=meta.notes,
        status="未读",
    )
    db.add(pkg)
    db.flush()
    for l1, l2, l3 in resolved_paths:
        db.add(PackagePath(package_id=pkg.id, l1_id=l1, l2_id=l2, l3_id=l3))

    package_cover: Image.Image | None = None
    pkg_dir = _package_dir(settings, pkg)
    pkg_dir.mkdir(parents=True, exist_ok=True)
    for order, (staging_dir, info) in enumerate(staged):
        f = FileItem(
            package_id=pkg.id,
            name=info["filename"],
            format=info["format"],
            file_path="",
            file_size=info["size"],
            page_count=info.get("page_count"),
            sort_order=order,
        )
        db.add(f)
        db.flush()
        dest = pkg_dir / f"{f.id}_{info['filename']}"
        shutil.move(str(staging_dir / "file"), str(dest))
        f.file_path = str(dest.relative_to(settings.data_dir)).replace("\\", "/")
        cover_src = staging_dir / "cover.png"
        if cover_src.exists():
            cover_img = Image.open(cover_src)
            (settings.art_dir / "filecovers").mkdir(parents=True, exist_ok=True)
            cover_img.save(_file_cover_path(settings, f), format="PNG")
            if package_cover is None:
                package_cover = cover_img

    db.flush()
    db.refresh(pkg)
    _sync_counts(pkg)
    recompute_package_status(pkg)  # 入库即对齐：纯不可读格式包为中性 ""
    _regenerate_package_art(settings, pkg, package_cover)
    for staging_dir, _info in staged:
        shutil.rmtree(staging_dir, ignore_errors=True)
    db.flush()
    return _package_detail(settings, db, pkg)


def _package_detail(settings: Settings, db: Session, pkg: Package) -> PackageDetail:
    detail = PackageDetail(**_package_out(db, pkg, {}).model_dump())
    detail.files = [
        FileDetail(
            id=f.id,
            name=f.name,
            format=f.format,
            file_size=f.file_size,
            page_count=f.page_count,
            sort_order=f.sort_order,
            has_cover=_file_cover_path(settings, f).exists(),
            progress=ProgressOut.model_validate(f.progress) if f.progress else None,
        )
        for f in pkg.files
    ]
    return detail


# ---------- 列表 / 详情 / 编辑 / 删除 ----------

@router.get("/packages", response_model=PackagePage)
def list_packages(
    l1: str | None = Query(None),
    l2: str | None = Query(None),
    l3: str | None = Query(None),
    q: str | None = Query(None, max_length=200),
    fmt: str | None = Query(None, alias="format"),
    status_filter: str | None = Query(None, alias="status"),
    undated: bool = Query(False, description="只看未注明发布时间的包（编目补全用）"),
    sort: str = Query("newest"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    conds = []
    cid1, none1 = parse_id_filter(l1)
    if none1:
        # "none" = 没有任何分类路径（未分类）
        conds.append(
            ~select(Package.id).where(Package.id == PackagePath.package_id).exists()
        )
    elif cid1 is not None:
        # 同一路径上的前缀匹配：l1=X（可选再限定 l2/l3）
        path_conds = [PackagePath.l1_id == cid1]
        cid2, _ = parse_id_filter(l2)
        cid3, _ = parse_id_filter(l3)
        if cid2 is not None:
            path_conds.append(PackagePath.l2_id == cid2)
        if cid3 is not None:
            path_conds.append(PackagePath.l3_id == cid3)
        conds.append(
            select(Package.id).where(
                Package.id == PackagePath.package_id, *path_conds
            ).exists()
        )
    if fmt:
        conds.append(
            select(Package.id).where(
                Package.id == FileItem.package_id, FileItem.format == fmt
            ).exists()
        )
    if status_filter:
        if status_filter not in ("未读", "在读", "已读"):
            raise HTTPException(422, "状态筛选无效")
        conds.append(Package.status == status_filter)
    if undated:
        conds.append(Package.publish_date.is_(None))
    if q:
        like = f"%{q.strip()}%"
        conds.append(
            or_(
                Package.title.like(like),
                cast(Package.authors, String).like(like),
                Package.publisher.like(like),
                Package.notes.like(like),
                cast(Package.tags, String).like(like),
            )
        )

    order = {
        "newest": Package.created_at.desc(),
        "oldest": Package.created_at.asc(),
        "title": Package.title.asc(),
        "date_asc": Package.publish_date.asc().nulls_last(),
        "date_desc": Package.publish_date.desc().nulls_last(),
    }.get(sort)
    if order is None:
        raise HTTPException(422, "排序参数无效")

    total = db.execute(select(func.count()).select_from(Package).where(*conds)).scalar() or 0
    pkgs = db.execute(
        select(Package)
        .where(*conds)
        .order_by(order, Package.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).scalars().all()

    cat_cache: dict[int, Category] = {}
    return PackagePage(
        total=total,
        page=page,
        page_size=page_size,
        items=[_package_out(db, p, cat_cache) for p in pkgs],
    )


@router.get("/packages/{package_id}", response_model=PackageDetail)
def get_package(
    package_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    pkg = get_package_or_404(db, package_id)
    return _package_detail(_settings(request), db, pkg)


@router.patch("/packages/{package_id}", response_model=PackageDetail)
def update_package(
    package_id: int,
    payload: PackageUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    pkg = get_package_or_404(db, package_id)
    data = payload.model_dump(exclude_unset=True)

    if "classifications" in data and data["classifications"] is not None:
        # 整体替换所有分类路径
        resolved = resolve_paths(db, payload.classifications)
        pkg.paths.clear()
        db.flush()
        for l1, l2, l3 in resolved:
            pkg.paths.append(PackagePath(package_id=pkg.id, l1_id=l1, l2_id=l2, l3_id=l3))

    if "title" in data and data["title"] is not None:
        pkg.title = data["title"].strip()
    if "authors" in data and data["authors"] is not None:
        pkg.authors = [a.strip() for a in data["authors"] if a and a.strip()]
    if "publish_date" in data:
        pkg.publish_date = data["publish_date"]
    if "publisher" in data:
        pkg.publisher = (data["publisher"] or "").strip() or None
    if "tags" in data and data["tags"] is not None:
        pkg.tags = [t.strip() for t in data["tags"] if t and t.strip()]
    if "notes" in data:
        pkg.notes = data["notes"]

    title_changed = "title" in data and data["title"] is not None
    db.flush()
    if title_changed:
        cover_path = _settings(request).art_dir / "covers" / f"{pkg.id}.png"
        cover_img = Image.open(cover_path) if cover_path.exists() else None
        _regenerate_package_art(_settings(request), pkg, cover_img)
    db.flush()
    return _package_detail(_settings(request), db, pkg)


@router.delete("/packages/{package_id}")
def delete_package(
    package_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    pkg = get_package_or_404(db, package_id)
    settings = _settings(request)
    shutil.rmtree(_package_dir(settings, pkg), ignore_errors=True)
    shutil.rmtree(settings.files_dir / str(pkg.id), ignore_errors=True)  # 兼容旧目录名残留
    (settings.art_dir / "covers" / f"{pkg.id}.png").unlink(missing_ok=True)
    (settings.art_dir / "spines" / f"{pkg.id}.png").unlink(missing_ok=True)
    for f in pkg.files:
        _file_cover_path(settings, f).unlink(missing_ok=True)
    db.delete(pkg)
    db.flush()
    return {"ok": True}


# ---------- 包内文件管理 ----------

@router.post("/packages/{package_id}/files", response_model=FileDetail, status_code=201)
def add_file(
    package_id: int,
    payload: FileAddIn,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    settings = _settings(request)
    pkg = get_package_or_404(db, package_id)
    staging_dir = settings.staging_dir / payload.stage_id
    if not (staging_dir / "file").exists():
        raise HTTPException(404, "暂存文件已过期，请重新上传")
    info = json.loads((staging_dir / "meta.json").read_text(encoding="utf-8"))

    max_order = max((f.sort_order for f in pkg.files), default=-1)
    f = FileItem(
        package_id=pkg.id,
        name=info["filename"],
        format=info["format"],
        file_path="",
        file_size=info["size"],
        page_count=info.get("page_count"),
        sort_order=max_order + 1,
    )
    db.add(f)
    db.flush()
    pkg_dir = _package_dir(settings, pkg)
    pkg_dir.mkdir(parents=True, exist_ok=True)
    dest = pkg_dir / f"{f.id}_{info['filename']}"
    shutil.move(str(staging_dir / "file"), str(dest))
    f.file_path = str(dest.relative_to(settings.data_dir)).replace("\\", "/")

    cover_src = staging_dir / "cover.png"
    cover_img = None
    if cover_src.exists():
        cover_img = Image.open(cover_src)
        (settings.art_dir / "filecovers").mkdir(parents=True, exist_ok=True)
        cover_img.save(_file_cover_path(settings, f), format="PNG")

    db.flush()
    db.refresh(pkg)
    _sync_counts(pkg)
    recompute_package_status(pkg)  # 增文件改变"全部读完"口径（如给已读包补未读文件→在读/未读）
    # 包封面缺失时用新文件封面补上
    if cover_img is not None and not (settings.art_dir / "covers" / f"{pkg.id}.png").exists():
        _regenerate_package_art(settings, pkg, cover_img)
    shutil.rmtree(staging_dir, ignore_errors=True)
    db.flush()
    return FileDetail(
        id=f.id,
        name=f.name,
        format=f.format,
        file_size=f.file_size,
        page_count=f.page_count,
        sort_order=f.sort_order,
        has_cover=_file_cover_path(settings, f).exists(),
        progress=None,
    )


@router.patch("/packages/{package_id}/files/{file_id}", response_model=FileDetail)
def update_file(
    package_id: int,
    file_id: int,
    payload: FileUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    settings = _settings(request)
    pkg = get_package_or_404(db, package_id)
    f = next((x for x in pkg.files if x.id == file_id), None)
    if f is None:
        raise HTTPException(404, "包内文件不存在")
    if payload.name is not None:
        f.name = _sanitize_filename(payload.name)
    if payload.sort_order is not None:
        f.sort_order = payload.sort_order
    db.flush()
    return FileDetail(
        id=f.id,
        name=f.name,
        format=f.format,
        file_size=f.file_size,
        page_count=f.page_count,
        sort_order=f.sort_order,
        has_cover=_file_cover_path(settings, f).exists(),
        progress=ProgressOut.model_validate(f.progress) if f.progress else None,
    )


@router.delete("/packages/{package_id}/files/{file_id}")
def delete_file(
    package_id: int,
    file_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    settings = _settings(request)
    pkg = get_package_or_404(db, package_id)
    f = next((x for x in pkg.files if x.id == file_id), None)
    if f is None:
        raise HTTPException(404, "包内文件不存在")
    if len(pkg.files) == 1:
        raise HTTPException(422, "不能移除包内唯一的文件：请删除整个资料包，或先添加新文件再移除")
    (settings.data_dir / f.file_path).unlink(missing_ok=True)
    _file_cover_path(settings, f).unlink(missing_ok=True)
    db.delete(f)
    db.flush()
    db.refresh(pkg)
    _sync_counts(pkg)
    recompute_package_status(pkg)  # 删文件同理（如移除最后一个未读文件→已读）
    db.flush()
    return {"ok": True}


# ---------- 资产端点：封面 / 书脊 / 文件流 ----------

def _cached_file(path: Path, media_type: str) -> FileResponse:
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/packages/{package_id}/cover")
def package_cover(
    package_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    pkg = get_package_or_404(db, package_id)
    settings = _settings(request)
    path = settings.art_dir / "covers" / f"{pkg.id}.png"
    if not path.exists():
        art.normalize_cover(None, pkg.title).save(path, format="PNG")
    return _cached_file(path, "image/png")


@router.get("/packages/{package_id}/spine")
def package_spine(
    package_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    pkg = get_package_or_404(db, package_id)
    settings = _settings(request)
    path = settings.art_dir / "spines" / f"{pkg.id}.png"
    if not path.exists():
        cover_path = settings.art_dir / "covers" / f"{pkg.id}.png"
        cover_img = Image.open(cover_path) if cover_path.exists() else None
        _regenerate_package_art(settings, pkg, cover_img)
    return _cached_file(path, "image/png")


@router.get("/files/{file_id}/cover")
def file_cover(
    file_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    settings = _settings(request)
    f = db.get(FileItem, file_id)
    if f is None:
        raise HTTPException(404, "文件不存在")
    path = _file_cover_path(settings, f)
    if not path.exists():
        raise HTTPException(404, "该文件没有封面")
    return _cached_file(path, "image/png")


@router.get("/files/{file_id}/file")
def file_stream(
    file_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _user: str = Depends(require_session),
):
    settings = _settings(request)
    f = db.get(FileItem, file_id)
    if f is None:
        raise HTTPException(404, "文件不存在")
    path = settings.data_dir / f.file_path
    if not path.exists():
        raise HTTPException(404, "文件缺失")
    media_type = MEDIA_TYPES.get(f.format, "application/octet-stream")
    return _serve_with_range(path, request, media_type)


_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _serve_with_range(path: Path, request: Request, media_type: str) -> Response:
    size = path.stat().st_size
    header = request.headers.get("range")
    if header:
        m = _RANGE_RE.match(header.strip())
        if m:
            start_s, end_s = m.groups()
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

            def gen() -> Iterator[bytes]:
                with open(path, "rb") as fh:
                    fh.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        chunk = fh.read(min(CHUNK, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk

            return StreamingResponse(
                gen(),
                status_code=206,
                media_type=media_type,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(end - start + 1),
                },
            )
    return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})
