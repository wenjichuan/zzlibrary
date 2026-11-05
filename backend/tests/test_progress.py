"""文件级阅读进度与包状态聚合 测试。"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from conftest import make_epub, make_media, make_txt, commit_package, stage


def _make_two_file_package(client, tmp_path) -> dict:
    return commit_package(
        client, tmp_path,
        [("三体.epub", make_epub, None), ("访谈录屏.mp4", make_media, None)],
        meta_overrides={"title": "三体资料包", "publish_date": "2008"},
        seq_base=1,
    )


def test_progress_roundtrip_and_package_status(client_authed: TestClient, tmp_path: Path):
    pkg = _make_two_file_package(client_authed, tmp_path)
    epub_file = next(f for f in pkg["files"] if f["format"] == "epub")
    video_file = next(f for f in pkg["files"] if f["format"] == "mp4")

    assert client_authed.get(f"/api/progress/{epub_file['id']}").json() is None

    resp = client_authed.put(
        f"/api/progress/{epub_file['id']}",
        json={"locator": {"cfi": "epubcfi(/6/4!/4/2)"}, "percent": 12.5},
    )
    assert resp.status_code == 200
    assert resp.json()["file_id"] == epub_file["id"]

    detail = client_authed.get(f"/api/packages/{pkg['id']}").json()
    assert detail["status"] == "在读"
    assert detail["files"][0]["progress"]["percent"] == 12.5

    # 另一个文件看完 → 包仍在读（第一个文件只读了 12.5%）
    client_authed.put(f"/api/progress/{video_file['id']}", json={"locator": {"seconds": 0}, "percent": 100})
    detail = client_authed.get(f"/api/packages/{pkg['id']}").json()
    assert detail["status"] == "在读"

    # 全部读完 → 已读
    client_authed.put(f"/api/progress/{epub_file['id']}", json={"locator": {"cfi": "end"}, "percent": 100})
    detail = client_authed.get(f"/api/packages/{pkg['id']}").json()
    assert detail["status"] == "已读"

    # 手动改状态已取消：PATCH status 被忽略（字段已从模型移除），状态只由进度推导
    client_authed.patch(f"/api/packages/{pkg['id']}", json={"status": "未读"})
    detail = client_authed.get(f"/api/packages/{pkg['id']}").json()
    assert detail["status"] == "已读"
    # 进度回写一半 → 又变在读
    client_authed.put(f"/api/progress/{epub_file['id']}", json={"locator": {}, "percent": 50})
    detail = client_authed.get(f"/api/packages/{pkg['id']}").json()
    assert detail["status"] == "在读"


def make_zip(path: Path) -> None:
    """内容不解析（未知格式仅登记），任意字节即可。"""
    path.write_bytes(b"PK-fake-archive-bytes")


def test_unreadable_format_is_neutral(client_authed: TestClient, tmp_path: Path):
    """zip 等无阅读深度格式不参与状态聚合：不阻塞已读；纯不可读包为中性（空串）。"""
    pkg = commit_package(
        client_authed, tmp_path,
        [("三体.epub", make_epub, None), ("项目归档.zip", make_zip, None)],
        meta_overrides={"title": "带附件的书", "publish_date": "2008"},
        seq_base=1,
    )
    epub_file = next(f for f in pkg["files"] if f["format"] == "epub")
    detail = client_authed.get(f"/api/packages/{pkg['id']}").json()
    assert detail["status"] == "未读"

    # epub 读完即已读——zip 无进度也不会拖住
    client_authed.put(f"/api/progress/{epub_file['id']}", json={"locator": {}, "percent": 100})
    detail = client_authed.get(f"/api/packages/{pkg['id']}").json()
    assert detail["status"] == "已读"

    # 纯不可读格式包 → 中性
    pure = commit_package(
        client_authed, tmp_path,
        [("备份.zip", make_zip, None)],
        meta_overrides={"title": "纯归档包", "publish_date": "2024"},
        seq_base=5,
    )
    detail = client_authed.get(f"/api/packages/{pure['id']}").json()
    assert detail["status"] == ""


def test_add_remove_file_recomputes_status(client_authed: TestClient, tmp_path: Path):
    """包内文件增删改变"全部读完"口径，需触发重算。"""
    pkg = commit_package(
        client_authed, tmp_path,
        [("笔记.txt", make_txt, None)],
        meta_overrides={"title": "一篇笔记"},
        seq_base=1,
    )
    txt = pkg["files"][0]
    client_authed.put(f"/api/progress/{txt['id']}", json={"locator": {}, "percent": 100})
    assert client_authed.get(f"/api/packages/{pkg['id']}").json()["status"] == "已读"

    # 给已读包补一个未读文件 → 未读
    extra = stage(client_authed, tmp_path, "访谈录屏.mp4", make_media, seq=9)
    resp = client_authed.post(f"/api/packages/{pkg['id']}/files", json={"stage_id": extra["stage_id"]})
    assert resp.status_code == 201
    assert client_authed.get(f"/api/packages/{pkg['id']}").json()["status"] == "未读"

    # 移除该未读文件 → 回到已读
    new_file = next(f for f in client_authed.get(f"/api/packages/{pkg['id']}").json()["files"] if f["format"] == "mp4")
    resp = client_authed.delete(f"/api/packages/{pkg['id']}/files/{new_file['id']}")
    assert resp.status_code == 200
    assert client_authed.get(f"/api/packages/{pkg['id']}").json()["status"] == "已读"


def test_progress_unknown_file_and_validation(client_authed: TestClient, tmp_path: Path):
    assert client_authed.get("/api/progress/999").status_code == 404
    assert client_authed.put("/api/progress/999", json={"locator": {}, "percent": 0}).status_code == 404
    pkg = commit_package(client_authed, tmp_path, [("笔记.txt", make_txt, None)], seq_base=1)
    resp = client_authed.put(
        f"/api/progress/{pkg['files'][0]['id']}", json={"locator": {}, "percent": 150}
    )
    assert resp.status_code == 422
