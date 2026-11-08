/** 封面与书脊贴图生成（sharp + SVG；自 Python Pillow 版平移的配色/布局逻辑）。
 *
 * 存量 PNG 照旧伺服；新生成的封面/书脊由本模块产出——配色公式逐行平移（确定性一致），
 * 文字排布用 SVG 系统字体渲染（与 Pillow 的 textbbox 存在毫米级排布差异，视觉等价）。 */
import { createHash } from "node:crypto";
import sharp from "sharp";

export const SPINE_W = 64;
export const SPINE_H = 768;
export const COVER_W = 480;
export const COVER_H = 680;

const FONT_STACK = "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',SimHei,sans-serif";

export interface Palette {
  bg: readonly [number, number, number];
  fg: readonly [number, number, number];
  band: readonly [number, number, number];
}

const clamp = (v: number) => Math.max(0, Math.min(255, v));
const mix = (c: readonly [number, number, number], other: readonly [number, number, number], ratio: number) =>
  [clamp(Math.round(c[0] + (other[0] - c[0]) * ratio)), clamp(Math.round(c[1] + (other[1] - c[1]) * ratio)), clamp(Math.round(c[2] + (other[2] - c[2]) * ratio))] as [number, number, number];
const luminance = (c: readonly [number, number, number]) =>
  (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

/** Python colorsys.hls_to_rgb 等价实现。 */
function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/** 从封面取主色（24×24 量化桶）；无封面则用书名 md5 散列取一个柔和色相（与 Python 确定性一致）。 */
export async function paletteFromCover(cover: Buffer | null, seed: string): Promise<Palette> {
  let bg: [number, number, number];
  if (cover !== null) {
    const { data } = await sharp(cover)
      .removeAlpha()
      .resize(24, 24, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    // 4bit/通道量化桶 → 按出现次数排序
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      cur.n += 1;
      cur.r += r;
      cur.g += g;
      cur.b += b;
      buckets.set(key, cur);
    }
    const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
    let base: [number, number, number] | null = null;
    for (const bucket of sorted) {
      const c: [number, number, number] = [
        Math.round(bucket.r / bucket.n),
        Math.round(bucket.g / bucket.n),
        Math.round(bucket.b / bucket.n),
      ];
      if (0.12 < luminance(c) && luminance(c) < 0.92) {
        base = c; // 跳过过暗/过亮
        break;
      }
    }
    if (base === null) base = sorted[0] ? ([
      Math.round(sorted[0].r / sorted[0].n),
      Math.round(sorted[0].g / sorted[0].n),
      Math.round(sorted[0].b / sorted[0].n),
    ] as [number, number, number]) : [96, 96, 96];
    bg = mix(base, [30, 26, 22], 0.25);
  } else {
    const digest = createHash("md5").update(seed, "utf-8").digest();
    const hue = digest[0]! / 255;
    const sat = 0.38 + (digest[1]! / 255) * 0.2;
    const light = 0.32 + (digest[2]! / 255) * 0.14;
    const [r, g, b] = hlsToRgb(hue, light, sat);
    bg = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  const fg: [number, number, number] = luminance(bg) < 0.55 ? [250, 248, 244] : [34, 30, 26];
  const band = mix(bg, [0, 0, 0], 0.35);
  return { bg, fg, band };
}

const rgb = (c: readonly [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** 占位封面：主色底 + 上下色带 + 首字。 */
export async function makePlaceholderCover(title: string, palette: Palette): Promise<Buffer> {
  const initial = ((title || "?").trim()[0] ?? "?").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_W}" height="${COVER_H}">
  <rect width="${COVER_W}" height="${COVER_H}" fill="${rgb(palette.bg)}"/>
  <rect x="0" y="0" width="${COVER_W}" height="27" fill="${rgb(palette.band)}"/>
  <rect x="0" y="${COVER_H - 27}" width="${COVER_W}" height="27" fill="${rgb(palette.band)}"/>
  <text x="${COVER_W / 2}" y="${COVER_H / 2}" text-anchor="middle" dominant-baseline="central"
        font-family="${FONT_STACK}" font-weight="bold" font-size="220" fill="${rgb(palette.fg)}">${esc(initial)}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 统一封面：有则缩放裁剪到 COVER 尺寸，无则占位封面。 */
export async function normalizeCover(cover: Buffer | null, title: string): Promise<Buffer> {
  if (cover === null) return makePlaceholderCover(title, await paletteFromCover(null, title));
  return sharp(cover)
    .removeAlpha()
    .resize(COVER_W, COVER_H, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}

const isCjkChar = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (0x4e00 <= code && code <= 0x9fff) ||
    (0x3400 <= code && code <= 0x4dbf) ||
    (0xf900 <= code && code <= 0xfaff) ||
    (0x3000 <= code && code <= 0x303f) ||
    (0xff00 <= code && code <= 0xffef)
  );
};

/** 书脊贴图：竖排书名，CJK 逐字竖排，拉丁词组旋转 90°（SVG 系统字体渲染）。 */
export async function makeSpine(title: string, palette: Palette, height = SPINE_H): Promise<Buffer> {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SPINE_W}" height="${height}">`,
    `<rect width="${SPINE_W}" height="${height}" fill="${rgb(palette.bg)}"/>`,
  ];
  const bandH = 18;
  parts.push(`<rect x="0" y="0" width="${SPINE_W}" height="${bandH}" fill="${rgb(palette.band)}"/>`);
  parts.push(`<rect x="0" y="${height - bandH}" width="${SPINE_W}" height="${bandH}" fill="${rgb(palette.band)}"/>`);

  const text = (title ?? "").trim().replace(/\n/g, " ");
  if (text) {
    // 按字符分块：CJK 单字（含中文标点）/ 连续拉丁（含数字、空格）为一组
    const runs: Array<[string, boolean]> = [];
    for (const ch of text) {
      const cjk = isCjkChar(ch) || "·—－、。，；：？！“”‘’（）".includes(ch);
      const last = runs[runs.length - 1];
      if (last && last[1] === cjk) last[0] += ch;
      else runs.push([ch, cjk]);
    }

    // 自适应字号：CJK 字高≈size*1.05+6/字，拉丁词宽≈size*0.62/字符+14/词（估算法）
    const available = height - bandH * 2 - 40;
    let size = 34;
    const estimate = (s: number) => {
      let total = 0;
      for (const [runText, cjk] of runs) {
        if (cjk) total += [...runText].reduce((acc) => acc + s * 1.05 + 6, 0);
        else total += s * 0.62 * runText.length + 14;
      }
      return total;
    };
    while (size >= 16 && estimate(size) > available) size -= 2;

    let y = Math.ceil((height - available) / 2) + 4;
    const half = SPINE_W / 2;
    for (const [runText, cjk] of runs) {
      if (cjk) {
        for (const ch of runText) {
          const chH = size * 1.05;
          parts.push(
            `<text x="${half}" y="${y + chH * 0.85}" text-anchor="middle" font-family="${FONT_STACK}" font-weight="bold" font-size="${size}" fill="${rgb(palette.fg)}">${esc(ch)}</text>`,
          );
          y += chH + 6;
        }
      } else {
        const word = runText.trim();
        if (!word) {
          y += Math.floor(size / 2);
          continue;
        }
        const wWord = size * 0.62 * word.length;
        if (wWord > SPINE_W - 10) {
          // 太宽的词直接截断为单字符竖排
          for (const ch of word) {
            parts.push(
              `<text x="${half}" y="${y + size * 0.9}" text-anchor="middle" font-family="${FONT_STACK}" font-weight="bold" font-size="${size}" fill="${rgb(palette.fg)}">${esc(ch)}</text>`,
            );
            y += size * 1.05 + 6;
          }
          continue;
        }
        // 旋转 -90°：词宽变成竖直占位
        parts.push(
          `<text x="${half}" y="${y + wWord * 0.85}" text-anchor="middle" transform="rotate(-90 ${half} ${y})" font-family="${FONT_STACK}" font-weight="bold" font-size="${size}" fill="${rgb(palette.fg)}">${esc(word)}</text>`,
        );
        y += wWord + 6;
      }
    }
  }
  parts.push("</svg>");
  return sharp(Buffer.from(parts.join(""))).png().toBuffer();
}

/** 生成（或重生成）包的封面+书脊 PNG。
 * 封面只在「来了新真封面」或「封面文件缺失（补占位）」时写入——重编码会造成字节漂移，
 * 偏离 cover_sha256 登记哈希，破坏同步取回校验；书脊（含标题）每次重生成。 */
export async function regeneratePackageArt(
  artDir: string,
  packageId: number,
  title: string,
  coverBuffer: Buffer | null,
): Promise<void> {
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const coverPath = `${artDir}/covers/${packageId}.png`;
  if (coverBuffer !== null || !existsSync(coverPath)) {
    const cover = await normalizeCover(coverBuffer, title);
    mkdirSync(`${artDir}/covers`, { recursive: true });
    writeFileSync(coverPath, cover);
  }
  const palette = await paletteFromCover(readFileSync(coverPath), title);
  mkdirSync(`${artDir}/spines`, { recursive: true });
  writeFileSync(`${artDir}/spines/${packageId}.png`, await makeSpine(title, palette));
}
