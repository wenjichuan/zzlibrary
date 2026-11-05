"""测试夹具：独立临时数据目录的 app 实例 + 样例文件构造。"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

USERNAME = "admin"
PASSWORD = "test1234"


@pytest.fixture()
def app_settings(tmp_path):
    return Settings(
        data_dir=tmp_path / "data",
        username=USERNAME,
        password=PASSWORD,
        session_secret="unit-test-secret",
        cors_origins="",
    )


@pytest.fixture()
def client(app_settings):
    app = create_app(app_settings)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def client_authed(client):
    resp = client.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD})
    assert resp.status_code == 200
    return client


# ---------- 样例文件构造 ----------

def solid_png(color=(120, 60, 40), size=(200, 300)) -> bytes:
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_epub(path: Path, title: str = "三体", author: str = "刘慈欣", date: str | None = "2008-01-01") -> None:
    from ebooklib import epub

    book = epub.EpubBook()
    book.set_identifier("test-book-1")
    book.set_title(title)
    book.add_author(author)
    book.set_language("zh")
    if date:
        book.add_metadata("DC", "date", date)
    book.set_cover("cover.png", solid_png())
    chapter = epub.EpubHtml(title="第一章", file_name="chap1.xhtml", lang="zh")
    chapter.content = "<html><body><h1>第一章</h1><p>黑暗森林。</p></body></html>"
    book.add_item(chapter)
    book.toc = [chapter]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", chapter]
    epub.write_epub(str(path), book)


def make_pdf(path: Path, pages: int = 3) -> None:
    imgs = [Image.new("RGB", (300, 420), (200, 200, 200)) for _ in range(pages)]
    imgs[0].save(str(path), "PDF", save_all=True, append_images=imgs[1:])


def make_txt(path: Path, text: str = "第一章 你好\n正文内容" * 50, encoding: str = "utf-8") -> None:
    path.write_bytes(text.encode(encoding))


def make_image(path: Path, color=(60, 120, 180)) -> None:
    fmt = {"jpg": "JPEG"}.get(path.suffix.lstrip(".").lower(), path.suffix.lstrip(".").upper())
    Image.new("RGB", (400, 300), color).save(path, format=fmt)


def make_media(path: Path) -> None:
    """视频/音频不做内容解析，任意字节即可。"""
    path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)


# ---------- 业务种子 ----------

def seed_categories(client: TestClient) -> dict:
    """建一棵 分类树：技术/文学 -> 编程/小说 -> Python/科幻。"""
    out = {}
    resp = client.post("/api/categories", json={"name": "技术"})
    out["l1a"] = resp.json()["id"]
    resp = client.post("/api/categories", json={"name": "编程", "parent_id": out["l1a"]})
    out["l2a"] = resp.json()["id"]
    resp = client.post("/api/categories", json={"name": "Python", "parent_id": out["l2a"]})
    out["l3a"] = resp.json()["id"]
    resp = client.post("/api/categories", json={"name": "文学"})
    out["l1b"] = resp.json()["id"]
    resp = client.post("/api/categories", json={"name": "小说", "parent_id": out["l1b"]})
    out["l2b"] = resp.json()["id"]
    return out


def stage(client: TestClient, tmp_path: Path, filename: str, maker, seq: int = 0) -> dict:
    """上传暂存一个文件，返回 StageOut JSON。"""
    file_path = tmp_path / f"f{seq}_{filename}"
    maker(file_path)
    with open(file_path, "rb") as f:
        resp = client.post(
            "/api/packages/stage",
            files={"file": (filename, f, "application/octet-stream")},
        )
    assert resp.status_code == 200, resp.text
    return resp.json()


def commit_package(
    client: TestClient,
    tmp_path: Path,
    files: list[tuple[str, object, dict | None]],  # (filename, maker, meta_overrides)
    meta_overrides: dict | None = None,
    seq_base: int = 0,
) -> dict:
    """把一组文件组成一个资料包入库，返回 PackageDetail JSON。

    meta_overrides 支持 classifications=[{"l1_id":..,"l2_id":..,"l3_id":..}, ...] 多路径。
    """
    stage_ids = []
    staged_meta = []
    for i, (filename, maker, _f) in enumerate(files):
        staged = stage(client, tmp_path, filename, maker, seq=seq_base + i)
        stage_ids.append(staged["stage_id"])
        staged_meta.append(staged["meta"])

    first = staged_meta[0]
    default_title = first["title"] or filename_stem(files[0][0])
    if len(files) > 1:
        default_title = ""
    meta = {
        "title": default_title,
        "authors": first["authors"],
        "publish_date": first["publish_date"],
        "publisher": first["publisher"],
        "tags": [],
        "notes": None,
        "classifications": [],
    }
    meta.update(meta_overrides or {})
    if not meta["title"]:
        meta["title"] = "未命名资料包"
    if meta["publish_date"] is None:
        meta["publish_date"] = ""
    resp = client.post(
        "/api/packages",
        json={"stage_ids": stage_ids, "meta": meta},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def path(l1: int | None = None, l2: int | None = None, l3: int | None = None) -> dict:
    return {"l1_id": l1, "l2_id": l2, "l3_id": l3}


def filename_stem(name: str) -> str:
    return Path(name).stem
