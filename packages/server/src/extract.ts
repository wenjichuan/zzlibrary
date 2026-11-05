/** 入库元数据抽取（Node 版）：按格式从文件中抽取标题/作者/时间/页数/封面。
 *
 * epub/Office = zip+XML 解析（fflate）；txt 用 jschardet 探测编码；
 * PDF 元数据走原始字节正则（CP0 不渲染首页封面 → 占位封面，CP1 再上 pdfjs）。
 * 所有抽取器失败均回退文件名主干（与 Python 行为一致）。 */
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import jschardet from "jschardet";
import { parseLooseDate, stemTitle } from "@zzlibrary/core";

export interface ExtractedMeta {
  title: string | null;
  authors: string[];
  publish_date: string | null;
  publisher: string | null;
  page_count: number | null;
  /** 封面图原始字节（epub 内置封面 / 图片本体）；无则 null */
  cover: Buffer | null;
}

const fallback = (filename: string): ExtractedMeta => ({
  title: stemTitle(filename),
  authors: [],
  publish_date: null,
  publisher: null,
  page_count: null,
  cover: null,
});

/** 文本解码：BOM 优先，再 jschardet 探测（GBK 等全量 ICU 支持），失败回退 UTF-8 替换。 */
export function decodeText(raw: Buffer): string {
  if (raw.subarray(0, 3).toString("hex") === "efbbbf") {
    return raw.subarray(3).toString("utf-8");
  }
  try {
    const guess = jschardet.detect(raw.subarray(0, 65536));
    const encoding = (guess?.encoding ?? "UTF-8").toLowerCase();
    const label = encoding === "ascii" ? "utf-8" : encoding;
    return new TextDecoder(label, { fatal: true }).decode(raw);
  } catch {
    return raw.toString("utf-8");
  }
}

// ---------- epub ----------

function xmlText(xml: string, tag: string): string | null {
  // dc:title 等（可带命名空间前缀差异）
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!m) return null;
  return m[1]!
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim() || null;
}

function extractEpub(buffer: Buffer, filename: string): ExtractedMeta {
  try {
    const files = unzipSync(buffer);
    const containerFile = files["META-INF/container.xml"];
    if (!containerFile) return fallback(filename);
    const container = new TextDecoder().decode(containerFile);
    const rootfileM = /<rootfile[^>]+full-path="([^"]+)"/.exec(container);
    if (!rootfileM) return fallback(filename);
    const opfPath = rootfileM[1]!;
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
    const opfFile = files[opfPath];
    if (!opfFile) return fallback(filename);
    const opf = new TextDecoder().decode(opfFile);

    const meta = fallback(filename);
    meta.title = xmlText(opf, "dc:title") ?? meta.title;
    const creators = [...opf.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)]
      .map((m) => m[1]!.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);
    meta.authors = creators;
    const rawDate = xmlText(opf, "dc:date");
    meta.publish_date = rawDate !== null ? parseLooseDate(rawDate) : null;
    meta.publisher = xmlText(opf, "dc:publisher");

    // 封面：EPUB3 cover-image 属性优先，其次 id 含 cover 的图片项
    let href: string | null = null;
    const propM = /<item[^>]+properties="[^"]*cover-image[^"]*"[^>]*>/i.exec(opf) ??
      /<item[^>]+(?:id="[^"]*cover[^"]*")[^>]*media-type="image\/[^"]*"[^>]*>/i.exec(opf);
    const anyItem = /<item\b[^>]*>/gi;
    if (propM) {
      href = /href="([^"]+)"/i.exec(propM[0])?.[1] ?? null;
    } else {
      for (const item of opf.match(anyItem) ?? []) {
        const isImage = /media-type="image\//i.test(item);
        const id = /id="([^"]+)"/i.exec(item)?.[1] ?? "";
        if (isImage && /cover/i.test(id)) {
          href = /href="([^"]+)"/i.exec(item)?.[1] ?? null;
          break;
        }
      }
    }
    if (href) {
      const coverPath = decodeURIComponent(opfDir + href).replace(/^\.?\//, "");
      const coverFile = files[coverPath] ?? files[decodeURIComponent(href)];
      if (coverFile) meta.cover = Buffer.from(coverFile);
    }
    return meta;
  } catch {
    return fallback(filename);
  }
}

// ---------- pdf（CP0：元数据正则；不渲染首页） ----------

function extractPdf(buffer: Buffer, filename: string): ExtractedMeta {
  const meta = fallback(filename);
  try {
    const text = buffer.toString("latin1");
    const pages = text.match(/\/Type\s*\/Page(?![s])/g);
    meta.page_count = pages ? pages.length : null;
    const titleM = /\/Title\s*\(([^)]*)\)/.exec(text) ?? /\/Title\s*<([0-9A-Fa-f\s]+)>/.exec(text);
    if (titleM) {
      let title = titleM[1]!;
      if (/^[0-9A-Fa-f\s]+$/.test(title) && title.includes(" ") === false) {
        title = Buffer.from(title.replaceAll(" ", ""), "hex").toString("utf-8");
      }
      if (title.trim()) meta.title = title.trim();
    }
    const authorM = /\/Author\s*\(([^)]*)\)/.exec(text);
    if (authorM && authorM[1]!.trim()) meta.authors = [authorM[1]!.trim()];
  } catch {
    /* 回退 */
  }
  return meta;
}

// ---------- 纯文本族 ----------

function extractTxt(path: string, filename: string): ExtractedMeta {
  const text = decodeText(readFileSync(path));
  const meta = fallback(filename);
  for (const line of text.split(/\r?\n/).slice(0, 30)) {
    const t = line.trim();
    if (t && !/^[\s\-=_#*·—•]+$/.test(t)) {
      meta.title = t.slice(0, 200);
      break;
    }
  }
  meta.page_count = Math.max(1, Math.floor(text.length / 1200)); // 估算
  return meta;
}

function extractMd(path: string, filename: string): ExtractedMeta {
  const text = decodeText(readFileSync(path));
  const meta = fallback(filename);
  const m = /^#\s+(.+)$/m.exec(text);
  if (m) meta.title = m[1]!.trim().slice(0, 200);
  meta.page_count = Math.max(1, Math.floor(text.length / 1200));
  return meta;
}

function extractHtml(path: string, filename: string): ExtractedMeta {
  const text = decodeText(readFileSync(path));
  const meta = fallback(filename);
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (m && m[1]!.trim()) meta.title = m[1]!.trim().slice(0, 200);
  meta.page_count = Math.max(1, Math.floor(text.length / 2500));
  return meta;
}

// ---------- Office（zip + core.xml） ----------

function coreProps(buffer: Buffer): { title: string | null; creator: string | null; created: string | null } {
  try {
    const files = unzipSync(buffer);
    const core = files["docProps/core.xml"];
    if (!core) return { title: null, creator: null, created: null };
    const xml = new TextDecoder().decode(core);
    return {
      title: xmlText(xml, "dc:title"),
      creator: xmlText(xml, "dc:creator"),
      created: xmlText(xml, "dcterms:created") ?? xmlText(xml, "cp:created"),
    };
  } catch {
    return { title: null, creator: null, created: null };
  }
}

function extractDocx(path: string, filename: string): ExtractedMeta {
  const meta = fallback(filename);
  try {
    const props = coreProps(readFileSync(path));
    if (props.title) meta.title = props.title;
    if (props.creator) meta.authors = [props.creator];
    meta.publish_date = parseLooseDate(props.created);
  } catch { /* 回退 */ }
  return meta;
}

function extractPptx(path: string, filename: string): ExtractedMeta {
  const meta = fallback(filename);
  try {
    const buffer = readFileSync(path);
    const props = coreProps(buffer);
    if (props.title) meta.title = props.title;
    else {
      const files = unzipSync(buffer);
      const slideKey = Object.keys(files)
        .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
      if (slideKey) {
        const xml = new TextDecoder().decode(files[slideKey]!);
        const m = /<a:t>([^<]+)<\/a:t>/.exec(xml);
        if (m && m[1]!.trim()) meta.title = m[1]!.trim().split(/\r?\n/)[0]!.slice(0, 200);
      }
    }
    if (props.creator) meta.authors = [props.creator];
    meta.publish_date = parseLooseDate(props.created);
    const n = Object.keys(unzipSync(buffer)).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).length;
    meta.page_count = n;
  } catch { /* 回退 */ }
  return meta;
}

function extractXlsx(path: string, filename: string): ExtractedMeta {
  const meta = fallback(filename);
  try {
    const buffer = readFileSync(path);
    const props = coreProps(buffer);
    if (props.title) meta.title = props.title;
    const files = unzipSync(buffer);
    const workbook = files["xl/workbook.xml"];
    if (workbook) meta.page_count = (new TextDecoder().decode(workbook).match(/<sheet\b/g) ?? []).length;
  } catch { /* 回退 */ }
  return meta;
}

const extractMedia = (_path: string, filename: string): ExtractedMeta => fallback(filename);

function extractImage(path: string, filename: string): ExtractedMeta {
  const meta = fallback(filename);
  try {
    meta.cover = readFileSync(path); // 封面即图片自身（统一管线里再裁剪）
  } catch { /* 回退 */ }
  return meta;
}

/** 按格式抽取（读文件）。所有失败回退文件名主干。 */
export function extractMeta(path: string, buffer: Buffer, filename: string, fmt: string): ExtractedMeta {
  try {
    switch (fmt) {
      case "epub":
        return extractEpub(buffer, filename);
      case "pdf":
        return extractPdf(buffer, filename);
      case "txt":
        return extractTxt(path, filename);
      case "md":
        return extractMd(path, filename);
      case "html":
        return extractHtml(path, filename);
      case "docx":
        return extractDocx(path, filename);
      case "pptx":
        return extractPptx(path, filename);
      case "xlsx":
        return extractXlsx(path, filename);
      case "jpg":
      case "png":
      case "gif":
      case "webp":
        return extractImage(path, filename);
      default:
        if (["mp4", "webm", "mov", "m4v", "mkv", "mp3", "m4a", "wav", "ogg", "flac"].includes(fmt)) {
          return extractMedia(path, filename);
        }
        return fallback(filename);
    }
  } catch {
    return fallback(filename);
  }
}
