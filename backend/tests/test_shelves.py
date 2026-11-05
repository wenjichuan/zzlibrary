"""书架聚合（按资料包、多分类路径）与架内资料包 测试。"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from conftest import make_epub, make_media, make_txt, seed_categories, commit_package


def _seed_shelf_data(client: TestClient, tmp_path: Path) -> dict:
    """技术/文学 树：
    - 编程(Python)：2008 三体包、2021 报告包、未注明时间 笔记包 → 按年分段 + 未注明
    - 人工智能：深度学习包 2017
    - 小说：跨界包（双路径：技术/编程 + 文学/小说）2001
    - 散件：技术一级直挂（无二级）2015
    """
    ids = seed_categories(client)
    # 再建一个二级「人工智能」
    ai = client.post("/api/categories", json={"name": "人工智能", "parent_id": ids["l1a"]}).json()
    ids["l2c"] = ai["id"]
    client.put(f"/api/segment-config/{ids['l2b']}", json={"mode": "n_years", "params": {"n": 10}})

    commit_package(client, tmp_path, [("三体.epub", make_epub, None)],
                   meta_overrides={"classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"], "l3_id": ids["l3a"]}], "publish_date": "2008-05-12"}, seq_base=1)
    commit_package(client, tmp_path, [("报告.txt", make_txt, None), ("数据.xlsx", lambda p: p.write_bytes(b"zz"), None)],
                   meta_overrides={"title": "年度报告", "classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"], "l3_id": ids["l3a"]}], "publish_date": "2021"}, seq_base=2)
    commit_package(client, tmp_path, [("笔记.txt", make_txt, None)],
                   meta_overrides={"title": "未注明时间的笔记", "classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"]}], "publish_date": ""}, seq_base=4)
    commit_package(client, tmp_path, [("深度学习.epub", lambda p: make_epub(p, title="深度学习"), None)],
                   meta_overrides={"classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2c"]}], "publish_date": "2017-03"}, seq_base=5)
    # 跨界包：同一包在 技术/编程 和 文学/小说 各挂一条
    commit_package(client, tmp_path, [("跨界.epub", lambda p: make_epub(p, title="跨界之作"), None)],
                   meta_overrides={
                       "publish_date": "2001-03",
                       "classifications": [
                           {"l1_id": ids["l1a"], "l2_id": ids["l2a"]},
                           {"l1_id": ids["l1b"], "l2_id": ids["l2b"]},
                       ],
                   }, seq_base=6)
    commit_package(client, tmp_path, [("会议.mp4", make_media, None)],
                   meta_overrides={"title": "散件会议", "classifications": [{"l1_id": ids["l1a"]}], "publish_date": "2015-01"}, seq_base=7)
    return ids


def test_shelves_aggregation_multi_path(client_authed: TestClient, tmp_path: Path):
    ids = _seed_shelf_data(client_authed, tmp_path)
    resp = client_authed.get("/api/shelves", params={"l1": ids["l1a"]})
    data = resp.json()
    assert data["l1"]["name"] == "技术"
    # 技术：三体、年度报告、笔记、深度学习、跨界、散件 = 6 包（跨界在文学也出现，但这里只计一次）
    assert data["total"] == 6

    names = [(g["l2"]["name"] if g["l2"] else "未分类") for g in data["groups"]]
    assert names == ["编程", "人工智能", "未分类"]

    coding = data["groups"][0]
    # 编程组：三体(2008)、报告(2021)、笔记(未注明)、跨界(2001) = 4 包
    assert coding["total"] == 4
    # 组级比例时间轴范围 = 各层分段/日期并集；组内有未注明时间的书
    assert coding["range"] == {"start": "2001-01-01", "end": "2021-12-31"}
    assert coding["has_undated"] is True
    # 书架：Python（三体/报告）+ 未细分（笔记/跨界），各自独立分段
    assert len(coding["shelves"]) == 2
    shelf = coding["shelves"][0]
    assert shelf["l3"]["name"] == "Python"
    assert [s["label"] for s in shelf["segments"]] == [str(y) for y in range(2008, 2022)]
    assert shelf["counts"]["y2008"] == 1
    assert shelf["counts"]["y2021"] == 1
    assert shelf["total"] == 2
    unsplit = coding["shelves"][1]
    assert [s["label"] for s in unsplit["segments"]] == ["2001", "未注明时间"]
    assert unsplit["counts"]["y2001"] == 1  # 跨界包
    assert unsplit["counts"]["undated"] == 1  # 笔记
    assert unsplit["total"] == 2

    # 跨界包在文学一级分类同样出现
    resp = client_authed.get("/api/shelves", params={"l1": ids["l1b"]})
    lit = resp.json()
    assert lit["total"] == 1
    fiction = lit["groups"][0]
    assert fiction["l2"]["name"] == "小说"
    assert fiction["total"] == 1


def test_shelf_packages_endpoint(client_authed: TestClient, tmp_path: Path):
    ids = _seed_shelf_data(client_authed, tmp_path)
    # 编程 / Python / 2008 层
    resp = client_authed.get(
        "/api/shelves/packages",
        params={"l1": ids["l1a"], "l2": ids["l2a"], "l3": ids["l3a"], "segment": "y2008"},
    )
    assert [p["title"] for p in resp.json()] == ["三体"]

    # 未分类组（l2=none，散件直挂技术一级）
    resp = client_authed.get(
        "/api/shelves/packages",
        params={"l1": ids["l1a"], "l2": "none", "l3": "none", "segment": "y2015"},
    )
    body = resp.json()
    assert [p["title"] for p in body] == ["散件会议"]
    assert body[0]["formats"] == ["mp4"]

    # 跨界包在文学/小说的 2001–2010 层
    resp = client_authed.get(
        "/api/shelves/packages",
        params={"l1": ids["l1b"], "l2": ids["l2b"], "segment": "ny2001"},
    )
    assert [p["title"] for p in resp.json()] == ["跨界之作"]


def test_per_l2_config_override(client_authed: TestClient, tmp_path: Path):
    ids = _seed_shelf_data(client_authed, tmp_path)
    data = client_authed.get("/api/shelves", params={"l1": ids["l1b"]}).json()
    fiction = data["groups"][0]
    shelf = fiction["shelves"][0]  # 小说只有未细分层（跨界包无三级）
    labels = [s["label"] for s in shelf["segments"]]
    assert labels == ["2001–2010"]  # 小说层仅跨界包 2001
    assert shelf["config"]["scope"] == "l2"
    assert fiction["range"] == {"start": "2001-01-01", "end": "2010-12-31"}

    bundle = client_authed.get("/api/segment-config").json()
    assert bundle["global"]["mode"] == "year"
    assert any(o["l2_id"] == ids["l2b"] and o["mode"] == "n_years" for o in bundle["overrides"])

    assert client_authed.delete(f"/api/segment-config/{ids['l2b']}").status_code == 200
    data = client_authed.get("/api/shelves", params={"l1": ids["l1b"]}).json()
    labels = [s["label"] for s in data["groups"][0]["shelves"][0]["segments"]]
    assert labels == ["2001"]
    assert data["groups"][0]["shelves"][0]["config"]["scope"] in ("global", "default")


def test_per_l3_override_alias_and_range_union(client_authed: TestClient, tmp_path: Path):
    """朝代式场景：同组两个三级分类各自分段（带别名），组 range 取并集供跨层对齐。"""
    ids = seed_categories(client_authed)
    a = client_authed.post("/api/categories", json={"name": "甲文明", "parent_id": ids["l2a"]}).json()
    b = client_authed.post("/api/categories", json={"name": "乙文明", "parent_id": ids["l2a"]}).json()
    assert client_authed.put(f"/api/segment-config/l3/{a['id']}", json={
        "mode": "custom",
        "params": {"ranges": [
            {"start": "581", "end": "907", "alias": "隋唐"},
            {"start": "960", "end": "1279", "alias": "宋"},
        ]},
    }).status_code == 200
    assert client_authed.put(f"/api/segment-config/l3/{b['id']}", json={
        "mode": "custom",
        "params": {"ranges": [{"start": "395", "end": "1453", "alias": "帝国存续"}]},
    }).status_code == 200

    commit_package(client_authed, tmp_path, [("甲1.epub", make_epub, None)],
                   meta_overrides={"title": "甲之书·唐", "classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"], "l3_id": a["id"]}], "publish_date": "700"}, seq_base=1)
    commit_package(client_authed, tmp_path, [("甲2.epub", make_epub, None)],
                   meta_overrides={"title": "甲之书·宋", "classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"], "l3_id": a["id"]}], "publish_date": "1100"}, seq_base=2)
    commit_package(client_authed, tmp_path, [("乙1.epub", make_epub, None)],
                   meta_overrides={"title": "乙之书", "classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"], "l3_id": b["id"]}], "publish_date": "800"}, seq_base=3)

    data = client_authed.get("/api/shelves", params={"l1": ids["l1a"]}).json()
    g = data["groups"][0]
    assert g["l2"]["name"] == "编程"
    # 组 range = 581–1279 ∪ 395–1453 的并集
    assert g["range"] == {"start": "0395-01-01", "end": "1453-12-31"}

    shelves = {s["l3"]["name"]: s for s in g["shelves"]}
    a_shelf = shelves["甲文明"]
    assert [(s["label"], s["alias"]) for s in a_shelf["segments"]] == [
        ("581–907", "隋唐"), ("960–1279", "宋"), ("其他", None),
    ]
    assert a_shelf["config"]["scope"] == "l3" and a_shelf["config"]["mode"] == "custom"
    assert a_shelf["counts"][a_shelf["segments"][0]["key"]] == 1  # 700 → 隋唐
    assert a_shelf["counts"][a_shelf["segments"][1]["key"]] == 1  # 1100 → 宋
    b_shelf = shelves["乙文明"]
    assert [(s["label"], s["alias"]) for s in b_shelf["segments"]] == [
        ("395–1453", "帝国存续"), ("其他", None),
    ]
    assert b_shelf["counts"][b_shelf["segments"][0]["key"]] == 1  # 800 → 帝国存续

    # 删除三级覆盖后回退全局默认（按年：700→1100 逐年分段，超上限截断）
    assert client_authed.delete(f"/api/segment-config/l3/{a['id']}").status_code == 200
    data = client_authed.get("/api/shelves", params={"l1": ids["l1a"]}).json()
    a_shelf = next(s for s in data["groups"][0]["shelves"] if s["l3"]["name"] == "甲文明")
    assert all(s["label"].isdigit() for s in a_shelf["segments"])  # 年份标签
    assert a_shelf["segments"][-1]["label"] == "1100"
    assert a_shelf["config"]["scope"] in ("global", "default")
