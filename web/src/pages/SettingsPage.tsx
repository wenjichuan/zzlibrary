/** 设置：同步与备份——云配置（fs/WebDAV/S3）、连接测试、立即同步、状态展示、
 * 自动同步开关。凭据只存服务端本地 data/cloud.json，永不上云。 */
import { useCallback, useEffect, useState } from "react";
import { api, formatBytes } from "@zzlibrary/shared/client";
import type { SyncConfig, SyncStatus } from "@zzlibrary/shared/client";
import { Button, Input } from "../components/ui";
import { useToast } from "../stores/toast";
import { renderPdfCoverFromFile } from "../utils/pdfCover";

const PROVIDERS: Array<{ value: SyncConfig["provider"]; label: string; hint: string }> = [
  { value: "fs", label: "本地目录", hint: "本机文件夹当云（测试/单机备份用）" },
  { value: "webdav", label: "WebDAV", hint: "坚果云 / NAS / Nextcloud 等通用" },
  { value: "s3", label: "S3 兼容", hint: "AWS S3 / Cloudflare R2 / MinIO 等" },
];

export default function SettingsPage() {
  const { push } = useToast();
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backfill, setBackfill] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 });
  const [gcing, setGcing] = useState(false);

  /** 整理云端：过期墓碑 + 无引用内容块（删除时已记账，按账清理，无全量扫描）。 */
  const gcCloud = async () => {
    if (!window.confirm("将清理云端：超过 180 天的删除记录、以及已无任何馆藏引用的文件内容块。此操作不可恢复，确定继续？")) return;
    setGcing(true);
    try {
      const r = await api.gcCloud();
      push(
        r.report.errors.length > 0 ? "error" : "success",
        `整理完成：清理删除记录 ${r.report.tombstonesRemoved} 项 · 删除内容块 ${r.report.blobsRemoved} 个（${formatBytes(r.report.blobBytesRemoved)}）` +
          (r.report.blobsSkippedReferenced > 0 ? ` · ${r.report.blobsSkippedReferenced} 个仍被引用已跳过` : "")
      );
      refreshStatus();
    } catch (err) {
      push("error", err instanceof Error ? err.message : "整理失败");
    } finally {
      setGcing(false);
    }
  };

  const refreshStatus = useCallback(() => {
    void api.syncStatus().then(setStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    void api
      .syncConfig()
      .then(({ config: cfg }) => {
        setConfig(cfg ?? { provider: "webdav", autoSync: false, webdav: { baseUrl: "", username: "", password: "", rootPath: "zzlibrary" } });
        setLoaded(true);
      })
      .catch(() => undefined);
    refreshStatus();
  }, [refreshStatus]);

  const save = async () => {
    if (config === null) return;
    setSaving(true);
    try {
      await api.putSyncConfig(config);
      refreshStatus();
      if (config.autoSync) {
        // 开启自动同步 = 用户要"现在就开始同步"：保存后立即跑一次（存量未同步内容一次上云）
        try {
          const { report } = await api.syncNow();
          push(
            "success",
            `自动同步已开启，并完成一次同步：拉取 ${report.pull.applied + report.pull.tombstones} · 推送 ${report.push.uploadedManifests} 份清单 · 上传 ${report.push.uploadedBlobs} 个内容块`,
          );
        } catch (err) {
          push("error", `自动同步已开启，但首次同步失败：${err instanceof Error ? err.message : "未知错误"}`);
        }
        refreshStatus();
      } else {
        push("success", "已保存云配置");
      }
    } catch (err) {
      push("error", err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (config === null) return;
    setTesting(true);
    try {
      await api.putSyncConfig(config); // 用当前表单值测试
      await api.testSync();
      push("success", "连接成功，可读写");
    } catch (err) {
      push("error", err instanceof Error ? err.message : "连接失败");
    } finally {
      setTesting(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const { report } = await api.syncNow();
      const p = report.push;
      const g = report.pull;
      push(
        p.errors.length + g.errors.length > 0 ? "error" : "success",
        `拉取 ${g.applied + g.tombstones} · 推送 ${p.uploadedManifests}（内容块 ${p.uploadedBlobs} 个/${formatBytes(p.uploadedBlobBytes)}）` +
          (p.errors.length + g.errors.length > 0 ? ` · ${p.errors.length + g.errors.length} 项错误` : ""),
      );
      refreshStatus();
    } catch (err) {
      push("error", err instanceof Error ? err.message : "同步失败");
      refreshStatus();
    } finally {
      setSyncing(false);
    }
  };

  /** 存量 PDF 封面补齐：逐包用首页渲染真封面并上传（浏览器渲染，无服务端依赖）。 */
  const backfillCovers = async () => {
    setBackfill({ running: true, done: 0, total: 0 });
    let done = 0;
    let total = 0;
    try {
      for (let page = 1; ; page++) {
        const list = await api.listPackages({ format: "pdf", page, page_size: 100 });
        total = list.total;
        if (list.items.length === 0) break;
        for (const item of list.items) {
          const detail = await api.getPackage(item.id);
          if (detail.has_real_cover === true) {
            done += 1;
            setBackfill({ running: true, done, total });
            continue;
          }
          const pdfFile = detail.files.find((f) => f.format === "pdf");
          if (pdfFile !== undefined) {
            const cover = await renderPdfCoverFromFile(pdfFile.id);
            if (cover !== null) await api.uploadCover(item.id, cover);
          }
          done += 1;
          setBackfill({ running: true, done, total });
        }
        if (page * 100 >= total) break;
      }
      push("success", `PDF 封面补齐完成（共 ${done} 包）`);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "补齐中断");
    } finally {
      setBackfill({ running: false, done: 0, total: 0 });
    }
  };

  if (!loaded) return <div className="p-6 text-sm text-stone-500">加载中…</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <header>
        <h1 className="text-lg font-semibold text-stone-800">设置 · 同步与备份</h1>
        <p className="mt-1 text-sm text-stone-500">
          馆藏（元数据 + 文件内容）同步到你自己的云。本地是唯一工作副本；云端为版本化清单 + 内容寻址存储。
          凭据只保存在本机，不会上云。
        </p>
      </header>

      {config !== null && (
        <section className="space-y-3 rounded-xl border border-stone-200 bg-white p-4">
          <div className="text-sm font-semibold text-stone-700">云端</div>
          <div className="grid grid-cols-3 gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.value}
                onClick={() =>
                  setConfig({
                    ...config,
                    provider: p.value,
                    fs: p.value === "fs" ? (config.fs ?? { root: "" }) : config.fs,
                    webdav: p.value === "webdav" ? (config.webdav ?? { baseUrl: "", username: "", password: "", rootPath: "zzlibrary" }) : config.webdav,
                    s3: p.value === "s3" ? (config.s3 ?? { endpoint: "", region: "auto", bucket: "", accessKeyId: "", secretAccessKey: "", prefix: "zzlibrary" }) : config.s3,
                  })
                }
                className={
                  "rounded-lg border px-3 py-2 text-left text-sm transition " +
                  (config.provider === p.value
                    ? "border-amber-600 bg-amber-50 text-amber-900"
                    : "border-stone-200 text-stone-600 hover:border-stone-300")
                }
              >
                <div className="font-medium">{p.label}</div>
                <div className="mt-0.5 text-xs text-stone-400">{p.hint}</div>
              </button>
            ))}
          </div>

          {config.provider === "fs" && (
            <label className="block space-y-1">
              <span className="text-xs text-stone-500">云端根目录（本机路径）</span>
              <Input
                value={config.fs?.root ?? ""}
                onChange={(e) => setConfig({ ...config, fs: { root: e.target.value } })}
                placeholder="D:\\backup\\zzlibrary-cloud"
              />
            </label>
          )}

          {config.provider === "webdav" && (
            <div className="space-y-2">
              <label className="block space-y-1">
                <span className="text-xs text-stone-500">服务地址（如 https://dav.jianguoyun.com/dav/）</span>
                <Input
                  value={config.webdav?.baseUrl ?? ""}
                  onChange={(e) => setConfig({ ...config, webdav: { ...(config.webdav ?? { baseUrl: "" }), baseUrl: e.target.value } })}
                  placeholder="https://dav.jianguoyun.com/dav/"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-xs text-stone-500">账号（坚果云为邮箱）</span>
                  <Input
                    value={config.webdav?.username ?? ""}
                    onChange={(e) => setConfig({ ...config, webdav: { ...(config.webdav ?? { baseUrl: "" }), username: e.target.value } })}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-stone-500">密码 / 应用密码</span>
                  <Input
                    type="password"
                    value={config.webdav?.password ?? ""}
                    onChange={(e) => setConfig({ ...config, webdav: { ...(config.webdav ?? { baseUrl: "" }), password: e.target.value } })}
                    placeholder={config.webdav?.password === "***" ? "已保存（留 *** 不变）" : ""}
                  />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-xs text-stone-500">库根目录名</span>
                <Input
                  value={config.webdav?.rootPath ?? "zzlibrary"}
                  onChange={(e) => setConfig({ ...config, webdav: { ...(config.webdav ?? { baseUrl: "" }), rootPath: e.target.value } })}
                />
              </label>
            </div>
          )}

          {config.provider === "s3" && config.s3 !== undefined && (
            <div className="space-y-2">
              <label className="block space-y-1">
                <span className="text-xs text-stone-500">Endpoint（R2：https://&lt;账户&gt;.r2.cloudflarestorage.com）</span>
                <Input
                  value={config.s3.endpoint}
                  onChange={(e) => setConfig({ ...config, s3: { ...config.s3!, endpoint: e.target.value } })}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-xs text-stone-500">Region（R2 填 auto）</span>
                  <Input
                    value={config.s3.region}
                    onChange={(e) => setConfig({ ...config, s3: { ...config.s3!, region: e.target.value } })}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-stone-500">Bucket</span>
                  <Input
                    value={config.s3.bucket}
                    onChange={(e) => setConfig({ ...config, s3: { ...config.s3!, bucket: e.target.value } })}
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-xs text-stone-500">Access Key ID</span>
                  <Input
                    value={config.s3.accessKeyId}
                    onChange={(e) => setConfig({ ...config, s3: { ...config.s3!, accessKeyId: e.target.value } })}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-stone-500">Secret Access Key</span>
                  <Input
                    type="password"
                    value={config.s3.secretAccessKey}
                    onChange={(e) => setConfig({ ...config, s3: { ...config.s3!, secretAccessKey: e.target.value } })}
                    placeholder={config.s3.secretAccessKey === "***" ? "已保存（留 *** 不变）" : ""}
                  />
                </label>
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 pt-1 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={config.autoSync}
              onChange={(e) => setConfig({ ...config, autoSync: e.target.checked })}
              className="h-4 w-4 accent-amber-700"
            />
            自动同步（入库 / 编辑 / 阅读进度后数秒内静默上传）
          </label>

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存配置"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void test()} disabled={testing}>
              {testing ? "测试中…" : "测试连接"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void syncNow()} disabled={syncing || !status?.configured}>
              {syncing ? "同步中…" : "立即同步"}
            </Button>
          </div>
        </section>
      )}

      {status !== null && (
        <section className="space-y-2 rounded-xl border border-stone-200 bg-white p-4 text-sm">
          <div className="font-semibold text-stone-700">状态</div>
          <div className="grid grid-cols-[92px_1fr] gap-y-1 text-stone-600">
            <span className="text-stone-400">云端</span>
            <span>{status.configured ? "已配置" : "未配置"}</span>
            <span className="text-stone-400">清单版本</span>
            <span>{status.revision > 0 ? `第 ${status.revision} 版` : "—"}</span>
            <span className="text-stone-400">上次同步</span>
            <span>
              {status.lastSyncAt === null
                ? "—"
                : new Date(status.lastSyncAt).toLocaleString("zh-CN")}
              {status.running ? " · 进行中…" : ""}
            </span>
            {status.pendingHashFiles > 0 && (
              <>
                <span className="text-stone-400">待算哈希</span>
                <span>{status.pendingHashFiles} 个文件（下次同步时自动补齐）</span>
              </>
            )}
          </div>
          {status.lastError !== null && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{status.lastError}</div>
          )}
          {status.lastReport !== null && (
            <div className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
              上次：拉取 {status.lastReport.pull.applied + status.lastReport.pull.tombstones} 项 ·
              推送 {status.lastReport.push.uploadedManifests} 份清单 ·
              上传 {status.lastReport.push.uploadedBlobs} 个内容块（{formatBytes(status.lastReport.push.uploadedBlobBytes)}）
            </div>
          )}
          <p className="text-xs text-stone-400">
            说明：新设备只需填同一云配置并「立即同步」即可恢复全部馆藏（文件按需取回）；
            释放过本地空间的包在打开时会自动从云端取回。
          </p>
        </section>
      )}

      <section className="space-y-2 rounded-xl border border-stone-200 bg-white p-4 text-sm">
        <div className="font-semibold text-stone-700">维护</div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-stone-500">存量 PDF 封面补齐（用首页渲染真封面，浏览器本地渲染）</span>
          <Button size="sm" variant="outline" onClick={() => void backfillCovers()} disabled={backfill.running}>
            {backfill.running ? `补齐中 ${backfill.done}/${backfill.total || "?"}` : "开始补齐"}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-stone-100 pt-2">
          <span className="text-stone-500">
            整理云端（清理 180 天前的删除记录与已无引用的内容块，释放云盘空间，不可恢复）
          </span>
          <Button size="sm" variant="outline" onClick={() => void gcCloud()} disabled={gcing || !status?.configured}>
            {gcing ? "整理中…" : "整理云端"}
          </Button>
        </div>
      </section>
    </div>
  );
}
