/** 文件格式识别与入库纯逻辑（自 Python services/ingest.py 平移的纯函数部分）。 */

/** 已知格式：可抽取元数据/封面（抽取器有对应实现），媒体类可原生播放。 */
export const KNOWN_FORMATS: ReadonlySet<string> = new Set([
  "epub", "pdf", "txt", "md", "html", "docx", "pptx", "xlsx",
  "mp4", "webm", "mov", "m4v", "mkv", // 视频（原生播放，不转码）
  "mp3", "m4a", "wav", "ogg", "flac", // 音频
  "jpg", "png", "gif", "webp", // 图片
]);

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
