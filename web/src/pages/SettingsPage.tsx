/** 设置 · 备份：整库备份到本机目录（1.0 的数据安全兜底）。
 * 1.0 不带云同步——离线优先，资料在本机；跨设备同步将在后续版本提供。 */
import { useState } from "react";
import { api, formatBytes } from "@zzlibrary/shared/client";
import type { BackupReport } from "@zzlibrary/shared/client";
import { Button, Input, PageHeader } from "../components/ui";
import { useToast } from "../stores/toast";

export default function SettingsPage() {
  const { push } = useToast();
  const [dest, setDest] = useState("");
  const [backing, setBacking] = useState(false);
  const [lastReport, setLastReport] = useState<BackupReport | null>(null);

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
    <div className="mx-auto max-w-2xl space-y-5 px-6 py-6">
      <div>
        <PageHeader title="设置 · 维护与备份" />
        <p className="-mt-3 text-sm text-stone-500">
          资料全部保存在本机。定期「备份整库」到其他磁盘或移动硬盘，防丢设备丢资料；
          跨设备云同步将在后续版本提供。
        </p>
      </div>

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
    </div>
  );
}
