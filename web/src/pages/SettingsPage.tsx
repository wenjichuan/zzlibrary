/** 设置 · 备份：整库备份到本机目录（1.0 的数据安全兜底）。
 * 1.0 不带云同步——离线优先，资料在本机；跨设备同步将在后续版本提供。 */
import { useState } from "react";
import { api, formatBytes } from "@zzlibrary/shared/client";
import type { BackupReport } from "@zzlibrary/shared/client";
import { Button, Input, PageHeader } from "../components/ui";
import { useToast } from "../stores/toast";
import { useT } from "../i18n/lang";

export default function SettingsPage() {
  const t = useT();
  const { push } = useToast();
  const [dest, setDest] = useState("");
  const [backing, setBacking] = useState(false);
  const [lastReport, setLastReport] = useState<BackupReport | null>(null);

  const backupNow = async () => {
    if (!dest.trim()) {
      push("error", t("settings.destRequired"));
      return;
    }
    setBacking(true);
    try {
      const r = await api.backupLibrary(dest.trim());
      setLastReport(r);
      push("success", t("settings.backupDone", { n: r.files, size: formatBytes(r.bytes), dest: r.dest }));
    } catch (err) {
      push("error", err instanceof Error ? err.message : t("settings.backupFail"));
    } finally {
      setBacking(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5 px-6 py-6">
      <div>
        <PageHeader title={t("settings.title")} />
        <p className="-mt-3 text-sm text-stone-500">
          {t("settings.intro")}
        </p>
      </div>

      <section className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 text-sm">
        <div className="font-semibold text-stone-700">{t("settings.backupTitle")}</div>
        <label className="block space-y-1">
          <span className="text-xs text-stone-500">{t("settings.destLabel")}</span>
          <Input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="D:\zzlibrary-backup" />
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-stone-500">
            {t("settings.backupHint")}
          </span>
          <Button size="sm" onClick={() => void backupNow()} disabled={backing}>
            {backing ? t("settings.backing") : t("settings.start")}
          </Button>
        </div>
        {lastReport !== null && (
          <div className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
            {t("settings.lastBackup", { n: lastReport.files, size: formatBytes(lastReport.bytes), dest: lastReport.dest })}
          </div>
        )}
      </section>
    </div>
  );
}
