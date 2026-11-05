"""入库元数据抽取：按格式从文件中抽取标题/作者/时间/页数/封面。"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import Path

import chardet
from bs4 import BeautifulSoup
from PIL import Image

from ..schemas import canonical_date_str

# 已知格式：可抽取元数据/封面（_EXTRACTORS 有对应提取器），媒体类可原生播放
KNOWN_FORMATS = {
    "epub", "pdf", "txt", "md", "html", "docx", "pptx", "xlsx",
    "mp4", "webm", "mov", "m4v", "mkv",  # 视频（原生播放，不转码）
    "mp3", "m4a", "wav", "ogg", "flac",  # 音频
    "jpg", "png", "gif", "webp",         # 图片
}
_EXT_ALIASES = {"htm": "html", "markdown": "md", "mdown": "md", "jpeg": "jpg"}


def detect_format(filename: str) -> str:
    """不限格式：已知格式返回规范名；未知扩展名原样登记（清理为字母数字，≤12 位）；无扩展名记 bin。"""
    ext = Path(filename).suffix.lower().lstrip(".")
    ext = _EXT_ALIASES.get(ext, ext)
    if ext in KNOWN_FORMATS:
        return ext
    cleaned = re.sub(r"[^a-z0-9]", "", ext)[:12]
    return cleaned or "bin"


@dataclass
class ExtractedMeta:
    title: str | None = None
    authors: list[str] = field(default_factory=list)
    publish_date: str | None = None
    publisher: str | None = None
    page_count: int | None = None
    cover: Image.Image | None = None


def _decode_text(raw: bytes) -> str:
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig")
    guess = chardet.detect(raw[:65536])
    encoding = guess.get("encoding") or "utf-8"
    try:
        text = raw.decode(encoding)
    except (LookupError, UnicodeDecodeError):
        text = raw.decode("utf-8", errors="replace")
    return text


_DATE_PATTERNS = [
    (re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})"), "ymd"),
    (re.compile(r"(\d{4})/(\d{1,2})/(\d{1,2})"), "ymd"),
    (re.compile(r"(\d{4})-(\d{1,2})(?![-\d])"), "ym"),
    (re.compile(r"(\d{4})(?![-\d])"), "y"),
]


def parse_loose_date(value: str | None) -> str | None:
    """从文件元数据宽松抽取日期 → 规范文本（公元前在此不指望出现，统一公元）。"""
    if not value:
        return None
    value = str(value).strip()
    for pattern, kind in _DATE_PATTERNS:
        m = pattern.search(value)
        if not m:
            continue
        try:
            if kind == "ymd":
                y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
                if not (1 <= mo <= 12 and 1 <= d <= 31):
                    continue
                return canonical_date_str(y, mo, d)
            if kind == "ym":
                y, mo = int(m.group(1)), int(m.group(2))
                if not 1 <= mo <= 12:
                    continue
                return canonical_date_str(y, mo, 1)
            return canonical_date_str(int(m.group(1)), 1, 1)
        except ValueError:
            continue
    return None


def _stem_title(filename: str) -> str:
    stem = Path(filename).stem.strip()
    return re.sub(r"[_]+", " ", stem) or Path(filename).name


# ---------- 各格式抽取 ----------

def extract_epub(path: Path, filename: str) -> ExtractedMeta:
    from ebooklib import epub

    meta = ExtractedMeta()
    try:
        book = epub.read_epub(str(path), options={"ignore_ncx": True})
    except Exception:
        return ExtractedMeta(title=_stem_title(filename))
    meta.title = (book.get_metadata("DC", "title") or [[None]])[0][0]
    if isinstance(meta.title, (list, tuple)):
        meta.title = meta.title[0]
    creators = book.get_metadata("DC", "creator") or []
    meta.authors = [c[0] for c in creators if c and c[0]]
    raw_date = (book.get_metadata("DC", "date") or [[None]])[0][0]
    meta.publish_date = parse_loose_date(raw_date if isinstance(raw_date, str) else None)
    meta.publisher = (book.get_metadata("DC", "publisher") or [[None]])[0][0]
    if not isinstance(meta.publisher, str):
        meta.publisher = None
    if not meta.title:
        meta.title = _stem_title(filename)

    for item in book.get_items():
        try:
            # ebooklib 的 set_cover 产生 EpubCover/EpubCoverImg；EPUB3 通用约定是 cover-image 属性
            props = item.get_properties() if hasattr(item, "get_properties") else ()
            if "cover-image" not in (props or ()) and "Cover" not in type(item).__name__:
                continue
            img = Image.open(io.BytesIO(item.get_content()))
            img.load()
            meta.cover = img
            break
        except Exception:
            continue
    return meta


def extract_pdf(path: Path, filename: str) -> ExtractedMeta:
    import pypdfium2 as pdfium

    meta = ExtractedMeta(title=_stem_title(filename))
    try:
        doc = pdfium.PdfDocument(str(path))
    except Exception:
        return meta
    meta.page_count = len(doc)
    try:
        title = doc.get_metadata_value("Title")
        if title and title.strip():
            meta.title = title.strip()
        author = doc.get_metadata_value("Author")
        if author and author.strip():
            meta.authors = [author.strip()]
    except Exception:
        pass
    try:
        page = doc[0]
        bitmap = page.render(scale=1.6)
        meta.cover = bitmap.to_pil()
    except Exception:
        pass
    finally:
        try:
            doc.close()
        except Exception:
            pass
    return meta


def extract_txt(path: Path, filename: str) -> ExtractedMeta:
    raw = path.read_bytes()
    text = _decode_text(raw)
    meta = ExtractedMeta(title=_stem_title(filename))
    for line in text.splitlines()[:30]:
        line = line.strip()
        if line and not re.match(r"^[\s\-=_#*·—•]+$", line):
            meta.title = line[:200]
            break
    meta.page_count = max(1, len(text) // 1200)  # 估算
    return meta


def extract_md(path: Path, filename: str) -> ExtractedMeta:
    text = _decode_text(path.read_bytes())
    meta = ExtractedMeta(title=_stem_title(filename))
    m = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    if m:
        meta.title = m.group(1).strip()[:200]
    meta.page_count = max(1, len(text) // 1200)
    return meta


def extract_html(path: Path, filename: str) -> ExtractedMeta:
    text = _decode_text(path.read_bytes())
    meta = ExtractedMeta(title=_stem_title(filename))
    soup = BeautifulSoup(text, "lxml")
    if soup.title and soup.title.get_text(strip=True):
        meta.title = soup.title.get_text(strip=True)[:200]
    meta.page_count = max(1, len(text) // 2500)
    return meta


def extract_docx(path: Path, filename: str) -> ExtractedMeta:
    from docx import Document

    meta = ExtractedMeta(title=_stem_title(filename))
    try:
        doc = Document(str(path))
        props = doc.core_properties
        if props.title and props.title.strip():
            meta.title = props.title.strip()
        if props.author and props.author.strip():
            meta.authors = [props.author.strip()]
        meta.publish_date = parse_loose_date(
            props.created.strftime("%Y-%m-%d") if props.created else None
        )
    except Exception:
        pass
    return meta


def extract_pptx(path: Path, filename: str) -> ExtractedMeta:
    from pptx import Presentation

    meta = ExtractedMeta(title=_stem_title(filename))
    try:
        prs = Presentation(str(path))
        props = prs.core_properties
        if props.title and props.title.strip():
            meta.title = props.title.strip()
        elif prs.slides:
            for shape in prs.slides[0].shapes:
                if shape.has_text_frame and shape.text_frame.text.strip():
                    meta.title = shape.text_frame.text.strip().splitlines()[0][:200]
                    break
        if props.author and props.author.strip():
            meta.authors = [props.author.strip()]
        meta.page_count = len(prs.slides)
        meta.publish_date = parse_loose_date(
            props.created.strftime("%Y-%m-%d") if props.created else None
        )
    except Exception:
        pass
    return meta


def extract_xlsx(path: Path, filename: str) -> ExtractedMeta:
    from openpyxl import load_workbook

    meta = ExtractedMeta(title=_stem_title(filename))
    try:
        wb = load_workbook(str(path), read_only=True)
        if wb.properties and wb.properties.title:
            meta.title = str(wb.properties.title)
        meta.page_count = len(wb.sheetnames)
    except Exception:
        pass
    return meta


def extract_media(path: Path, filename: str) -> ExtractedMeta:
    """视频/音频：不做内容解析，名称取文件名。"""
    return ExtractedMeta(title=_stem_title(filename))


def extract_image(path: Path, filename: str) -> ExtractedMeta:
    """图片：封面即图片自身。"""
    meta = ExtractedMeta(title=_stem_title(filename))
    try:
        meta.cover = Image.open(path)
        meta.cover.load()
    except Exception:
        pass
    return meta


_EXTRACTORS = {
    "epub": extract_epub,
    "pdf": extract_pdf,
    "txt": extract_txt,
    "md": extract_md,
    "html": extract_html,
    "docx": extract_docx,
    "pptx": extract_pptx,
    "xlsx": extract_xlsx,
    "mp4": extract_media,
    "webm": extract_media,
    "mov": extract_media,
    "m4v": extract_media,
    "mkv": extract_media,
    "mp3": extract_media,
    "m4a": extract_media,
    "wav": extract_media,
    "ogg": extract_media,
    "flac": extract_media,
    "jpg": extract_image,
    "png": extract_image,
    "gif": extract_image,
    "webp": extract_image,
}


def extract_meta(path: Path, filename: str, fmt: str) -> ExtractedMeta:
    extractor = _EXTRACTORS.get(fmt)
    if extractor is None:
        return ExtractedMeta(title=_stem_title(filename))
    try:
        return extractor(path, filename)
    except Exception:
        return ExtractedMeta(title=_stem_title(filename))
