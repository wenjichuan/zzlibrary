/** 文件格式识别与入库纯逻辑（自 Python services/ingest.py 平移的纯函数部分）。 */

/** 单一格式注册表：新格式只需在此加一行——server 的 MIME/抽取分派、web 的阅览/筛选/渲染分派全部由此派生，勿再各建清单。 */
export interface FormatSpec {
  /** 规范名（入库后的 format 值） */
  format: string;
  /** 文件伺服 Content-Type */
  mime: string;
  /** 内容类别（web 阅读器渲染分派） */
  kind: "doc" | "image" | "audio" | "video";
  /** 内置阅读器可打开（=阅览按钮可用=包状态聚合参与）；pptx/xlsx 轻预览未实现暂 false，实现后翻位即可 */
  readable: boolean;
  /** 服务端抽取器可产元数据/封面 */
  extractable: boolean;
}

const REGISTRY: FormatSpec[] = [
  { format: "epub", mime: "application/epub+zip", kind: "doc", readable: true, extractable: true },
  { format: "pdf", mime: "application/pdf", kind: "doc", readable: true, extractable: true },
  { format: "txt", mime: "text/plain; charset=utf-8", kind: "doc", readable: true, extractable: true },
  { format: "md", mime: "text/markdown; charset=utf-8", kind: "doc", readable: true, extractable: true },
  { format: "html", mime: "text/html; charset=utf-8", kind: "doc", readable: true, extractable: true },
  { format: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "doc", readable: true, extractable: true },
  { format: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "doc", readable: false, extractable: true },
  { format: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "doc", readable: false, extractable: true },
  { format: "mp4", mime: "video/mp4", kind: "video", readable: true, extractable: false },
  { format: "webm", mime: "video/webm", kind: "video", readable: true, extractable: false },
  { format: "mov", mime: "video/quicktime", kind: "video", readable: true, extractable: false },
  { format: "m4v", mime: "video/mp4", kind: "video", readable: true, extractable: false },
  { format: "mkv", mime: "video/x-matroska", kind: "video", readable: true, extractable: false },
  { format: "mp3", mime: "audio/mpeg", kind: "audio", readable: true, extractable: false },
  { format: "m4a", mime: "audio/mp4", kind: "audio", readable: true, extractable: false },
  { format: "wav", mime: "audio/wav", kind: "audio", readable: true, extractable: false },
  { format: "ogg", mime: "audio/ogg", kind: "audio", readable: true, extractable: false },
  { format: "flac", mime: "audio/flac", kind: "audio", readable: true, extractable: false },
  { format: "jpg", mime: "image/jpeg", kind: "image", readable: true, extractable: false },
  { format: "png", mime: "image/png", kind: "image", readable: true, extractable: false },
  { format: "gif", mime: "image/gif", kind: "image", readable: true, extractable: false },
  { format: "webp", mime: "image/webp", kind: "image", readable: true, extractable: false },
];

/** 规范名 → 规格 */
export const FORMATS: ReadonlyMap<string, FormatSpec> = new Map(REGISTRY.map((s) => [s.format, s]));

/** 已知格式集合（detectFormat 白名单=注册表键集）。 */
export const KNOWN_FORMATS: ReadonlySet<string> = new Set(FORMATS.keys());

/** 规范名全表（筛选下拉等枚举用，注册表顺序）。 */
export const CANONICAL_FORMATS: readonly string[] = [...FORMATS.keys()];

/** 内置阅读器可否打开（含状态聚合语义：不可读格式中性不参与）。 */
export function isReadableFormat(format: string): boolean {
  return FORMATS.get(format)?.readable === true;
}

/** 文件伺服 Content-Type（未知格式回落 octet-stream）。 */
export function mediaTypeOf(format: string): string {
  return FORMATS.get(format)?.mime ?? "application/octet-stream";
}

/** 内容类别（未知格式 null）。 */
export function formatKind(format: string): FormatSpec["kind"] | null {
  return FORMATS.get(format)?.kind ?? null;
}

const EXT_ALIASES: Record<string, string> = { htm: "html", markdown: "md", mdown: "md", jpeg: "jpg" };

/** 不限格式：已知格式返回规范名；未知扩展名原样登记（清理为字母数字，≤12 位）；无扩展名记 bin。 */
export function detectFormat(filename: string): string {
  const name = filename.replaceAll("\\", "/");
  const dot = name.lastIndexOf(".");
  let ext = (dot >= 0 ? name.slice(dot + 1) : "").toLowerCase();
  ext = EXT_ALIASES[ext] ?? ext;
  if (KNOWN_FORMATS.has(ext)) return ext;
  const cleaned = ext.replace(/[^a-z0-9]/g, "").slice(0, 12);
  return cleaned || "bin";
}
