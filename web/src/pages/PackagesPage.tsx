import { useCallback, useEffect, useRef, useState } from "react";
import { CANONICAL_FORMATS } from "@zzlibrary/core";
import { api, formatBytes, type FileDetail, type Package, type PackageDetail, type PackagePage } from "@zzlibrary/shared/client";
import PackageMetaForm, { metaFromPackage, metaToInput, type MetaFormValue } from "../components/PackageMetaForm";
import { Button, Empty, Input, Modal, PageHeader, Select, Spinner } from "../components/ui";
import { flatten, useCategories } from "../stores/categories";
import { useToast } from "../stores/toast";
import { useT } from "../i18n/lang";
import { prettyDate, statusLabel } from "../components/shelfVM";
import { useReaderOverlay } from "../components/ReaderOverlay";
import PackageDetailBody, { fmtPath } from "../components/PackageDetailBody";
import { FORMAT_ICONS } from "../components/FileRow";
import { renderPdfCover } from "../utils/pdfCover";

/** 格式筛选选项从 core 格式注册表派生（全量规范名），勿手抄清单 */
const FORMATS = ["", ...CANONICAL_FORMATS];
const STATUSES = ["", "unread", "reading", "done"];
const SORT_KEYS = ["newest", "oldest", "title", "date_asc", "date_desc"] as const;
const SORT_LABELS: Record<(typeof SORT_KEYS)[number], "pkg.sortNewest" | "pkg.sortOldest" | "pkg.sortTitle" | "pkg.sortAsc" | "pkg.sortDesc"> = {
  newest: "pkg.sortNewest",
  oldest: "pkg.sortOldest",
  title: "pkg.sortTitle",
  date_asc: "pkg.sortAsc",
  date_desc: "pkg.sortDesc",
};

/** 页码直达输入框：原「第几页 / 总页数」位置——键入页数回车（或失焦）跳转，越界夹取到 [1, totalPages]，非数字忽略 */
function PageJump({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  const t = useT();
  const [text, setText] = useState(String(page));
  useEffect(() => setText(String(page)), [page]);
  const commit = () => {
    const n = parseInt(text, 10);
    if (Number.isFinite(n)) onPage(Math.min(Math.max(1, n), totalPages));
    else setText(String(page));
  };
  return (
    <span className="flex items-center gap-1">
      <input
        aria-label={t("pkg.pageJump")}
        value={text}
        onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="h-7 w-11 rounded-lg border border-stone-200 px-2 text-center text-xs tabular-nums text-stone-700 focus:border-amber-500 focus:outline-none"
      />
      <span>/ {totalPages}</span>
    </span>
  );
}

export default function PackagesPage() {
  const t = useT();
  const [data, setData] = useState<PackagePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(() => {
    const sp = new URLSearchParams(window.location.search);
    return {
      l1: sp.get("l1") ?? "",
      l2: "",
      l3: "",
      q: sp.get("q") ?? "",
      format: "",
      status: "",
      undated: "",
      sort: "newest",
    };
  });
  const [page, setPage] = useState(1);
  /** 搜索框即时文本：防抖后并入 filters.q，避免逐键全表查询 */
  const [qText, setQText] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [editing, setEditing] = useState<PackageDetail | null>(null);
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const { push } = useToast();
  const loadCategories = useCategories((s) => s.load);
  const tree = useCategories((s) => s.tree);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const abortRef = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    abortRef.current?.abort(); // 取消上一次在途请求：慢响应后到不再覆盖新结果
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const resp = await api.listPackages({ ...filters, page, page_size: 20 }, ac.signal);
      if (ac.signal.aborted) return;
      setData(resp);
    } catch (err) {
      if (!ac.signal.aborted) push("error", err instanceof Error ? err.message : t("common.loadFail"));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [filters, page, push]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 过滤条件变化统一入口：与页码归一在同一批 setState 内生效，避免先按旧页码多发一次请求 */
  const applyFilters = useCallback((updater: (f: typeof filters) => typeof filters) => {
    setFilters((f) => updater(f));
    setPage(1);
  }, []);

  // 搜索防抖：停顿 300ms 才并入查询（回车立即）
  useEffect(() => {
    const t = window.setTimeout(() => applyFilters((f) => (f.q === qText ? f : { ...f, q: qText })), 300);
    return () => window.clearTimeout(t);
  }, [qText, applyFilters]);

  const { l1, l2 } = flatten(tree);
  const l1Node = l1.find((n) => String(n.id) === filters.l1);
  const l2Options = filters.l1 ? (l1Node?.children ?? []) : [];
  const l3Options = (() => {
    const n = l2.find((x) => String(x.id) === filters.l2);
    return filters.l2 ? (n?.children ?? []) : [];
  })();

  const openDetailById = async (id: number) => {
    try {
      const fresh = await api.getPackage(id);
      setDetail(fresh);
      // 就地补丁列表中该包的状态——关闭阅读器时详情刷新（requestClose 已保证进度先写回）顺带更新列表行，单请求不整表重拉
      setData((prev) =>
        prev ? { ...prev, items: prev.items.map((p) => (p.id === id ? { ...p, status: fresh.status } : p)) } : prev,
      );
    } catch {
      /* 刷新失败保持旧态 */
    }
  };

  const { openReader, readerNode } = useReaderOverlay(detail, openDetailById);

  /** 封面点击开详情：走 openDetailById 同一实现（顺带补丁列表行状态，不再维护两份近重复逻辑） */
  const openDetail = (pkg: Package) => void openDetailById(pkg.id);

  const openEdit = async (pkg: Package) => {
    try {
      setEditing(await api.getPackage(pkg.id));
    } catch (err) {
      push("error", err instanceof Error ? err.message : t("common.loadFail"));
    }
  };

  const remove = async (pkg: Package) => {
    if (!window.confirm(t("pkg.deleteConfirm", { name: pkg.title, n: pkg.file_count }))) return;
    try {
      await api.deletePackage(pkg.id);
      push("success", t("pkg.deleted"));
      // 乐观更新：就地移除该行，不整表重拉
      setData((prev) => (prev ? { ...prev, total: prev.total - 1, items: prev.items.filter((p) => p.id !== pkg.id) } : prev));
    } catch (err) {
      push("error", err instanceof Error ? err.message : t("common.deleteFail"));
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <PageHeader
        title={t("nav.packages")}
        actions={
          <Button variant="outline" onClick={() => void load()}>
            {t("pkg.refresh")}
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:w-56"
          placeholder={t("pkg.search")}
          value={qText}
          onChange={(e) => setQText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyFilters((f) => (f.q === qText ? f : { ...f, q: qText }));
          }}
        />
        <Select className="w-full sm:w-32" value={filters.l1} onChange={(e) => applyFilters((f) => ({ ...f, l1: e.target.value, l2: "", l3: "" }))}>
          <option value="">{t("pkg.allCat")}</option>
          {l1.map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
          <option value="none">{t("common.uncategorized")}</option>
        </Select>
        {filters.l1 && (
          <Select className="w-full sm:w-32" value={filters.l2} onChange={(e) => applyFilters((f) => ({ ...f, l2: e.target.value, l3: "" }))}>
            <option value="">{t("pkg.allL2")}</option>
            {l2Options.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </Select>
        )}
        {filters.l2 && (
          <Select className="w-full sm:w-32" value={filters.l3} onChange={(e) => applyFilters((f) => ({ ...f, l3: e.target.value }))}>
            <option value="">{t("pkg.allL3")}</option>
            {l3Options.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </Select>
        )}
        <Select className="w-full sm:w-28" value={filters.format} onChange={(e) => applyFilters((f) => ({ ...f, format: e.target.value }))}>
          {FORMATS.map((f) => (
            <option key={f} value={f}>{f ? `${FORMAT_ICONS[f] ?? ""} ${f.toUpperCase()}` : t("pkg.allFormat")}</option>
          ))}
        </Select>
        <Select className="w-full sm:w-24" value={filters.status} onChange={(e) => applyFilters((f) => ({ ...f, status: e.target.value }))}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s ? statusLabel(s) : t("pkg.allStatus")}</option>
          ))}
        </Select>
        <Select className="w-full sm:w-28" value={filters.undated} onChange={(e) => applyFilters((f) => ({ ...f, undated: e.target.value }))}>
          <option value="">{t("pkg.allTime")}</option>
          <option value="1">{t("common.undated")}</option>
        </Select>
        <Select className="w-full sm:w-28" value={filters.sort} onChange={(e) => applyFilters((f) => ({ ...f, sort: e.target.value }))}>
          {SORT_KEYS.map((v) => (
            <option key={v} value={v}>{t(SORT_LABELS[v])}</option>
          ))}
        </Select>
      </div>

      {loading && !data ? (
        <Spinner />
      ) : !data || data.items.length === 0 ? (
        <Empty icon="📦" title={t("pkg.emptyTitle")} hint={t("pkg.emptyHint")} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-xs text-stone-500">
                <th className="w-14 px-4 py-3">{t("pkg.thCover")}</th>
                <th className="px-4 py-3">{t("pkg.thName")}</th>
                <th className="px-4 py-3">{t("pkg.thCat")}</th>
                <th className="w-28 px-4 py-3">{t("pkg.thTime")}</th>
                <th className="w-16 px-4 py-3">{t("pkg.thStatus")}</th>
                <th className="w-28 px-4 py-3 text-right">{t("pkg.thActions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((pkg) => (
                <tr key={pkg.id} className="border-b border-stone-100 last:border-0 hover:bg-amber-50/40">
                  <td className="px-4 py-2.5">
                    <img
                      src={api.packageCoverUrl(pkg.id)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-14 w-10 cursor-pointer rounded object-cover"
                      onClick={() => void openDetail(pkg)}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="max-w-md truncate font-medium text-stone-800" title={pkg.title}>
                      {pkg.title}
                    </div>
                    <div className="text-xs text-stone-500">
                      {pkg.authors.join(", ") || "—"} · {t("common.nFiles", { n: pkg.file_count })} · {formatBytes(pkg.total_size)}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-stone-600">
                    {pkg.classifications.length > 0 ? (
                      <span title={pkg.classifications.map(fmtPath).join("\n")}>
                        {pkg.classifications.map(fmtPath).join(" · ")}
                      </span>
                    ) : (
                      <span className="text-stone-400">{t("common.uncategorized")}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-stone-600">{prettyDate(pkg.publish_date)}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        pkg.status === "done"
                          ? "bg-emerald-100 text-emerald-700"
                          : pkg.status === "reading"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-stone-100 text-stone-500"
                      }`}
                    >
                      {statusLabel(pkg.status) || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs">
                    <Button variant="ghost" size="sm" className="mr-2" onClick={() => void openEdit(pkg)}>{t("pkg.edit")}</Button>
                    <Button variant="danger" size="sm" onClick={() => void remove(pkg)}>{t("common.delete")}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-stone-200 px-4 py-3 text-xs text-stone-500">
            <span>{t("pkg.total", { n: data.total })}</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                {t("pkg.prev")}
              </Button>
              <PageJump page={data.page} totalPages={totalPages} onPage={setPage} />
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                {t("pkg.next")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <DetailModal
          detail={detail}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEditing(detail);
            setDetail(null);
          }}
          onRead={openReader}
        />
      )}
      {readerNode}
      {editing && (
        <EditModal
          detail={editing}
          onClose={() => setEditing(null)}
          onSaved={(fresh) => {
            setEditing(null);
            if (fresh) {
              // 保存接口已返回最新详情：就地补丁详情与列表行，不整表重拉
              setDetail(fresh);
              setData((prev) =>
                prev ? { ...prev, items: prev.items.map((p) => (p.id === fresh.id ? { ...p, ...fresh } : p)) } : prev,
              );
            } else {
              void load(); // 整包删除/部分生效的兜底场景
            }
          }}
        />
      )}
    </div>
  );
}

function DetailModal({
  detail,
  onClose,
  onEdit,
  onRead,
}: {
  detail: PackageDetail;
  onClose: () => void;
  onEdit: () => void;
  onRead: (file: FileDetail) => void;
}) {
  const t = useT();
  return (
    <Modal title={t("pkg.detailTitle")} onClose={onClose} wide>
      <PackageDetailBody
        detail={detail}
        onRead={onRead}
        metaExtra={
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t("pkg.edit")}
          </Button>
        }
      />
    </Modal>
  );
}

function EditModal({
  detail,
  onClose,
  onSaved,
}: {
  detail: PackageDetail;
  onClose: () => void;
  onSaved: (fresh: PackageDetail | null) => void;
}) {
  const t = useT();
  const [form, setForm] = useState<MetaFormValue>(() => metaFromPackage(detail));
  const [title, setTitle] = useState(detail.title);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<FileDetail[]>(detail.files);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { push } = useToast();

  // 事务式文件改动：新增/移除先挂在本地，保存才落库；取消全部撤销（新增的暂存立即废弃）
  const [pendingAdds, setPendingAdds] = useState<
    { key: string; stageId: string; name: string; format: string; size: number }[]
  >([]);
  const [removeIds, setRemoveIds] = useState<Set<number>>(new Set());

  const keptFiles = files.filter((f) => !removeIds.has(f.id));
  const finalCount = keptFiles.length + pendingAdds.length;
  const willBeEmpty = finalCount === 0;

  const addFiles = async (list: FileList) => {
    for (const [idx, file] of Array.from(list).entries()) {
      try {
        const cover = file.name.toLowerCase().endsWith(".pdf") ? await renderPdfCover(file) : null;
        const staged = await api.stageFile(file, cover);
        setPendingAdds((prev) => [
          ...prev,
          {
            // idx 防同名文件同批添加时 key 撞车（UploadPage 同款写法）
            key: `${Date.now()}-${idx}-${file.name}`,
            stageId: staged.stage_id,
            name: staged.filename,
            format: staged.format,
            size: staged.size,
          },
        ]);
      } catch (err) {
        push("error", t("edit.uploadFail", { name: file.name, msg: err instanceof Error ? err.message : "" }));
      }
    }
  };

  const discardPending = () => {
    const ids = pendingAdds.map((a) => a.stageId);
    if (ids.length) void api.discardStages(ids).catch(() => {});
  };

  const cancel = () => {
    discardPending(); // 撤销：未保存的新文件立即废弃暂存，标记的移除自动作废
    onClose();
  };

  const markRemove = (f: FileDetail) => {
    // 标记是可撤销操作（全部撤销/取消都兜底），无需重确认；空包后果由文件数旁红字持续提示，
    // 真正的确认门设在保存（不可逆删除）那一步，只弹一次。
    if (!window.confirm(t("edit.markRemoveConfirm", { name: f.name }))) return;
    setRemoveIds((prev) => new Set(prev).add(f.id));
  };

  const removedFiles = files.filter((f) => removeIds.has(f.id));

  const saveAll = async () => {
    if (!title.trim() && !willBeEmpty) {
      push("error", t("edit.pkgNameEmpty"));
      return;
    }
    if (willBeEmpty && !window.confirm(t("edit.willDeleteConfirm"))) {
      return;
    }
    setBusy(true);
    try {
      if (willBeEmpty) {
        await api.deletePackage(detail.id);
        push("success", t("edit.deletedToast"));
        onSaved(null);
        return;
      }
      // 文件增删一次批量请求（事务内原子完成，无「部分生效」中间态）；
      // 无文件改动时跳过——空批量会被服务端 422「没有任何变更」拒绝，只改元数据的保存走不到 PATCH
      if (removedFiles.length + pendingAdds.length > 0) {
        await api.applyPackageFiles(
          detail.id,
          removedFiles.map((f) => f.id),
          pendingAdds.map((a) => a.stageId),
        );
      }
      setPendingAdds([]); // 已入包，暂存被后端清除
      const fresh = await api.updatePackage(detail.id, metaToInput({ ...form, title }));
      push("success", t("edit.saved"));
      onSaved(fresh);
    } catch (err) {
      push("error", err instanceof Error ? err.message : t("edit.saveFail"));
      discardPending(); // 未入包的暂存立即废弃，避免残留
      onSaved(null); // 状态可能部分变化，关闭并刷新列表
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async () => {
    if (!renaming || !renaming.name.trim()) return;
    try {
      const updated = await api.updatePackageFile(detail.id, renaming.id, { name: renaming.name.trim() });
      setFiles((prev) => prev.map((f) => (f.id === updated.id ? { ...f, name: updated.name } : f)));
      setRenaming(null);
    } catch (err) {
      push("error", err instanceof Error ? err.message : t("cat.renameFail"));
    }
  };

  return (
    <Modal title={t("edit.title")} onClose={cancel} wide>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-sm font-medium text-stone-700">{t("edit.pkgName")}</div>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <PackageMetaForm value={form} onChange={setForm} />
        {/* 状态不再可编辑：由文件阅读进度自动推导（不可读格式中性不参与） */}

        <div className="rounded-xl border border-stone-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-stone-700">
              {t("edit.filesTitle", { n: finalCount })}
              {willBeEmpty && <span className="ml-2 text-xs font-normal text-red-600">{t("edit.willDeleteHint")}</span>}
            </span>
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              {t("edit.addFile")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <div className="mb-2 text-[11px] text-stone-400">
            {t("edit.filesHint")}
          </div>
          <div className="space-y-2">
            {keptFiles.map((f) => (
              <div key={f.id} className="flex items-center gap-3 rounded-lg border border-stone-100 px-3 py-2">
                <span className="text-base">{FORMAT_ICONS[f.format] ?? "📄"}</span>
                {renaming?.id === f.id ? (
                  <>
                    <Input
                      className="flex-1"
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && void saveRename()}
                    />
                    <Button size="sm" onClick={() => void saveRename()}>{t("common.save")}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-stone-800">{f.name}</div>
                      <div className="text-xs text-stone-500">
                        {String(f.format).toUpperCase()} · {formatBytes(f.file_size)}
                      </div>
                    </div>
                    <button
                      className="text-xs text-stone-500 hover:text-amber-700"
                      onClick={() => setRenaming({ id: f.id, name: f.name })}
                    >
                      {t("edit.rename")}
                    </button>
                    <button className="text-xs text-stone-500 hover:text-red-600" onClick={() => markRemove(f)}>
                      {t("edit.remove")}
                    </button>
                  </>
                )}
              </div>
            ))}
            {pendingAdds.map((a) => (
              <div
                key={a.key}
                className="flex items-center gap-3 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 px-3 py-2"
              >
                <span className="text-base">{FORMAT_ICONS[a.format] ?? "📄"}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-stone-800">{a.name}</div>
                  <div className="text-xs text-stone-500">
                    {String(a.format).toUpperCase()} · {formatBytes(a.size)} · {t("edit.addOnSave")}
                  </div>
                </div>
                <button
                  className="text-xs text-stone-500 hover:text-red-600"
                  onClick={() => {
                    void api.discardStages([a.stageId]).catch(() => {});
                    setPendingAdds((prev) => prev.filter((x) => x.key !== a.key));
                  }}
                >
                  {t("edit.remove")}
                </button>
              </div>
            ))}
            {removedFiles.length > 0 && (
              <div className="flex items-center justify-between rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
                <span>{t("edit.removedN", { n: removedFiles.length, names: removedFiles.map((f) => f.name).join(", ") })}</span>
                <button className="text-amber-700 hover:underline" onClick={() => setRemoveIds(new Set())}>
                  {t("edit.undoAll")}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={cancel}>{t("common.cancel")}</Button>
          <Button onClick={() => void saveAll()} disabled={busy}>{busy ? t("common.saving") : t("common.save")}</Button>
        </div>
      </div>
    </Modal>
  );
}
