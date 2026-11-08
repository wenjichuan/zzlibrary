import { isReadableFormat } from "@zzlibrary/core";
import { api, formatBytes, type FileDetail } from "@zzlibrary/shared/client";

/** 格式图标的唯一出处（各页共用，勿再另建副本） */
export const FORMAT_ICONS: Record<string, string> = {
  epub: "📕", pdf: "📄", txt: "📝", md: "📝", html: "🌐",
  docx: "📘", pptx: "📊", xlsx: "📊",
  mp4: "🎬", webm: "🎬", mov: "🎬", m4v: "🎬", mkv: "🎬",
  mp3: "🎵", m4a: "🎵", wav: "🎵", ogg: "🎵", flac: "🎵",
  jpg: "🖼", png: "🖼", gif: "🖼", webp: "🖼",
};

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
 * 文件行的唯一交互契约（全应用单一形态，勿在页面内重写）：可读格式行点击或「阅览」进内置阅读器；
 * 不可读格式「阅览」置灰（悬停说明）、「另存」带 download 强制保存语义（浏览器不自作主张渲染或导航）。
 */
export default function FileRow({
  file,
  onRead,
  showProgress,
}: {
  file: FileDetail;
  onRead?: (f: FileDetail) => void;
  showProgress?: boolean;
}) {
  const readable = isReadableFormat(file.format);
  const meta = metaText(file, showProgress);

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
          <img src={api.fileCoverUrl(file.id)} loading="lazy" decoding="async" className="h-full w-full object-cover" alt="" />
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
        <button
          className={
            readable
              ? "rounded-lg border border-amber-600 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 hover:bg-amber-100"
              : "cursor-not-allowed rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-300"
          }
          disabled={!readable}
          title={readable ? undefined : "该格式暂不支持在线阅览，可另存后用本地应用打开"}
          onClick={() => onRead?.(file)}
        >
          阅览
        </button>
        <a
          className="rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs text-stone-700 hover:border-amber-600 hover:text-amber-800"
          href={api.fileUrl(file.id)}
          download={file.name}
        >
          另存
        </a>
      </div>
    </div>
  );
}
