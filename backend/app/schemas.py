"""Pydantic API 模式（资料包模型）。"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

SEGMENT_MODES = Literal["year", "n_years", "decade", "month", "custom"]

# 日期统一用文本承载（Python date 不支持公元前）。两种形态：
# - 序键（存储/比较用）：公元 “YYYY-MM-DD”；公元前年用 9 补码（前1 → -9999、前221 → -9779），
#   保证字典序 = 时间序，SQL ORDER BY / min-max / 字符串比较直接可用。
# - 显示（API 出参用）：公元同序键；公元前 “-0221-05-01”（人类可读）。
#   入口解析 显示→序键（parse_partial_date），出口序列化 序键→显示（display_date）。
_DATE_PARTS = re.compile(r"^(\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$")


def canonical_date_str(year: int, month: int = 1, day: int = 1) -> str:
    """年月日 → 序键文本（负年 = 公元前，9 补码编码：前1→-9999、前221→-9779）。"""
    if year < 0:
        return f"-{9999 + year + 1:04d}-{month:02d}-{day:02d}"
    return f"{year:04d}-{month:02d}-{day:02d}"


def year_of_key(key: str) -> int:
    """序键 → 整年（公元前为负，如 -9779 → -221）。"""
    if key.startswith("-"):
        return int(key[1:5]) - 10000
    return int(key[0:4])


def display_date(key: str | None) -> str | None:
    """序键 → 显示文本（公元不变；公元前 -9779-05-01 → -0221-05-01）。"""
    if not key or not isinstance(key, str) or not key.startswith("-"):
        return key
    y = abs(year_of_key(key))
    return f"-{y:04d}" + key[5:]


def parse_partial_date(value: str | date | datetime | None) -> str | None:
    """接受 前221 / 公元前221 / -221 / YYYY / YYYY-MM / YYYY-MM-DD → 规范文本。

    缺省部分取 1 号（公元前取 1/1）；无效抛 ValueError。
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return canonical_date_str(value.year, value.month, value.day)
    if isinstance(value, date):
        return canonical_date_str(value.year, value.month, value.day)
    s = str(value).strip()
    neg = False
    if s.startswith("公元前"):
        neg, s = True, s[3:].strip()
    elif s.startswith("前"):
        neg, s = True, s[1:].strip()
    elif s.startswith("-"):
        neg, s = True, s[1:].strip()
    m = _DATE_PARTS.match(s)
    if not m:
        raise ValueError(
            f"日期格式无效：{value!r}，应为 前221 / -221 / YYYY、YYYY-MM 或 YYYY-MM-DD"
        )
    year, month, day = (int(g) if g else 1 for g in m.groups())
    if neg:
        year = -year
    if year == 0:
        raise ValueError("没有公元 0 年：公元前一年请写「前1」，公元一年请写「1」")
    if not 1 <= month <= 12 or not 1 <= day <= 31:
        raise ValueError(f"日期无效：{value!r}")
    return canonical_date_str(year, month, day)


# ---------- auth ----------

class LoginIn(BaseModel):
    username: str
    password: str


# ---------- categories ----------

class CategoryOut(BaseModel):
    id: int
    level: int
    parent_id: int | None
    name: str
    sort_order: int
    children: list["CategoryOut"] = []

    model_config = {"from_attributes": True}


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_id: int | None = None


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort_order: int | None = None
    parent_id: int | None = None


# ---------- packages ----------

class PathIn(BaseModel):
    """一条分类路径：l1 可省略（给出 l2 时自动补全），l2/l3 可空。"""

    l1_id: int | None = None
    l2_id: int | None = None
    l3_id: int | None = None


class PackageMeta(BaseModel):
    """入库时用户确认/补充的包元数据。classifications 可为多条路径。"""

    title: str = Field(min_length=1, max_length=500)
    authors: list[str] = []
    classifications: list[PathIn] = []
    publish_date: str | None = None
    publisher: str | None = Field(default=None, max_length=300)
    tags: list[str] = []
    notes: str | None = None

    @field_validator("publish_date", mode="before")
    @classmethod
    def _parse_date(cls, v):
        try:
            return parse_partial_date(v)
        except ValueError as e:
            raise ValueError(str(e)) from e


class PackageCommitIn(BaseModel):
    stage_ids: list[str] = Field(min_length=1)
    meta: PackageMeta


class StageDiscardIn(BaseModel):
    """主动废弃暂存（放弃入库/移除文件时立即清理，不等 24h TTL）。"""

    stage_ids: list[str] = Field(min_length=1)


class PackageUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    authors: list[str] | None = None
    classifications: list[PathIn] | None = None
    publish_date: str | None = None
    publisher: str | None = Field(default=None, max_length=300)
    tags: list[str] | None = None
    notes: str | None = None

    @field_validator("publish_date", mode="before")
    @classmethod
    def _parse_date(cls, v):
        try:
            return parse_partial_date(v)
        except ValueError as e:
            raise ValueError(str(e)) from e


class CategoryRef(BaseModel):
    id: int
    name: str


class PathOut(BaseModel):
    """一条已解析的分类路径。"""

    l1: CategoryRef
    l2: CategoryRef | None = None
    l3: CategoryRef | None = None


class FileOut(BaseModel):
    id: int
    name: str
    format: str
    file_size: int
    page_count: int | None
    sort_order: int

    model_config = {"from_attributes": True}


class FileDetail(FileOut):
    has_cover: bool = False
    progress: "ProgressOut | None" = None


class PackageOut(BaseModel):
    id: int
    title: str
    authors: list[str]
    classifications: list[PathOut] = []
    publish_date: str | None  # 序键 → 显示（公元前可读）
    publisher: str | None
    tags: list[str]
    status: str
    file_count: int
    total_size: int
    notes: str | None
    created_at: datetime


class PackageDetail(PackageOut):
    files: list[FileDetail] = []


class PackagePage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[PackageOut]


class StageMetaOut(BaseModel):
    """stage 后从文件中抽取的元数据（供入库向导预填）。"""

    title: str | None
    authors: list[str] = []
    publish_date: str | None
    publisher: str | None
    page_count: int | None


class StageOut(BaseModel):
    stage_id: str
    filename: str
    size: int
    format: str
    meta: StageMetaOut
    has_cover: bool


class FileAddIn(BaseModel):
    stage_id: str


class FileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=500)
    sort_order: int | None = None


# ---------- segment config ----------

class SegmentConfigIn(BaseModel):
    mode: SEGMENT_MODES
    params: dict[str, Any] = {}


class SegmentConfigOut(BaseModel):
    scope: str
    l2_id: int | None
    l3_id: int | None = None
    mode: str
    params: dict[str, Any]

    model_config = {"from_attributes": True}


class SegmentConfigBundle(BaseModel):
    global_: SegmentConfigOut = Field(serialization_alias="global")
    overrides: list[SegmentConfigOut] = []

    model_config = {"populate_by_name": True}


# ---------- shelves ----------

class ShelfSegment(BaseModel):
    key: str
    label: str
    alias: str | None = None  # 别名（如朝代名），显示为「1368–1644（明）」
    start: str | None  # 规范日期文本；custom/undated/other 段可能没有
    end: str | None
    count: int


class ShelfRange(BaseModel):
    """组（二级分类）内比例时间轴的统一范围：各层分段并集 + 藏书日期。"""

    start: str
    end: str


class ShelfPackage(BaseModel):
    id: int
    title: str
    authors: list[str]
    publish_date: str | None
    file_count: int
    formats: list[str]
    status: str


class ShelfPlacement(BaseModel):
    """书架上某本书（资料包）的放置信息：所属时间段 + 包摘要。"""

    segment_key: str
    package: ShelfPackage


class ShelfInfoDetail(BaseModel):
    """一座书架（含藏书放置，供 3D 场景渲染）。"""

    l3: CategoryRef | None
    segments: list[ShelfSegment] = []  # 该层自己的分段网格（三级覆盖 > 二级 > 全局）
    config: SegmentConfigOut | None = None  # 该层生效的配置（scope 标明来源）
    counts: dict[str, int]
    total: int
    packages: list[ShelfPlacement] = []


class ShelfGroupDetail(BaseModel):
    l2: CategoryRef | None
    range: ShelfRange | None = None  # 比例时间轴范围（跨层对齐用）
    has_undated: bool = False
    shelves: list[ShelfInfoDetail]
    total: int


class ShelvesDetail(BaseModel):
    l1: CategoryRef
    groups: list[ShelfGroupDetail]
    total: int


class ShelfInfo(BaseModel):
    """一座书架 = 一个三级分类。"""

    l3: CategoryRef | None  # None = 未细分
    segments: list[ShelfSegment] = []
    config: SegmentConfigOut | None = None
    counts: dict[str, int]  # segment key -> 资料包数
    total: int


class ShelfGroup(BaseModel):
    """一组书架 = 一个二级分类（或「未分类」虚拟组）。"""

    l2: CategoryRef | None  # None = 未分类
    range: ShelfRange | None = None
    has_undated: bool = False
    shelves: list[ShelfInfo]
    total: int


class ShelvesOut(BaseModel):
    l1: CategoryRef
    groups: list[ShelfGroup]
    total: int


# ---------- progress ----------

class ProgressIn(BaseModel):
    locator: dict[str, Any] = {}
    percent: float = Field(ge=0.0, le=100.0)


class ProgressOut(BaseModel):
    file_id: int
    locator: dict[str, Any]
    percent: float
    updated_at: datetime

    model_config = {"from_attributes": True}


FileDetail.model_rebuild()
PackageDetail.model_rebuild()
