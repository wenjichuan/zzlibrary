import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatBytes, type FileDetail, type Package, type PackageDetail, type PackagePage } from "@zzlibrary/shared";
import PackageMetaForm, { metaFromPackage, metaToInput, type MetaFormValue } from "../components/PackageMetaForm";
import { Button, Empty, Input, Modal, PageHeader, Select, Spinner } from "../components/ui";
import { flatten, useCategories } from "../stores/categories";
import { useToast } from "../stores/toast";
import { prettyDate } from "../components/shelfVM";
import ReaderOverlay from "../components/ReaderOverlay";
import FileRow, { FORMAT_ICONS } from "../components/FileRow";
import { renderPdfCover } from "../utils/pdfCover";

const FORMATS = [
  "", "epub", "pdf", "txt", "md", "html", "docx", "pptx", "xlsx",
  "mp4", "webm", "mov", "mkv", "mp3", "wav", "flac", "jpg", "png",
];
const STATUSES = ["", "未读", "在读", "已读"];
const SORTS: Record<string, string> = {
  newest: "最新入库",
  oldest: "最早入库",
  title: "名称",
  date_asc: "时间 ↑",
  date_desc: "时间 ↓",
};

/** 页码直达输入框：原「第几页 / 总页数」位置——键入页数回车（或失焦）跳转，越界夹取到 [1, totalPages]，非数字忽略 */
function PageJump({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
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
        aria-label="跳转到指定页"
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

function formatPath(p: { l1?: { name: string } | null; l2?: { name: string } | null; l3?: { name: string } | null }): string {
  return [p.l1?.name, p.l2?.name, p.l3?.name].filter(Boolean).join("/");
}

export default function PackagesPage() {
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
  const [editing, setEditing] = useState<PackageDetail | null>(null);
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [reading, setReading] = useState<FileDetail | null>(null);
  const { push } = useToast();
  const loadCategories = useCategories((s) => s.load);
  const tree = useCategories((s) => s.tree);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.listPackages({ ...filters, page, page_size: 20 });
      setData(resp);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [filters, page, push]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setPage(1), [filters]);

  const { l1, l2 } = flatten(tree);
  const l1Node = l1.find((n) => String(n.id) === filters.l1);
  const l2Options = filters.l1 ? (l1Node?.children ?? []) : [];
  const l3Options = (() => {
    const n = l2.find((x) => String(x.id) === filters.l2);
    return filters.l2 ? (n?.children ?? []) : [];
  })();

  const openDetailById = async (id: number) => {
    try {
      setDetail(await api.getPackage(id));
    } catch {
      /* 刷新失败保持旧态 */
    }
  };

  const openDetail = async (pkg: Package) => {
    try {
      setDetail(await api.getPackage(pkg.id));
    } catch (err) {
      push("error", err instanceof Error ? err.message : "加载失败");
    }
  };

  const openEdit = async (pkg: Package) => {
    try {
      setEditing(await api.getPackage(pkg.id));
    } catch (err) {
      push("error", err instanceof Error ? err.message : "加载失败");
    }
  };

  const remove = async (pkg: Package) => {
    if (!window.confirm(`确定删除资料包「${pkg.title}」？包内 ${pkg.file_count} 个文件会一并删除。`)) return;
    try {
      await api.deletePackage(pkg.id);
      push("success", "已删除");
      void load();
    } catch (err) {
      push("error", err instanceof Error ? err.message : "删除失败");
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <PageHeader
        title="资料包"
        actions={
          <Button variant="outline" onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          className="w-56"
          placeholder="搜索包名/作者/备注…"
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && setPage(1)}
        />
        <Select className="w-32" value={filters.l1} onChange={(e) => setFilters((f) => ({ ...f, l1: e.target.value, l2: "", l3: "" }))}>
          <option value="">全部分类</option>
          {l1.map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
          <option value="none">未分类</option>
        </Select>
        {filters.l1 && (
          <Select className="w-32" value={filters.l2} onChange={(e) => setFilters((f) => ({ ...f, l2: e.target.value, l3: "" }))}>
            <option value="">全部二级</option>
            {l2Options.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </Select>
        )}
        {filters.l2 && (
          <Select className="w-32" value={filters.l3} onChange={(e) => setFilters((f) => ({ ...f, l3: e.target.value }))}>
            <option value="">全部三级</option>
            {l3Options.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </Select>
        )}
        <Select className="w-28" value={filters.format} onChange={(e) => setFilters((f) => ({ ...f, format: e.target.value }))}>
          {FORMATS.map((f) => (
            <option key={f} value={f}>{f ? `${FORMAT_ICONS[f] ?? ""} ${f.toUpperCase()}` : "全部格式"}</option>
          ))}
        </Select>
        <Select className="w-24" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s || "全部状态"}</option>
          ))}
        </Select>
        <Select className="w-28" value={filters.undated} onChange={(e) => setFilters((f) => ({ ...f, undated: e.target.value }))}>
          <option value="">全部时间</option>
          <option value="1">未注明时间</option>
        </Select>
        <Select className="w-28" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}>
          {Object.entries(SORTS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </Select>
      </div>

      {loading && !data ? (
        <Spinner />
      ) : !data || data.items.length === 0 ? (
        <Empty icon="📦" title="还没有资料包" hint="到「入库」页上传文件，多个文件可以合并成一个包" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-xs text-stone-500">
                <th className="w-14 px-4 py-3">封面</th>
                <th className="px-4 py-3">包名</th>
                <th className="px-4 py-3">分类</th>
                <th className="w-28 px-4 py-3">时间</th>
                <th className="w-16 px-4 py-3">状态</th>
                <th className="w-28 px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((pkg) => (
                <tr key={pkg.id} className="border-b border-stone-100 last:border-0 hover:bg-amber-50/40">
                  <td className="px-4 py-2.5">
                    <img
                      src={api.packageCoverUrl(pkg.id)}
                      alt=""
                      className="h-14 w-10 cursor-pointer rounded object-cover"
                      onClick={() => void openDetail(pkg)}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="max-w-md truncate font-medium text-stone-800" title={pkg.title}>
                      {pkg.title}
                    </div>
                    <div className="text-xs text-stone-500">
                      {pkg.authors.join("，") || "—"} · {pkg.file_count} 个文件 · {formatBytes(pkg.total_size)}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-stone-600">
                    {pkg.classifications.length > 0 ? (
                      <span title={pkg.classifications.map(formatPath).join("\n")}>
                        {pkg.classifications.map(formatPath).join(" · ")}
                      </span>
                    ) : (
                      <span className="text-stone-400">未分类</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-stone-600">{prettyDate(pkg.publish_date)}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        pkg.status === "已读"
                          ? "bg-emerald-100 text-emerald-700"
                          : pkg.status === "在读"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-stone-100 text-stone-500"
                      }`}
                    >
                      {pkg.status || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs">
                    <button className="mr-2 text-stone-500 hover:text-amber-700" onClick={() => void openEdit(pkg)}>
                      编辑
                    </button>
                    <button className="text-stone-500 hover:text-red-600" onClick={() => void remove(pkg)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-stone-200 px-4 py-3 text-xs text-stone-500">
            <span>共 {data.total} 包</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ← 上一页
              </Button>
              <PageJump page={data.page} totalPages={totalPages} onPage={setPage} />
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                下一页 →
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
          onRead={(file) => setReading(file)}
          onRefresh={() => void openDetailById(detail.id)}
        />
      )}
      {reading !== null && detail !== null && (
        <ReaderOverlay
          pkgTitle={detail.title}
          file={reading}
          initialProgress={reading.progress}
          onClose={() => {
            setReading(null);
            void load(); // 阅读结束刷新列表——状态列随进度重算更新，无需重进页面
          }}
          onProgress={() => void openDetailById(detail.id)}
        />
      )}
      {editing && (
        <EditModal
          detail={editing}
          onClose={() => setEditing(null)}
          onSaved={(fresh) => {
            setEditing(fresh ? { ...editing, ...fresh } : null);
            void load();
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
  onRefresh,
}: {
  detail: PackageDetail;
  onClose: () => void;
  onEdit: () => void;
  onRead: (file: FileDetail) => void;
  onRefresh: () => void;
}) {
  const { push } = useToast();
  const [releasing, setReleasing] = useState(false);
  const lastRead = [...detail.files]
    .filter((f) => f.progress !== null)
    .sort((a, b) => (b.progress!.updated_at < a.progress!.updated_at ? -1 : 1))[0] ?? null;
  const anyLocal = detail.files.some((f) => f.local !== false);

  const release = async () => {
    setReleasing(true);
    try {
      const r = await api.releasePackage(detail.id);
      push("success", `已释放 ${r.releasedFiles} 个文件（${formatBytes(r.freedBytes)}），阅读时会自动从云端取回`);
      onRefresh();
    } catch (err) {
      push("error", err instanceof Error ? err.message : "释放失败");
    } finally {
      setReleasing(false);
    }
  };
  return (
    <Modal title="资料包详情" onClose={onClose} wide>
      <div className="grid grid-cols-[160px_1fr] gap-5">
        <div>
          <img src={api.packageCoverUrl(detail.id)} alt="" className="h-52 w-40 rounded-lg object-cover shadow" />
        </div>
        <div className="min-w-0 space-y-2 text-sm">
          <div className="text-base font-semibold text-stone-800">{detail.title}</div>
          <Info label="作者" value={detail.authors.join("，") || "—"} />
          <Info
            label="分类"
            value={detail.classifications.length > 0 ? detail.classifications.map(formatPath).join(" · ") : "未分类"}
          />
          <Info label="发布时间" value={prettyDate(detail.publish_date)} />
          {detail.publisher && <Info label="发布方" value={detail.publisher} />}
          <Info
            label="体量"
            value={`${detail.file_count} 个文件 · ${formatBytes(detail.total_size)}`}
          />
          <Info label="状态" value={detail.status || "—"} />
          {detail.tags.length > 0 && <Info label="标签" value={detail.tags.join("，")} />}
          {detail.notes && <Info label="备注" value={detail.notes} />}
          <div className="pt-2">
            <Button variant="outline" size="sm" onClick={onEdit}>
              编辑
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-4">
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
          {anyLocal && detail.can_release === true && (
            <button className="text-xs text-stone-400 hover:text-red-600" disabled={releasing} onClick={() => void release()}>
              {releasing ? "释放中…" : "释放本地空间"}
            </button>
          )}
        </div>
        <div className="space-y-2">
          {detail.files.map((f) => (
            <FileRow key={f.id} file={f} showProgress onRead={onRead} />
          ))}
        </div>
      </div>
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
    for (const file of Array.from(list)) {
      try {
        const cover = file.name.toLowerCase().endsWith(".pdf") ? await renderPdfCover(file) : null;
        const staged = await api.stageFile(file, cover);
        setPendingAdds((prev) => [
          ...prev,
          {
            key: `${Date.now()}-${file.name}`,
            stageId: staged.stage_id,
            name: staged.filename,
            format: staged.format,
            size: staged.size,
          },
        ]);
      } catch (err) {
        push("error", `${file.name}：${err instanceof Error ? err.message : "上传失败"}`);
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
    if (!window.confirm(`标记移除「${f.name}」？（保存时生效，取消编辑可撤销）`)) return;
    setRemoveIds((prev) => new Set(prev).add(f.id));
  };

  const removedFiles = files.filter((f) => removeIds.has(f.id));

  const saveAll = async () => {
    if (!title.trim() && !willBeEmpty) {
      push("error", "包名不能为空");
      return;
    }
    if (willBeEmpty && !window.confirm("包内已无文件：保存将删除整个资料包（含元数据与分类），确定？")) {
      return;
    }
    setBusy(true);
    try {
      if (willBeEmpty) {
        await api.deletePackage(detail.id);
        push("success", "包内已无文件，资料包已删除");
        onSaved(null);
        return;
      }
      for (const f of removedFiles) {
        await api.deletePackageFile(detail.id, f.id);
      }
      for (const a of pendingAdds) {
        await api.addPackageFile(detail.id, a.stageId);
      }
      setPendingAdds([]); // 已入包，暂存被后端清除
      await api.updatePackage(detail.id, metaToInput({ ...form, title }));
      push("success", "已保存");
      onSaved(null);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "保存失败（部分改动可能已生效，请重试）");
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
      push("error", err instanceof Error ? err.message : "重命名失败");
    }
  };

  return (
    <Modal title="编辑资料包" onClose={cancel} wide>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-sm font-medium text-stone-700">包名</div>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <PackageMetaForm value={form} onChange={setForm} />
        {/* 状态不再可编辑：由文件阅读进度自动推导（不可读格式中性不参与） */}

        <div className="rounded-xl border border-stone-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-stone-700">
              包内文件（{finalCount}）
              {willBeEmpty && <span className="ml-2 text-xs font-normal text-red-600">保存将删除整个资料包</span>}
            </span>
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              ＋ 添加文件
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
            文件增删在保存时生效；点「取消」全部撤销（新文件的暂存立即删除）
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
                    <Button size="sm" onClick={() => void saveRename()}>保存</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>取消</Button>
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
                      重命名
                    </button>
                    <button className="text-xs text-stone-500 hover:text-red-600" onClick={() => markRemove(f)}>
                      移除
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
                    {String(a.format).toUpperCase()} · {formatBytes(a.size)} · 保存时加入
                  </div>
                </div>
                <button
                  className="text-xs text-stone-500 hover:text-red-600"
                  onClick={() => {
                    void api.discardStages([a.stageId]).catch(() => {});
                    setPendingAdds((prev) => prev.filter((x) => x.key !== a.key));
                  }}
                >
                  移除
                </button>
              </div>
            ))}
            {removedFiles.length > 0 && (
              <div className="flex items-center justify-between rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
                <span>已标记移除 {removedFiles.length} 个：{removedFiles.map((f) => f.name).join("、")}</span>
                <button className="text-amber-700 hover:underline" onClick={() => setRemoveIds(new Set())}>
                  全部撤销
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={cancel}>取消</Button>
          <Button onClick={() => void saveAll()} disabled={busy}>{busy ? "保存中…" : "保存"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-16 shrink-0 text-stone-400">{label}</span>
      <span className="text-stone-700">{value}</span>
    </div>
  );
}
