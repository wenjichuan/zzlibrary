"""封面与书脊贴图生成（Pillow）。

- 封面：EPUB 内置封面 / PDF 首页渲染；无封面则生成「主色 + 首字」占位封面
- 书脊：竖排书名 + 封面主色底，预渲染为 PNG（Web 与 App 直接作为纹理加载）
"""
from __future__ import annotations

import colorsys
import hashlib
import io
import os
from dataclasses import dataclass
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

SPINE_W, SPINE_H = 64, 768
COVER_W, COVER_H = 480, 680

_FONT_CANDIDATES = [
    "msyh.ttc",
    "msyhbd.ttc",
    "simhei.ttf",
    "simsun.ttc",
    "segoeui.ttf",
    "DejaVuSans.ttf",
]


@lru_cache(maxsize=1)
def _font_dirs() -> list[str]:
    dirs = []
    windir = os.environ.get("WINDIR") or r"C:\Windows"
    dirs.append(os.path.join(windir, "Fonts"))
    # Linux (WSL) 备选
    dirs += ["/usr/share/fonts", "/usr/local/share/fonts", os.path.expanduser("~/.fonts")]
    return dirs


@lru_cache(maxsize=8)
def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = (["msyhbd.ttc", "simhei.ttf"] if bold else []) + _FONT_CANDIDATES
    for directory in _font_dirs():
        for name in names:
            path = os.path.join(directory, name)
            if os.path.exists(path):
                try:
                    return ImageFont.truetype(path, size)
                except OSError:
                    continue
    return ImageFont.load_default()


@dataclass
class Palette:
    """书脊/占位封面的配色。"""

    bg: tuple[int, int, int]
    fg: tuple[int, int, int]
    band: tuple[int, int, int]


def _clamp(v: int) -> int:
    return max(0, min(255, v))


def _mix(c: tuple[int, int, int], other: tuple[int, int, int], ratio: float) -> tuple[int, int, int]:
    return tuple(_clamp(round(a + (b - a) * ratio)) for a, b in zip(c, other))  # type: ignore[return-value]


def _luminance(c: tuple[int, int, int]) -> float:
    return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255


def palette_from_cover(cover: Image.Image | None, seed: str) -> Palette:
    """从封面取主色；无封面则用书名散列取一个柔和色相。"""
    if cover is not None:
        small = cover.convert("RGB").resize((24, 24))
        q = small.quantize(colors=6)
        counts = sorted(q.getcolors(24 * 24) or [], reverse=True)
        palette_flat = q.getpalette() or []
        for _count, idx in [(c, i) for c, i in counts]:
            base = tuple(palette_flat[idx * 3 : idx * 3 + 3])
            if 0.12 < _luminance(base) < 0.92:  # 跳过过暗/过亮
                break
        else:
            base = tuple(palette_flat[0:3]) if palette_flat else (96, 96, 96)
        bg = _mix(base, (30, 26, 22), 0.25)
    else:
        digest = hashlib.md5(seed.encode("utf-8")).digest()
        hue = digest[0] / 255
        sat = 0.38 + digest[1] / 255 * 0.2
        light = 0.32 + digest[2] / 255 * 0.14
        r, g, b = colorsys.hls_to_rgb(hue, light, sat)
        bg = (round(r * 255), round(g * 255), round(b * 255))
    fg = (250, 248, 244) if _luminance(bg) < 0.55 else (34, 30, 26)
    band = _mix(bg, (0, 0, 0), 0.35)
    return Palette(bg=bg, fg=fg, band=band)


def make_placeholder_cover(title: str, palette: Palette) -> Image.Image:
    img = Image.new("RGB", (COVER_W, COVER_H), palette.bg)
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, COVER_W - 1, 26], fill=palette.band)
    draw.rectangle([0, COVER_H - 26, COVER_W - 1, COVER_H - 1], fill=palette.band)
    initial = (title or "?").strip()[0].upper()
    font = load_font(220, bold=True)
    bbox = draw.textbbox((0, 0), initial, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((COVER_W - w) / 2 - bbox[0], (COVER_H - h) / 2 - bbox[1]),
        initial,
        font=font,
        fill=palette.fg,
    )
    return img


def normalize_cover(cover: Image.Image | None, title: str) -> Image.Image:
    """统一封面：有则缩放裁剪到 COVER 尺寸，无则占位封面。"""
    if cover is None:
        return make_placeholder_cover(title, palette_from_cover(None, title))
    img = cover.convert("RGB")
    scale = max(COVER_W / img.width, COVER_H / img.height)
    img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))))
    left = (img.width - COVER_W) // 2
    top = (img.height - COVER_H) // 2
    return img.crop((left, top, left + COVER_W, top + COVER_H))


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or 0xF900 <= code <= 0xFAFF
        or 0x3000 <= code <= 0x303F
        or 0xFF00 <= code <= 0xFFEF
    )


def make_spine(title: str, palette: Palette, height: int = SPINE_H) -> Image.Image:
    """书脊贴图：竖排书名，CJK 逐字竖排，拉丁词组旋转 90°。"""
    img = Image.new("RGB", (SPINE_W, height), palette.bg)
    draw = ImageDraw.Draw(img)
    band_h = 18
    draw.rectangle([0, 0, SPINE_W - 1, band_h], fill=palette.band)
    draw.rectangle([0, height - band_h, SPINE_W - 1, height - 1], fill=palette.band)

    text = (title or "").strip().replace("\n", " ")
    if not text:
        return img

    # 按字符分块：CJK 单字 / 连续拉丁（含数字、空格）为一组
    runs: list[tuple[str, bool]] = []
    for ch in text:
        cjk = _is_cjk(ch) or ch in "·—－、。，；：？！“”‘’（）"
        if runs and runs[-1][1] == cjk:
            runs[-1][0] += ch
        else:
            runs.append([ch, cjk])

    # 自适应字号：先按 34 号估算总高度，超出可绘制区则缩小
    available = height - band_h * 2 - 40
    size = 34
    while size >= 16:
        font = load_font(size, bold=True)
        total = 0
        for run_text, cjk in runs:
            if cjk:
                total += sum(draw.textbbox((0, 0), ch, font=font)[3] + 6 for ch in run_text)
            else:
                bbox = draw.textbbox((0, 0), run_text, font=font)
                total += (bbox[2] - bbox[0]) + 14
        if total <= available:
            break
        size -= 2
    font = load_font(size, bold=True)

    y = (height - available) // 2 + 4
    for run_text, cjk in runs:
        if cjk:
            for ch in run_text:
                bbox = draw.textbbox((0, 0), ch, font=font)
                ch_h = bbox[3] - bbox[1]
                draw.text(((SPINE_W - (bbox[2] - bbox[0])) / 2 - bbox[0], y - bbox[1]), ch, font=font, fill=palette.fg)
                y += ch_h + 6
        else:
            word = run_text.strip()
            if not word:
                y += size // 2
                continue
            bbox = draw.textbbox((0, 0), word, font=font)
            w_word, h_word = bbox[2] - bbox[0], bbox[3] - bbox[1]
            if w_word > SPINE_W - 10:  # 太宽的词直接截断为单字符竖排
                for ch in word:
                    bbox = draw.textbbox((0, 0), ch, font=font)
                    draw.text(((SPINE_W - (bbox[2] - bbox[0])) / 2 - bbox[0], y - bbox[1]), ch, font=font, fill=palette.fg)
                    y += (bbox[3] - bbox[1]) + 6
                continue
            tile = Image.new("RGBA", (w_word + 8, h_word + 8), (0, 0, 0, 0))
            ImageDraw.Draw(tile).text((4 - bbox[0], 4 - bbox[1]), word, font=font, fill=palette.fg + (255,))
            tile = tile.rotate(-90, expand=True)
            img.paste(tile, ((SPINE_W - tile.width) // 2, y), tile)
            y += tile.height + 6
    return img


def image_bytes(img: Image.Image, fmt: str = "PNG") -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt, optimize=True)
    return buf.getvalue()
