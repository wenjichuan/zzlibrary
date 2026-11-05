"""朝代式演示数据：历史/古代文明/中国+东罗马，三级各自分段（带别名）。

用法：
    python scripts/seed_history_demo.py            # 建分类 + 分段配置 + 演示包
    python scripts/seed_history_demo.py --clean    # 删除演示包/配置/分类
"""
from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

import httpx

BASE = "http://localhost:8000"
USERNAME = "admin"
PASSWORD = "zzlibrary"  # 与 .env 保持一致

CHINA_RANGES = [
    {"start": "前221", "end": "前207", "alias": "秦"},
    {"start": "前202", "end": "8", "alias": "西汉"},
    {"start": "581", "end": "907", "alias": "隋唐"},
    {"start": "960", "end": "1279", "alias": "宋"},
    {"start": "1368", "end": "1644", "alias": "明"},
    {"start": "1644", "end": "1912", "alias": "清"},
]
ROME_RANGES = [
    {"start": "395", "end": "476", "alias": "晚期罗马"},
    {"start": "476", "end": "1453", "alias": "拜占庭"},
]
# 其他文明：各自的时代段（无配置的层走全局默认；埃及的书无日期 → 未注明时间列）
CIV_RANGES = {
    "希腊": [{"start": "100", "end": "529", "alias": "罗马治下"}],
    "波斯": [{"start": "224", "end": "651", "alias": "萨珊"}],
    "印度": [{"start": "320", "end": "550", "alias": "笈多"}],
    "阿拉伯": [{"start": "632", "end": "1258", "alias": "帝国"}],
    "日本": [{"start": "794", "end": "1185", "alias": "平安"}],
    "玛雅": [{"start": "250", "end": "950", "alias": "古典期"}],
}
BOOKS = [
    # (三级名, 包名, 年份, 文件数)；年份 0 = 未注明时间；负数 = 公元前
    ("中国", "编年记·秦简", -213, 2),
    ("中国", "史记·太史公自序抄", -91, 1),
    ("中国", "贞观政要", 630, 2),
    ("中国", "唐六典", 738, 1),
    ("中国", "东京梦华录", 1147, 1),
    ("中国", "天工开物", 1637, 3),
    ("中国", "四库全书总目", 1790, 1),
    ("东罗马", "民法大全", 533, 2),
    ("东罗马", "建筑十书·抄本", 850, 1),
    ("东罗马", "君士坦丁堡城防记", 1200, 1),
    ("东罗马", "最后的城墙", 1440, 1),
    ("希腊", "天文学大成", 150, 1),
    ("波斯", "阿维斯陀注释", 500, 1),
    ("印度", "沙恭达罗", 400, 1),
    ("阿拉伯", "一千零一夜·抄本", 850, 2),
    ("日本", "源氏物语", 1008, 1),
    ("玛雅", "波南帕克壁画摹本", 790, 1),
    ("埃及", "亡灵书·摹本", 0, 1),
]


def make_txt(title: str) -> bytes:
    return f"{title}\n演示文本资料包（zzlibrary 演示数据）".encode("utf-8")


def main() -> None:
    clean = "--clean" in sys.argv[1:]
    ap = argparse.ArgumentParser()
    ap.parse_args()
    with httpx.Client(base_url=BASE, timeout=30) as c:
        r = c.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD})
        r.raise_for_status()

        # 定位/创建 分类
        tree = c.get("/api/categories").raise_for_status().json()
        l1 = next((n for n in tree if n["name"] == "历史"), None)
        if clean:
            pkg_page = c.get("/api/packages", params={"q": "", "page": 1, "page_size": 100}).raise_for_status().json()
            for p in pkg_page["items"]:
                if p["title"] in {b[1] for b in BOOKS}:
                    c.delete(f"/api/packages/{p['id']}")
            if l1:
                c.delete(f"/api/categories/{l1['id']}")
            print("已清理演示数据")
            return

        if l1 is None:
            l1 = c.post("/api/categories", json={"name": "历史"}).raise_for_status().json()
        l2 = next((n for n in l1["children"] if n["name"] == "古代文明"), None)
        if l2 is None:
            l2 = c.post("/api/categories", json={"name": "古代文明", "parent_id": l1["id"]}).raise_for_status().json()
        civ_names = sorted({b[0] for b in BOOKS})
        l3s = {n["name"]: n for n in l2["children"] if n["name"] in civ_names}
        for name in civ_names:
            if name not in l3s:
                l3s[name] = c.post(
                    "/api/categories", json={"name": name, "parent_id": l2["id"]}
                ).raise_for_status().json()

        # 三级覆盖：各自时代分段（带别名）；无配置的层（埃及）走全局默认
        ranges_by_civ = {"中国": CHINA_RANGES, "东罗马": ROME_RANGES, **CIV_RANGES}
        for name, ranges in ranges_by_civ.items():
            c.put(
                f"/api/segment-config/l3/{l3s[name]['id']}",
                json={"mode": "custom", "params": {"ranges": ranges}},
            ).raise_for_status()

        # 演示包（已存在则跳过）
        existing = {
            p["title"]
            for p in c.get("/api/packages", params={"page": 1, "page_size": 100}).raise_for_status().json()["items"]
        }
        for i, (l3_name, title, year, n_files) in enumerate(BOOKS):
            if title in existing:
                continue
            stage_ids = []
            for j in range(n_files):
                suffix = f"-{j + 1}" if n_files > 1 else ""
                fname = f"{title}{suffix}.txt"
                r = c.post(
                    "/api/packages/stage",
                    files={"file": (fname, io.BytesIO(make_txt(title)), "text/plain")},
                )
                r.raise_for_status()
                stage_ids.append(r.json()["stage_id"])
            c.post(
                "/api/packages",
                json={
                    "stage_ids": stage_ids,
                    "meta": {
                        "title": title,
                        "authors": ["佚名"],
                        "publish_date": (f"前{-year}" if year < 0 else str(year)) if year else "",                        "publisher": None,
                        "tags": ["演示"],
                        "notes": "朝代式时间轴演示数据",
                        "classifications": [
                            {"l1_id": l1["id"], "l2_id": l2["id"], "l3_id": l3s[l3_name]["id"]}
                        ],
                    },
                },
            ).raise_for_status()
            print(f"+ {title}（{f'前{-year}' if year < 0 else (year or '未注明')}，{l3_name}）")

        print(f"完成。书架：/shelves/{l1['id']}")


if __name__ == "__main__":
    main()
