/** 设置 · 维护与备份：整库备份到本机目录（1.0 的数据安全兜底）+ 存量 PDF 封面补齐。
 * 1.0 不带云同步——离线优先，资料在本机；跨设备同步将在后续版本提供。 */
import { useState } from "react";
import { api, formatBytes } from "@zzlibrary/shared/client";
import type { BackupReport } from "@zzlibrary/shared/client";
import { Button, Input } from "../components/ui";
import { useToast } from "../stores/toast";
import { renderPdfCoverFromFile } from "../utils/pdfCover";

export default function SettingsPage() {
  const { push } = useToast();
  const [backfill, setBackfill] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 });
  const [dest, setDest] = useState("");
  const [backing, setBacking] = useState(false);
  const [lastReport, setLastReport] = useState<BackupReport | null>(null);

  /** 存量 PDF 封面补齐：服务端轻清单（无真封面且含 pdf 的包+文件 id）→ 逐包渲染上传。不再逐包拉完整详情（N+1）。 */
  const backfillCovers = async () => {
    setBackfill({ running: true, done: 0, total: 0 });
    try {
      const { items } = await api.needsCoverPackages();
      let done = 0;
      for (const item of items) {
        const cover = await renderPdfCoverFromFile(item.file_id);
        if (cover !== null) await api.uploadCover(item.pkg_id, cover);
        done += 1;
        setBackfill({ running: true, done, total: items.length });
      }
      push("success", `PDF 封面补齐完成（共 ${done} 包）`);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "补齐中断");
    } finally {
      setBackfill({ running: false, done: 0, total: 0 });
    }
  };

  const backupNow = async () => {
    if (!dest.trim()) {
      push("error", "请先填写备份目标目录");
      return;
    }
    setBacking(true);
    try {
      const r = await api.backupLibrary(dest.trim());
      setLastReport(r);
      push("success", `备份完成：${r.files} 个文件 · ${formatBytes(r.bytes)} → ${r.dest}`);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "备份失败");
    } finally {
      setBacking(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <header>
        <h1 className="text-lg font-semibold text-stone-800">设置 · 维护与备份</h1>
        <p className="mt-1 text-sm text-stone-500">
          资料全部保存在本机。定期「备份整库」到其他磁盘或移动硬盘，防丢设备丢资料；
          跨设备云同步将在后续版本提供。
        </p>
      </header>

      <section className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 text-sm">
        <div className="font-semibold text-stone-700">备份整库</div>
        <label className="block space-y-1">
          <span className="text-xs text-stone-500">备份目标目录（本机路径，如移动硬盘）</span>
          <Input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="D:\zzlibrary-backup" />
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-stone-500">
            数据库一致性快照 + 全部文件与封面；重复备份同一目录会覆盖旧快照
          </span>
          <Button size="sm" onClick={() => void backupNow()} disabled={backing}>
            {backing ? "备份中…" : "开始备份"}
          </Button>
        </div>
        {lastReport !== null && (
          <div className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
            上次备份：{lastReport.files} 个文件 · {formatBytes(lastReport.bytes)} → {lastReport.dest}
          </div>
        )}
      </section>

      <section className="space-y-2 rounded-xl border border-stone-200 bg-white p-4 text-sm">
        <div className="font-semibold text-stone-700">维护</div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-stone-500">存量 PDF 封面补齐（用首页渲染真封面，浏览器本地渲染）</span>
          <Button size="sm" variant="outline" onClick={() => void backfillCovers()} disabled={backfill.running}>
            {backfill.running ? `补齐中 ${backfill.done}/${backfill.total || "?"}` : "开始补齐"}
          </Button>
        </div>
      </section>
    </div>
  );
}
