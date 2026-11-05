"""资料包：暂存入库、多分类路径、列表检索、包内文件管理、删除清理 测试。"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from conftest import (
    make_epub,
    make_image,
    make_media,
    make_pdf,
    make_txt,
    seed_categories,
    stage,
    commit_package,
)


def test_stage_extracts_epub_metadata(client_authed: TestClient, tmp_path: Path):
    staged = stage(client_authed, tmp_path, "三体.epub", make_epub, seq=1)
    assert staged["format"] == "epub"
    assert staged["meta"]["title"] == "三体"
    assert staged["meta"]["authors"] == ["刘慈欣"]
    assert staged["meta"]["publish_date"] == "2008-01-01"
    assert staged["has_cover"] is True
    cover = client_authed.get(f"/api/packages/stage/{staged['stage_id']}/cover")
    assert cover.status_code == 200 and cover.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_stage_media_and_image(client_authed: TestClient, tmp_path: Path):
    video = stage(client_authed, tmp_path, "会议录屏.mp4", make_media, seq=1)
    assert video["format"] == "mp4"
    assert video["has_cover"] is False
    img = stage(client_authed, tmp_path, "白板照片.jpg", make_image, seq=2)
    assert img["format"] == "jpg"
    assert img["has_cover"] is True  # 图片封面即自身


def test_stage_accepts_unknown_format(client_authed: TestClient, tmp_path: Path):
    """不限格式：未知扩展名原样登记（仅登记，无元数据抽取/封面）；无扩展名记 bin。"""
    file_path = tmp_path / "x.exe"
    file_path.write_bytes(b"MZ")
    with open(file_path, "rb") as f:
        resp = client_authed.post("/api/packages/stage", files={"file": ("x.exe", f, "application/octet-stream")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["format"] == "exe"
    assert body["has_cover"] is False
    assert body["meta"]["title"] == "x"

    no_ext = tmp_path / "Makefile"
    no_ext.write_text("all:\n")
    with open(no_ext, "rb") as f:
        resp2 = client_authed.post("/api/packages/stage", files={"file": ("Makefile", f, "text/plain")})
    assert resp2.status_code == 200
    assert resp2.json()["format"] == "bin"


def test_multi_file_package_commit(client_authed: TestClient, tmp_path: Path):
    """会议场景：录屏 + PPT + 纪要 三个文件组一包。"""
    ids = seed_categories(client_authed)
    pkg = commit_package(
        client_authed,
        tmp_path,
        [
            ("架构评审会议.mp4", make_media, None),
            ("评审 slides.pptx", lambda p: p.write_bytes(b"zz"), None),
            ("会议纪要.md", lambda p: make_txt(p, "# 架构评审纪要\n要点"), None),
        ],
        meta_overrides={
            "title": "架构评审会议",
            "classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"]}],
            "publish_date": "2025-10-20",
            "tags": ["会议"],
        },
        seq_base=1,
    )
    assert pkg["title"] == "架构评审会议"
    assert pkg["file_count"] == 3
    fmts = {f["format"] for f in pkg["files"]}
    assert fmts == {"mp4", "pptx", "md"}
    assert pkg["status"] == "未读"
    assert len(pkg["classifications"]) == 1
    assert pkg["classifications"][0]["l1"]["name"] == "技术"
    assert pkg["classifications"][0]["l2"]["name"] == "编程"

    for kind in ("cover", "spine"):
        resp = client_authed.get(f"/api/packages/{pkg['id']}/{kind}")
        assert resp.status_code == 200
        assert resp.content[:8] == b"\x89PNG\r\n\x1a\n", kind

    mp4 = next(f for f in pkg["files"] if f["format"] == "mp4")
    resp = client_authed.get(f"/api/files/{mp4['id']}/file")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "video/mp4"
    resp = client_authed.get(f"/api/files/{mp4['id']}/file", headers={"Range": "bytes=0-31"})
    assert resp.status_code == 206 and len(resp.content) == 32


def test_multiple_classification_paths(client_authed: TestClient, tmp_path: Path):
    """一个包挂多条路径：跨一级分类 + 重复路径去重 + 链校验。"""
    ids = seed_categories(client_authed)
    pkg = commit_package(
        client_authed,
        tmp_path,
        [("三体.epub", make_epub, None)],
        meta_overrides={
            "title": "跨界资料",
            "classifications": [
                {"l1_id": ids["l1a"], "l2_id": ids["l2a"], "l3_id": ids["l3a"]},
                {"l1_id": ids["l1b"], "l2_id": ids["l2b"]},
                # 完全重复的一条 → 去重
                {"l1_id": ids["l1b"], "l2_id": ids["l2b"]},
                # 只给 l2 → 自动补全 l1
                {"l2_id": ids["l2b"]},
            ],
        },
        seq_base=1,
    )
    assert len(pkg["classifications"]) == 2
    paths = {(p["l1"]["id"], p["l2"]["id"] if p["l2"] else None) for p in pkg["classifications"]}
    assert paths == {(ids["l1a"], ids["l2a"]), (ids["l1b"], ids["l2b"])}


def test_classification_chain_validation(client_authed: TestClient, tmp_path: Path):
    ids = seed_categories(client_authed)
    staged = stage(client_authed, tmp_path, "三体.epub", make_epub, seq=1)
    resp = client_authed.post(
        "/api/packages",
        json={
            "stage_ids": [staged["stage_id"]],
            "meta": {
                "title": "x", "authors": [], "publish_date": "", "tags": [],
                "classifications": [{"l1_id": ids["l1b"], "l2_id": ids["l2b"], "l3_id": ids["l3a"]}],
            },
        },
    )
    assert resp.status_code == 422

    # PATCH 整体替换路径
    pkg = commit_package(client_authed, tmp_path, [("三体2.epub", make_epub, None)],
                         meta_overrides={"classifications": [{"l1_id": ids["l1a"]}]}, seq_base=2)
    resp = client_authed.patch(
        f"/api/packages/{pkg['id']}",
        json={"classifications": [{"l2_id": ids["l2b"]}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["classifications"]) == 1
    assert body["classifications"][0]["l1"]["id"] == ids["l1b"]  # l2 自动补全 l1
    assert body["classifications"][0]["l2"]["id"] == ids["l2b"]


def test_commit_rejects_expired_stage(client_authed: TestClient, tmp_path: Path):
    staged = stage(client_authed, tmp_path, "三体.epub", make_epub, seq=1)
    resp = client_authed.post(
        "/api/packages",
        json={"stage_ids": [staged["stage_id"]],
              "meta": {"title": "z", "authors": [], "publish_date": "", "tags": []}},
    )
    assert resp.status_code == 201
    resp = client_authed.post(
        "/api/packages",
        json={"stage_ids": [staged["stage_id"]],
              "meta": {"title": "z", "authors": [], "publish_date": "", "tags": []}},
    )
    assert resp.status_code == 404


def test_list_filters_and_search(client_authed: TestClient, tmp_path: Path):
    ids = seed_categories(client_authed)
    commit_package(client_authed, tmp_path, [("三体.epub", make_epub, None)],
                   meta_overrides={"classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"]}], "publish_date": "2008"}, seq_base=1)
    commit_package(client_authed, tmp_path, [("报告.pdf", make_pdf, None)],
                   meta_overrides={"title": "报告", "classifications": [{"l1_id": ids["l1b"], "l2_id": ids["l2b"]}], "publish_date": "2021-05"}, seq_base=2)
    # 双路径包：同时属于 l1a/l2a 和 l1b/l2b
    commit_package(client_authed, tmp_path, [("会议.mp4", make_media, None), ("纪要.txt", make_txt, None)],
                   meta_overrides={
                       "title": "某次会议",
                       "publish_date": "2023-01",
                       "classifications": [
                           {"l1_id": ids["l1a"], "l2_id": ids["l2a"]},
                           {"l1_id": ids["l1b"], "l2_id": ids["l2b"]},
                       ],
                   }, seq_base=3)
    commit_package(client_authed, tmp_path, [("旧笔记.txt", make_txt, None)],
                   meta_overrides={"title": "旅行笔记"}, seq_base=5)

    r = client_authed.get("/api/packages").json()
    assert r["total"] == 4

    # 任一路径命中即算
    r = client_authed.get("/api/packages", params={"l1": ids["l1a"]}).json()
    assert r["total"] == 2
    r = client_authed.get("/api/packages", params={"l1": ids["l1a"], "l2": ids["l2a"]}).json()
    assert {p["title"] for p in r["items"]} == {"三体", "某次会议"}

    r = client_authed.get("/api/packages", params={"format": "mp4"}).json()
    assert r["total"] == 1 and r["items"][0]["title"] == "某次会议"

    r = client_authed.get("/api/packages", params={"q": "三体"}).json()
    assert r["total"] == 1 and r["items"][0]["title"] == "三体"

    # none = 无任何路径
    r = client_authed.get("/api/packages", params={"l1": "none"}).json()
    assert r["total"] == 1 and r["items"][0]["title"] == "旅行笔记"

    # 未注明时间：只看发布日期缺失的包（编目补全用）
    r = client_authed.get("/api/packages", params={"undated": 1}).json()
    assert r["total"] == 1 and r["items"][0]["title"] == "旅行笔记"
    r = client_authed.get("/api/packages", params={"undated": 1, "l1": "none"}).json()
    assert r["total"] == 1
    r = client_authed.get("/api/packages", params={"undated": 1, "l1": ids["l1a"]}).json()
    assert r["total"] == 0

    r = client_authed.get("/api/packages", params={"sort": "date_asc"}).json()
    assert [p["title"] for p in r["items"]] == ["三体", "报告", "某次会议", "旅行笔记"]


def test_package_file_management(client_authed: TestClient, tmp_path: Path):
    pkg = commit_package(client_authed, tmp_path, [("三体.epub", make_epub, None)], seq_base=1)

    staged = stage(client_authed, tmp_path, "白板照片.png", make_image, seq=2)
    resp = client_authed.post(f"/api/packages/{pkg['id']}/files", json={"stage_id": staged["stage_id"]})
    assert resp.status_code == 201
    new_file = resp.json()
    assert new_file["format"] == "png" and new_file["has_cover"] is True

    detail = client_authed.get(f"/api/packages/{pkg['id']}").json()
    assert detail["file_count"] == 2

    resp = client_authed.patch(
        f"/api/packages/{pkg['id']}/files/{new_file['id']}",
        json={"name": "会议白板.png", "sort_order": 0},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "会议白板.png"

    resp = client_authed.delete(f"/api/packages/{pkg['id']}/files/{new_file['id']}")
    assert resp.status_code == 200
    detail = client_authed.get(f"/api/packages/{pkg['id']}").json()
    assert detail["file_count"] == 1
    assert client_authed.get(f"/api/files/{new_file['id']}/file").status_code == 404


def test_patch_and_delete_package(client_authed: TestClient, tmp_path: Path):
    ids = seed_categories(client_authed)
    pkg = commit_package(client_authed, tmp_path, [("三体.epub", make_epub, None)],
                         meta_overrides={"classifications": [{"l1_id": ids["l1a"]}]}, seq_base=1)

    resp = client_authed.patch(
        f"/api/packages/{pkg['id']}",
        json={"title": "三体（重版）", "publish_date": "1999",
              "classifications": [{"l1_id": ids["l1b"], "l2_id": ids["l2b"]}]},
    )
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["title"] == "三体（重版）"
    assert updated["classifications"][0]["l2"]["name"] == "小说"
    assert updated["publish_date"] == "1999-01-01"
    spine = client_authed.get(f"/api/packages/{pkg['id']}/spine")
    assert spine.status_code == 200

    assert client_authed.delete(f"/api/packages/{pkg['id']}").status_code == 200
    assert client_authed.get(f"/api/packages/{pkg['id']}").status_code == 404


def test_bc_publish_date_roundtrip_and_sort(client_authed: TestClient, tmp_path: Path):
    """公元前日期：入库（前221 / -202 写法）、规范化返回、排序在前。"""
    ids = seed_categories(client_authed)
    qin = commit_package(client_authed, tmp_path, [("编年记.txt", make_txt, None)],
                         meta_overrides={"title": "编年记", "publish_date": "前213",
                                         "classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"]}]},
                         seq_base=30)
    assert qin["publish_date"] == "-0213-01-01"
    han = commit_package(client_authed, tmp_path, [("史记.txt", make_txt, None)],
                         meta_overrides={"title": "史记", "publish_date": "-91-05",
                                        "classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"]}]},
                         seq_base=31)
    assert han["publish_date"] == "-0091-05-01"
    modern = commit_package(client_authed, tmp_path, [("新唐书.txt", make_txt, None)],
                            meta_overrides={"title": "新唐书", "publish_date": "1060",
                                            "classifications": [{"l1_id": ids["l1a"], "l2_id": ids["l2a"]}]},
                            seq_base=32)
    assert modern["publish_date"] == "1060-01-01"

    # 年代升序：秦 < 汉 < 宋；公开拒绝公元 0 年
    resp = client_authed.get("/api/packages", params={"sort": "date_asc", "page_size": 50})
    titles = [p["title"] for p in resp.json()["items"]]
    assert titles.index("编年记") < titles.index("史记") < titles.index("新唐书")

    resp = client_authed.patch(f"/api/packages/{modern['id']}", json={"publish_date": "0"})
    assert resp.status_code == 422 and "公元 0 年" in resp.text


def test_stage_discard(client_authed: TestClient, tmp_path: Path):
    """放弃入库：主动废弃暂存应立即删除文件，之后 commit 该 id 报过期。"""
    staged = stage(client_authed, tmp_path, "放弃.txt", make_txt, seq=50)
    sid = staged["stage_id"]

    # 未废弃前可直接 commit
    resp = client_authed.post(
        "/api/packages/stage/discard", json={"stage_ids": [sid, "not-a-uuid", "0" * 31 + "g"]}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True and body["removed"] == 1  # 非法 id 被静默跳过

    # 暂存已删 → 再用它 commit 报 404 过期
    resp = client_authed.post(
        "/api/packages",
        json={"stage_ids": [sid], "meta": {"title": "x", "authors": [], "publish_date": "",
                                           "publisher": None, "tags": [], "notes": None, "classifications": []}},
    )
    assert resp.status_code == 404


def test_cannot_remove_last_file(client_authed: TestClient, tmp_path: Path):
    """空包守卫：移除包内唯一文件应 422（提示删整包或先加文件），文件保留。"""
    ids = seed_categories(client_authed)
    pkg = commit_package(client_authed, tmp_path, [("孤本.epub", make_epub, None)],
                         meta_overrides={"title": "孤本包",
                                         "classifications": [{"l1_id": ids["l1a"]}]},
                         seq_base=60)
    fid = pkg["files"][0]["id"]
    resp = client_authed.delete(f"/api/packages/{pkg['id']}/files/{fid}")
    assert resp.status_code == 422 and "唯一的文件" in resp.json()["detail"]
    # 文件仍在，可正常访问
    assert client_authed.get(f"/api/files/{fid}/file").status_code == 200
