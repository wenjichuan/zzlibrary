"""批量演示数据：造 ~140 个包，专供体验「书多时的时间轴行为」。

特征设计：
- 发布时间：隋唐 60 包（看段内堆叠折行）、西汉 15 包（公元前+堆叠）、秦2/宋12/明12/清10、
  未注明 8 包（右侧固定列）、东罗马 25 包（拜占庭段）；日期混合 年 / 年-月 / 年-月-日
- 入库时间：建完后直写 DB，把 created_at 摊到过去 ~5 个月（两次入库高峰 + 空档月），
  入库时间轴由此呈现月度分段与「该时段未入库」空档

用法：
    python scripts/seed_bulk_demo.py            # 造数据
    python scripts/seed_bulk_demo.py --clean    # 删除本脚本造的包（notes 标记识别）
"""
from __future__ import annotations

import argparse
import io
import random
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import httpx

BASE = "http://localhost:8000"
USERNAME = "admin"
PASSWORD = "zzlibrary"
MARK = "bulk-demo"  # notes 标记：--clean 按此识别
DB = Path(__file__).resolve().parents[2] / "data" / "library.db"

random.seed(42)

# (三级, 年份区间/None=未注明, 数量, 日期精度池)
PLAN = [
    ("中国", (581, 907), 60, ["y", "ym", "ymd"]),  # 隋唐：主力堆叠
    ("中国", (-202, -1), 15, ["y", "ym"]),  # 西汉：公元前 + 堆叠
    ("中国", (-221, -207), 2, ["y"]),  # 秦
    ("中国", (960, 1279), 12, ["y", "ym", "ymd"]),  # 宋
    ("中国", (1368, 1644), 12, ["y", "ym", "ymd"]),  # 明
    ("中国", (1644, 1912), 10, ["y", "ym"]),  # 清
    ("中国", None, 8, [None]),  # 未注明时间 → 右侧固定列
    ("东罗马", (476, 1453), 25, ["y", "ym", "ymd"]),  # 拜占庭
]

PREFIX = {
    "隋唐": ["贞观", "开元", "天宝", "永徽", "会昌", "大中", "长庆", "咸通"],
    "西汉": ["建元", "元光", "元狩", "太初", "征和", "始元", "甘露"],
    "秦": ["始皇", "二世"],
    "宋": ["淳化", "景祐", "熙宁", "元丰", "崇宁", "淳熙", "嘉定"],
    "明": ["洪武", "永乐", "宣德", "成化", "弘治", "嘉靖", "万历"],
    "清": ["顺治", "康熙", "雍正", "乾隆", "嘉庆", "光绪"],
    "拜占庭": ["查士丁尼", "希拉克略", "马其顿", "科穆宁", "帕列奥列"],
}
SUFFIX = ["实录", "遗文辑", "诏令集", "行记", "碑铭集", "类书钞", "文书辑存", "杂抄", "奏议", "图志"]


def era_for(l3: str, year: int) -> str:
    if l3 != "中国":
        return "拜占庭"
    if year < 0:
        return "秦" if year >= -221 else "西汉"
    for name, (a, b) in [("隋唐", (581, 907)), ("宋", (960, 1279)), ("明", (1368, 1644)), ("清", (1644, 1912))]:
        if a <= year <= b:
            return name
    return "隋唐"


def gen_date(year: int, prec: str) -> str:
    if year < 0:
        base = f"前{-year}"
        return base + (f"-{random.randint(1, 12):02d}" if prec == "ym" else "")
    base = f"{year}"
    if prec == "ym":
        return base + f"-{random.randint(1, 12):02d}"
    if prec == "ymd":
        return base + f"-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}"
    return base


def main() -> None:
    clean = "--clean" in sys.argv[1:]
    ap = argparse.ArgumentParser()
    ap.parse_args()

    con = sqlite3.connect(DB)
    with httpx.Client(base_url=BASE, timeout=30) as c:
        c.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD}).raise_for_status()

        if clean:
            ids = [r[0] for r in con.execute("SELECT id FROM packages WHERE notes = ?", (MARK,))]
            for pid in ids:
                c.delete(f"/api/packages/{pid}").raise_for_status()
            print(f"已清理 {len(ids)} 个批量演示包")
            con.close()
            return

        tree = c.get("/api/categories").raise_for_status().json()
        l1 = next(n for n in tree if n["name"] == "历史")
        l2 = next(n for n in l1["children"] if n["name"] == "古代文明")
        l3s = {n["name"]: n["id"] for n in l2["children"]}

        existing = {
            p["title"]
            for pg in (
                c.get("/api/packages", params={"page": i, "page_size": 100}).raise_for_status().json()
                for i in range(1, 10)
            )
            for p in pg["items"]
        }

        created: list[int] = []
        n = 0
        for l3_name, span, count, precs in PLAN:
            for _ in range(count):
                n += 1
                year = random.randint(*span) if span else 0
                era = era_for(l3_name, year) if span else "存目"
                title = f"样·{era}{random.choice(PREFIX.get(era, ['辑']))}{random.choice(SUFFIX)}{n:03d}"
                if title in existing:
                    continue
                prec = random.choice(precs) if precs[0] else None
                publish = gen_date(year, prec) if prec else ""
                n_files = 2 if n % 7 == 0 else 1
                stage_ids = []
                for j in range(n_files):
                    suffix = f"-{j + 1}" if n_files > 1 else ""
                    r = c.post(
                        "/api/packages/stage",
                        files={
                            "file": (
                                f"{title}{suffix}.txt",
                                io.BytesIO(f"{title}\n批量演示数据（seed_bulk_demo）".encode("utf-8")),
                                "text/plain",
                            )
                        },
                    )
                    r.raise_for_status()
                    stage_ids.append(r.json()["stage_id"])
                r = c.post(
                    "/api/packages",
                    json={
                        "stage_ids": stage_ids,
                        "meta": {
                            "title": title,
                            "authors": ["佚名"],
                            "publish_date": publish,
                            "publisher": "",
                            "tags": ["批量演示"],
                            "notes": MARK,
                            "classifications": [{"l1_id": l1["id"], "l2_id": l2["id"], "l3_id": l3s[l3_name]}],
                        },
                    },
                )
                r.raise_for_status()
                created.append(r.json()["id"])
        print(f"已创建 {len(created)} 个包")

        # 入库时间摊开：过去 ~150 天，两次高峰（30 天前 / 100 天前）+ 中间空档，其余零散
        now = datetime.now()
        days_pool: list[int] = []
        for _ in range(len(created) // 2):
            days_pool.append(max(1, int(random.gauss(30, 8))))
        for _ in range(len(created) // 3):
            days_pool.append(max(1, int(random.gauss(100, 10))))
        while len(days_pool) < len(created):
            days_pool.append(random.randint(1, 150))
        random.shuffle(days_pool)
        rows = []
        for pid, d in zip(created, days_pool):
            t = now - timedelta(days=d, seconds=random.randint(0, 86399))
            rows.append((t.strftime("%Y-%m-%d %H:%M:%S.%f"), pid))
        con.executemany("UPDATE packages SET created_at = ? WHERE id = ?", rows)
        con.commit()
        print(f"入库时间已摊到过去 {max(days_pool)} 天（高峰 ~30 天前与 ~100 天前）")
    con.close()


if __name__ == "__main__":
    main()
