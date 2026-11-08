import { useEffect, useMemo, useState } from "react";
import { prettyDisplayDate } from "@zzlibrary/core";
import { api, formatBytes, type FileDetail, type PackageDetail } from "@zzlibrary/shared/client";
import FileRow from "./FileRow";

function fmtPath(p: { l1?: { name: string } | null; l2?: { name: string } | null; l3?: { name: string } | null }): string {
  return [p.l1?.name, p.l2?.name, p.l3?.name].filter(Boolean).join("/");
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-10 shrink-0 text-stone-400">{label}</span>
      <span className="min-w-0 break-words text-stone-700">{value}</span>
    </div>
  );
}

/** 包详情主体（两个详情面板共用的唯一实现）：封面+元数据区、继续读、包内文件列表。
 * 容器差异（弹窗 vs 抽屉）由各自外壳承担；此处保证交互契约一致——继续读不再是某一面板独有。 */
export default function PackageDetailBody({
  detail,
  onRead,
  metaExtra,
}: {
  detail: PackageDetail;
  onRead: (file: FileDetail) => void;
  /** 容器专属动作（如编辑按钮），渲染在元数据列尾 */
  metaExtra?: React.ReactNode;
}) {
  // 长列表上限：几百文件的包先出前 50 条，「显示全部」再放行（封面 img 风暴防护）
  const FILE_LIMIT = 50;
  const [showAllFiles, setShowAllFiles] = useState(false);
  useEffect(() => setShowAllFiles(false), [detail.id]);
  const visibleFiles = showAllFiles ? detail.files : detail.files.slice(0, FILE_LIMIT);
  const lastRead = useMemo(
    () =>
      [...detail.files]
        .filter((f) => f.progress !== null)
        .sort((a, b) => (b.progress!.updated_at < a.progress!.updated_at ? -1 : 1))[0] ?? null,
    [detail.files],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[160px_1fr] gap-5">
        <div>
          <img src={api.packageCoverUrl(detail.id)} alt="" className="h-52 w-40 rounded-lg object-cover shadow" />
        </div>
        <div className="min-w-0 space-y-2 text-sm">
          <div className="text-base font-semibold text-stone-800">{detail.title}</div>
          <Info label="作者" value={detail.authors.join("，") || "—"} />
          <Info
            label="分类"
            value={detail.classifications.length > 0 ? detail.classifications.map(fmtPath).join(" · ") : "未分类"}
          />
          <Info label="发布时间" value={prettyDisplayDate(detail.publish_date)} />
          {detail.publisher && <Info label="发布方" value={detail.publisher} />}
          <Info label="体量" value={`${detail.file_count} 个文件 · ${formatBytes(detail.total_size)}`} />
          <Info label="状态" value={detail.status || "—"} />
          {detail.tags.length > 0 && <Info label="标签" value={detail.tags.join("，")} />}
          {detail.notes && <Info label="备注" value={detail.notes} />}
          {metaExtra && <div className="pt-2">{metaExtra}</div>}
        </div>
      </div>
      <div>
        {lastRead !== null && (
          <button
            className="mb-2 flex w-full items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 hover:bg-amber-100"
            onClick={() => onRead(lastRead)}
          >
            <span>继续读 · {lastRead.name}</span>
            <span className="text-xs text-amber-700">上次 {Math.round(lastRead.progress!.percent)}%</span>
          </button>
        )}
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-stone-700">包内文件（{detail.files.length}）</span>
        </div>
        <div className="space-y-2">
          {visibleFiles.map((f) => (
            <FileRow key={f.id} file={f} showProgress onRead={onRead} />
          ))}
          {detail.files.length > FILE_LIMIT && !showAllFiles && (
            <button
              className="w-full rounded-lg border border-stone-200 py-2 text-xs text-stone-500 hover:border-amber-500 hover:text-amber-700"
              onClick={() => setShowAllFiles(true)}
            >
              显示全部 {detail.files.length} 个文件
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
