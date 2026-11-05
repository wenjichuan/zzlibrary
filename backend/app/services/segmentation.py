"""时间分段计算。

日期全线使用「带符号定宽年」规范文本（见 schemas.canonical_date_str）：
公元前 -0221-01-01、公元 0630-01-01；定宽+符号保证字典序 = 时间序。

给定一组发布日期与分段配置，产出该组书架的时间层网格：
- year     每年一段
- n_years  每 N 年一段（params.n，默认 5）
- decade   按十年（1990–1999；公元前按 -0220–-0211 对齐）
- month    每月一段（超过 300 段自动退化为按年）
- custom   用户自定义区间（params.ranges=[{start,end,alias}]，起止支持 前618 / -618 /
           YYYY / YYYY-MM / YYYY-MM-DD），区间之外入「其他」；
           alias 为易于理解的别名（如朝代名），显示为「前221–前207（秦）」
无日期的书统一进入末尾的「未注明时间」段。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from ..schemas import SegmentConfigIn, canonical_date_str, year_of_key

MAX_AUTO_SEGMENTS = 300
UNDATED_KEY = "undated"
UNDATED_LABEL = "未注明时间"
OTHER_KEY = "other"
OTHER_LABEL = "其他"

_DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _is_leap(year: int) -> bool:
    # Python 负数取模恰好使该式对公元前同样成立（-4 % 4 == 0）
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _month_end_str(year: int, month: int) -> str:
    day = 29 if month == 2 and _is_leap(year) else _DAYS_IN_MONTH[month - 1]
    return canonical_date_str(year, month, day)


def format_year(canonical_or_year: str | int) -> str:
    """年份显示：负年（公元前）渲染为「前221」。入参可为序键文本或整年。"""
    y = (
        canonical_or_year
        if isinstance(canonical_or_year, int)
        else year_of_key(canonical_or_year)
    )
    return f"前{-y}" if y < 0 else str(y)


@dataclass
class Segment:
    key: str
    label: str
    start: str | None  # 规范日期文本
    end: str | None
    alias: str | None = None  # 别名（如朝代/时期名），custom 段可选


@dataclass
class SegmentGrid:
    segments: list[Segment]

    def index_for(self, d: str | None) -> int:
        return index_for(self.segments, d)


def _norm(d) -> str | None:
    """兼容传入 datetime.date（自动转规范文本）。"""
    if d is None:
        return None
    if isinstance(d, str):
        return d
    return canonical_date_str(d.year, d.month, d.day)


def index_for(grid: list[Segment], d: str | None) -> int:
    """返回日期所属分段下标；未注明时间返回末段。"""
    d = _norm(d)
    for i, seg in enumerate(grid):
        if seg.key == UNDATED_KEY:
            if d is None:
                return i
            continue
        if d is not None and seg.start is not None and seg.end is not None:
            if seg.start <= d <= seg.end:  # 规范文本字典序 = 时间序
                return i
    # custom 配置下不在任何区间 → 「其他」段；若没有其他段则兜底最后一段
    for i, seg in enumerate(grid):
        if seg.key == OTHER_KEY and d is not None:
            return i
    return len(grid) - 1


def _year_segments(dates: list[str]) -> list[Segment]:
    years = sorted(year_of_key(d) for d in dates)
    lo, hi = years[0], years[-1]
    if hi - lo + 1 > MAX_AUTO_SEGMENTS:
        lo = max(lo, hi - MAX_AUTO_SEGMENTS + 1)
    return [
        Segment(
            key=f"y{y}",
            label=format_year(y),
            start=canonical_date_str(y, 1, 1),
            end=canonical_date_str(y, 12, 31),
        )
        for y in range(lo, hi + 1)
    ]


def _n_years_segments(dates: list[str], n: int) -> list[Segment]:
    n = max(1, min(int(n or 5), 100))
    lo_year = (min(year_of_key(d) for d in dates) - 1) // n * n + 1  # 对齐到 1 mod n 网格（公元前可用）
    hi_year = max(year_of_key(d) for d in dates)
    segments: list[Segment] = []
    start_year = lo_year
    while start_year <= hi_year and len(segments) < MAX_AUTO_SEGMENTS:
        end_year = min(start_year + n - 1, 9999)
        if end_year == 0:  # 无公元 0 年：前1 结束这一段，下一段从公元 1 开始
            end_year = -1
        segments.append(
            Segment(
                key=f"ny{start_year}",
                label=f"{format_year(start_year)}–{format_year(end_year)}",
                start=canonical_date_str(start_year, 1, 1),
                end=canonical_date_str(end_year, 12, 31),
            )
        )
        start_year += n
        if start_year == 0:
            start_year = 1
    return segments


def _decade_segments(dates: list[str]) -> list[Segment]:
    years = [year_of_key(d) for d in dates]
    lo = min(years) // 10 * 10
    hi = max(years) // 10 * 10
    segments: list[Segment] = []
    d0 = lo
    while d0 <= hi and len(segments) < MAX_AUTO_SEGMENTS:
        if d0 == 0:  # 无公元 0 年：公元 1~9 单独成段
            start_year, d1 = 1, 9
        else:
            start_year, d1 = d0, d0 + 9
        segments.append(
            Segment(
                key=f"d{d0}",
                label=f"{format_year(start_year)}–{format_year(d1)}",
                start=canonical_date_str(start_year, 1, 1),
                end=canonical_date_str(d1, 12, 31),
            )
        )
        d0 += 10
    return segments


def _month_segments(dates: list[str]) -> list[Segment]:
    lo, hi = min(dates), max(dates)
    lo_y, hi_y = year_of_key(lo), year_of_key(hi)
    lo_m, hi_m = int(lo[5:7]), int(hi[5:7])
    total = (hi_y - lo_y) * 12 + hi_m - lo_m + 1
    if total > MAX_AUTO_SEGMENTS:
        return _year_segments(dates)
    segments: list[Segment] = []
    year, month = lo_y, lo_m
    while (year, month) <= (hi_y, hi_m):
        start = canonical_date_str(year, month, 1)
        end = _month_end_str(year, month)
        label = f"{format_year(year)}-{month:02d}"
        segments.append(Segment(key=f"m{year}{month:02d}", label=label, start=start, end=end))
        month += 1
        if month > 12:
            year, month = year + 1, 1
    return segments


def _parse_boundary(value: object, *, is_end: bool) -> str | None:
    """宽松解析区间边界：前618 / -618 / YYYY（→1/1 或 12/31）、YYYY-MM、YYYY-MM-DD。"""
    s = str(value or "").strip()
    if not s:
        return None
    neg = False
    if s.startswith("公元前"):
        neg, s = True, s[3:].strip()
    elif s.startswith("前"):
        neg, s = True, s[1:].strip()
    elif s.startswith("-"):
        neg, s = True, s[1:].strip()
    m = re.fullmatch(r"(\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?", s)
    if not m:
        return None
    year = -int(m.group(1)) if neg else int(m.group(1))
    if year == 0 or year < -9999:
        return None
    month = int(m.group(2)) if m.group(2) else None
    day = int(m.group(3)) if m.group(3) else None
    if month is None:
        return canonical_date_str(year, 1, 1) if not is_end else canonical_date_str(year, 12, 31)
    if not 1 <= month <= 12:
        return None
    if day is None:
        return canonical_date_str(year, month, 1) if not is_end else _month_end_str(year, month)
    if not 1 <= day <= 31:
        return None
    return canonical_date_str(year, month, day)


def parse_range(raw: dict) -> tuple[str, str, str | None] | None:
    """解析一条自定义区间 → (start, end, alias)；无效返回 None。alias 兼容旧 label 字段。"""
    if not isinstance(raw, dict):
        return None
    start = _parse_boundary(raw.get("start"), is_end=False)
    end = _parse_boundary(raw.get("end"), is_end=True)
    if start is None or end is None:
        return None
    if end < start:
        start, end = end, start
    alias = str(raw.get("alias") or raw.get("label") or "").strip() or None
    return start, end, alias


def _custom_segments(ranges: list[dict]) -> list[Segment]:
    segments: list[Segment] = []
    for r in ranges:
        parsed = parse_range(r)
        if parsed is None:
            continue
        start, end, alias = parsed
        segments.append(
            Segment(
                key=f"c{start}_{end}",
                label=f"{format_year(start)}–{format_year(end)}",
                alias=alias,
                start=start,
                end=end,
            )
        )
    segments.sort(key=lambda s: (s.start, s.end))
    if segments:
        segments.append(Segment(key=OTHER_KEY, label=OTHER_LABEL, start=None, end=None))
    return segments


def compute_grid(dates: list, config: SegmentConfigIn | None) -> list[Segment]:
    """根据组内日期与配置生成分段网格（含「未注明时间」段）。日期接受规范文本或 date。"""
    dated = sorted(_norm(d) for d in dates if d is not None)
    segments: list[Segment] = []
    mode = config.mode if config else "year"
    params = (config.params if config else {}) or {}

    if mode == "custom":
        segments = _custom_segments(list(params.get("ranges") or []))
        if not segments and dated:
            segments = _year_segments(dated)
    elif dated:
        if mode == "n_years":
            segments = _n_years_segments(dated, int(params.get("n") or 5))
        elif mode == "decade":
            segments = _decade_segments(dated)
        elif mode == "month":
            segments = _month_segments(dated)
        else:
            segments = _year_segments(dated)

    if any(d is None for d in dates):
        segments.append(Segment(key=UNDATED_KEY, label=UNDATED_LABEL, start=None, end=None))
    return segments
