"""时间分段纯逻辑测试。"""
from __future__ import annotations

from datetime import date

from app.schemas import SegmentConfigIn, display_date
from app.services.segmentation import compute_grid, index_for


def _d(s: str) -> date:
    return date.fromisoformat(s)


def test_year_mode():
    grid = compute_grid([_d("2008-05-01"), _d("2021-01-01")], SegmentConfigIn(mode="year"))
    assert [s.label for s in grid] == [str(y) for y in range(2008, 2022)]


def test_year_mode_truncates_huge_ranges():
    dates = [_d("1800-01-01"), _d("2100-01-01")]
    grid = compute_grid(dates, SegmentConfigIn(mode="year"))
    assert len(grid) <= 301  # 上限截断 + 首段


def test_n_years_mode():
    grid = compute_grid([_d("2001-03-01"), _d("2022-07-01")], SegmentConfigIn(mode="n_years", params={"n": 10}))
    assert [s.label for s in grid] == ["2001–2010", "2011–2020", "2021–2030"]
    assert grid[0].start == "2001-01-01" and grid[0].end == "2010-12-31"


def test_decade_mode_alignment():
    grid = compute_grid([_d("1995-06-01"), _d("2003-02-01")], SegmentConfigIn(mode="decade"))
    assert [s.label for s in grid] == ["1990–1999", "2000–2009"]
    assert grid[0].start == "1990-01-01"


def test_month_mode_and_fallback():
    grid = compute_grid([_d("2020-01-15"), _d("2020-04-02")], SegmentConfigIn(mode="month"))
    assert [s.label for s in grid] == ["2020-01", "2020-02", "2020-03", "2020-04"]
    # 跨度太大退化为按年
    grid = compute_grid([_d("1900-01-01"), _d("2100-01-01")], SegmentConfigIn(mode="month"))
    assert all(len(s.label) == 4 for s in grid)


def test_custom_mode_with_other_segment():
    cfg = SegmentConfigIn(
        mode="custom",
        params={"ranges": [
            {"alias": "早期", "start": "1990-01-01", "end": "1999-12-31"},
            {"alias": "千禧年", "start": "2000-01-01", "end": "2009-12-31"},
        ]},
    )
    grid = compute_grid([_d("1995-05-01"), _d("2005-05-01"), _d("2015-05-01")], cfg)
    assert [(s.label, s.alias) for s in grid] == [
        ("1990–1999", "早期"),
        ("2000–2009", "千禧年"),
        ("其他", None),
    ]
    assert index_for(grid, _d("2015-05-01")) == 2
    assert index_for(grid, _d("1995-05-01")) == 0


def test_custom_loose_dates_and_alias():
    """朝代式区间：只填年份 + 别名；旧 label 字段兼容为别名。"""
    cfg = SegmentConfigIn(
        mode="custom",
        params={"ranges": [
            {"start": "618", "end": "907", "alias": "唐"},
            {"start": "1368", "end": "1644", "label": "明"},
        ]},
    )
    grid = compute_grid([_d("0750-01-01"), _d("1400-01-01")], cfg)
    assert [(s.start, s.end) for s in grid[:2]] == [
        ("0618-01-01", "0907-12-31"),
        ("1368-01-01", "1644-12-31"),
    ]
    assert grid[0].label == "618–907" and grid[0].alias == "唐"
    assert grid[1].label == "1368–1644" and grid[1].alias == "明"
    assert index_for(grid, _d("1400-05-01")) == 1
    assert index_for(grid, _d("1000-01-01")) == 2  # 区间之间 → 其他
    assert grid[-1].key == "other" and grid[-1].alias is None


def test_undated_segment_appended():
    grid = compute_grid([_d("2020-01-01"), None], SegmentConfigIn(mode="year"))
    assert grid[-1].key == "undated" and grid[-1].label == "未注明时间"
    assert index_for(grid, None) == len(grid) - 1
    assert index_for(grid, _d("2020-06-01")) == 0


# ---------- 公元前 ----------

def _key(s: str) -> str:
    """人类写法 → 序键。"""
    from app.schemas import parse_partial_date

    return parse_partial_date(s)


def test_bc_key_encoding_and_order():
    """序键 9 补码编码：字典序 = 时间序（跨公元前/公元）。"""
    from app.schemas import canonical_date_str, display_date, year_of_key

    assert _key("前1") == "-9999-01-01" and _key("前221") == "-9779-01-01"
    assert _key("-91-05") == "-9909-05-01"  # 前91年5月
    assert display_date("-9779-05-01") == "-0221-05-01"
    assert display_date("0630-01-01") == "0630-01-01"  # 公元不变
    assert year_of_key("-9779-01-01") == -221
    # 字典序 = 时间序
    keys = [_key(k) for k in ["前221", "前202", "前1", "8", "618"]]  # 时间序输入
    assert keys == sorted(keys)


def test_bc_custom_ranges():
    """秦汉式区间：前221 写法 + 负年标签「前221–前207（秦）」。"""
    cfg = SegmentConfigIn(
        mode="custom",
        params={"ranges": [
            {"start": "前221", "end": "前207", "alias": "秦"},
            {"start": "-202", "end": "8", "alias": "西汉"},
        ]},
    )
    grid = compute_grid([_key("前221-05-01"), _key("100-01-01")], cfg)
    assert [display_date(s.start) for s in grid[:2]] == ["-0221-01-01", "-0202-01-01"]
    assert [display_date(s.end) for s in grid[:2]] == ["-0207-12-31", "0008-12-31"]
    assert grid[0].label == "前221–前207" and grid[0].alias == "秦"
    assert grid[1].label == "前202–8" and grid[1].alias == "西汉"
    assert grid[0].start < grid[1].start < _key("1")  # 序：秦 < 西汉 < 公元
    assert index_for(grid, _key("前221-06-01")) == 0
    assert index_for(grid, _key("5-01-01")) == 1
    assert index_for(grid, _key("100-01-01")) == 2  # 区间外 → 其他


def test_bc_auto_year_mode_and_labels():
    grid = compute_grid([_key("前221"), _key("前206"), _key("8")], SegmentConfigIn(mode="year"))
    labels = [s.label for s in grid]
    assert labels[:3] == ["前221", "前220", "前219"]
    assert labels[-1] == "8"
    assert display_date(grid[0].start) == "-0221-01-01"
    assert display_date(grid[-1].end) == "0008-12-31"


def test_bc_decade_alignment():
    grid = compute_grid([_key("前221"), _key("3")], SegmentConfigIn(mode="decade"))
    labels = [s.label for s in grid]
    assert labels[0] == "前230–前221"  # floor 对齐：-230..-221
    assert labels[-1] == "1–9"  # 公元 1~9（无公元 0 年）
    assert grid[-1].start == "0001-01-01"
    assert grid[0].start < grid[-1].start
