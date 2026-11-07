import { api, formatBytes, type FileDetail } from "@zzlibrary/shared";
import { readableFormat } from "./ReaderOverlay";

/** 格式图标的唯一出处（各页共用，勿再另建副本） */
export const FORMAT_ICONS: Record<string, string> = {
  epub: "📕", pdf: "📄", txt: "📝", md: "📝", html: "🌐",
  docx: "📘", pptx: "📊", xlsx: "📊",
  mp4: "🎬", webm: "🎬", mov: "🎬", m4v: "🎬", mkv: "🎬",
  mp3: "🎵", m4a: "🎵", wav: "🎵", ogg: "🎵", flac: "🎵",
  jpg: "🖼", png: "🖼", gif: "🖼", webp: "🖼",
};

/** 浏览器新标签页能直接渲染的格式（直链后内联展示）；其余格式（epub/docx/pptx/xlsx/mkv/未知）浏览器只会下载 */
const BROWSER_VIEWABLE = new Set([
  "pdf", "txt", "md", "html", "jpg", "png", "gif", "webp",
  "mp4", "m4v", "webm", "mov", "mp3", "m4a", "wav", "ogg", "flac",
]);

function metaText(file: FileDetail, showProgress?: boolean): string {
  return [
    String(file.format).toUpperCase(),
    formatBytes(file.file_size),
    file.page_count ? `${file.page_count} 页` : "",
    showProgress && file.progress ? `已看 ${Math.round(file.progress.percent)}%` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 文件行的唯一交互契约：可读格式点击即读（onRead 打开内置阅读器，字节不在本地时由服务端静默取回），
 * 不可读格式直链原始文件（下载即其用法）。所有展示文件列表的页面共用，勿在页面内重写。
 * compact=紧凑行（书架页详情卡）：整行即点击区；默认=完整行（资料包页）：封面缩略图 + 「阅读/打开」按钮。
 */
export default function FileRow({
  file,
  onRead,
  showProgress,
  compact,
}: {
  file: FileDetail;
  onRead?: (f: FileDetail) => void;
  showProgress?: boolean;
  compact?: boolean;
}) {
  const readable = readableFormat(file.format);
  const meta = metaText(file, showProgress);

  if (compact) {
    const cls =
      "flex w-full items-center justify-between gap-2 rounded-lg border border-stone-100 px-3 py-2 text-left text-xs text-stone-700 hover:border-amber-500 hover:bg-amber-50";
    return readable ? (
      <button type="button" className={cls} onClick={() => onRead?.(file)}>
        <span className="truncate">{file.name}</span>
        <span className="ml-2 shrink-0 text-stone-400">{meta}</span>
      </button>
    ) : (
      <a className={cls} href={api.fileUrl(file.id)} target="_blank" rel="noreferrer">
        <span className="truncate">{file.name}</span>
        <span className="ml-2 shrink-0 text-stone-400">{meta}</span>
      </a>
    );
  }

  return (
    <div
      className={
        "flex items-center gap-3 rounded-lg border border-stone-100 px-3 py-2 hover:bg-stone-50 " +
        (readable && onRead ? "cursor-pointer" : "")
      }
      onClick={readable && onRead ? () => onRead(file) : undefined}
    >
      <div className="h-10 w-8 shrink-0 overflow-hidden rounded bg-stone-100">
        {file.has_cover ? (
          <img src={api.fileCoverUrl(file.id)} className="h-full w-full object-cover" alt="" />
        ) : (
          <div className="flex h-full items-center justify-center text-base">{FORMAT_ICONS[file.format] ?? "📄"}</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-stone-800" title={file.name}>
          {file.name}
        </div>
        <div className="text-xs text-stone-500">{meta}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {readable && onRead && (
          <button
            className="rounded-lg border border-amber-600 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 hover:bg-amber-100"
            onClick={() => onRead(file)}
          >
            阅读
          </button>
        )}
        <a
          className="rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs text-stone-700 hover:border-amber-600 hover:text-amber-800"
          href={api.fileUrl(file.id)}
          target="_blank"
          rel="noreferrer"
        >
          {BROWSER_VIEWABLE.has(file.format) ? "打开" : "下载"}
        </a>
      </div>
    </div>
  );
}
