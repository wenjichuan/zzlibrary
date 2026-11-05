import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, formatBytes, type PackageDetail, type ShelvesDetail } from "@zzlibrary/shared";
import { AisleView } from "../components/aisleView";
import { TimelineView } from "../components/TimelineView";
import { buildRackVMs, prettyDate } from "../components/shelfVM";
import { Empty, Spinner } from "../components/ui";
import { useCategories } from "../stores/categories";
import { useToast } from "../stores/toast";

export default function LibraryPage() {
  const { l1Id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<ShelvesDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedRack, setSelectedRack] = useState<string | null>(null);
  const [detailPkg, setDetailPkg] = useState<PackageDetail | null>(null);
  const tree = useCategories((s) => s.tree);
  const loadCategories = useCategories((s) => s.load);
  const { push } = useToast();

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    if (!l1Id) return;
    setLoading(true);
    setSelectedRack(null);
    setDetailPkg(null);
    api
      .shelvesDetail(Number(l1Id))
      .then(setData)
      .catch((err) => push("error", err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [l1Id, push]);

  const l1 = tree.find((n) => n.id === Number(l1Id));
  const racks = useMemo(() => (data ? buildRackVMs(data) : []), [data]);
  const currentRack = racks.find((r) => r.key === selectedRack) ?? null;

  const openPackage = async (pkgId: number) => {
    try {
      setDetailPkg(await api.getPackage(pkgId));
    } catch (err) {
      push("error", err instanceof Error ? err.message : "加载失败");
    }
  };

  if (loading && !data) {
    return <Spinner text="正在搭建书架…" />;
  }

  if (!data || racks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty
          icon="🏛"
          title={l1 ? `「${l1.name}」下还没有资料包` : "这个分类不存在"}
          hint="先到「入库」页上传资料包，并给它们挂上这个一级分类"
        />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between border-b border-stone-200 bg-white/70 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <select
            className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm"
            value={l1Id}
            onChange={(e) => navigate(`/shelves/${e.target.value}`)}
          >
            {tree.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}（{n.children.length} 组）
              </option>
            ))}
            {tree.length === 0 && <option value={l1Id}>{data.l1.name}</option>}
          </select>
          <span className="text-sm font-semibold text-stone-700">{data.l1.name}</span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">{data.total} 包</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {(["排视图", "时间轴"] as const).map((label) => {
            const active = label === "排视图" ? !currentRack : !!currentRack;
            return (
              <span
                key={label}
                className={`rounded-lg px-3 py-1.5 ${
                  active ? "bg-amber-700 text-white" : "bg-white text-stone-500 border border-stone-200"
                } ${label === "时间轴" && !currentRack ? "opacity-50" : ""}`}
              >
                {label}
              </span>
            );
          })}
        </div>
      </div>

      {/* 视图主体 */}
      <div className="relative min-h-0 flex-1">
        {currentRack ? (
          <TimelineView
            rack={currentRack}
            onBack={() => setSelectedRack(null)}
            onPackageClick={(id) => void openPackage(id)}
          />
        ) : (
          <AisleView racks={racks} onRackSelect={(key) => setSelectedRack(key)} />
        )}

        {detailPkg && <PackageDrawer pkg={detailPkg} onClose={() => setDetailPkg(null)} />}
      </div>
    </div>
  );
}

function PackageDrawer({ pkg, onClose }: { pkg: PackageDetail; onClose: () => void }) {
  const fmt = (p: { l1?: { name: string } | null; l2?: { name: string } | null; l3?: { name: string } | null }) =>
    [p.l1?.name, p.l2?.name, p.l3?.name].filter(Boolean).join("/");
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-96 flex-col overflow-y-auto border-l border-stone-200 bg-white/95 shadow-2xl backdrop-blur">
      <div className="sticky top-0 flex items-center justify-between border-b border-stone-200 bg-white px-4 py-3">
        <h3 className="truncate text-sm font-semibold text-stone-800">包详情</h3>
        <button className="rounded p-1 text-stone-400 hover:bg-stone-100" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="space-y-4 p-4">
        <div className="flex gap-3">
          <img src={api.packageCoverUrl(pkg.id)} alt="" className="h-40 w-28 rounded-lg object-cover shadow" />
          <div className="min-w-0 flex-1 space-y-1.5 text-xs">
            <div className="text-sm font-semibold text-stone-800">{pkg.title}</div>
            <Info label="作者" value={pkg.authors.join("，") || "—"} />
            <Info label="分类" value={pkg.classifications.map(fmt).join(" · ") || "未分类"} />
            <Info label="时间" value={prettyDate(pkg.publish_date)} />
            <Info label="体量" value={`${pkg.file_count} 文件 · ${formatBytes(pkg.total_size)}`} />
            <Info label="状态" value={pkg.status} />
            {pkg.tags.length > 0 && <Info label="标签" value={pkg.tags.join("，")} />}
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold text-stone-600">包内文件</div>
          <div className="space-y-1.5">
            {pkg.files.map((f) => (
              <a
                key={f.id}
                href={api.fileUrl(f.id)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between rounded-lg border border-stone-100 px-3 py-2 text-xs text-stone-700 hover:border-amber-500 hover:bg-amber-50"
              >
                <span className="truncate">{f.name}</span>
                <span className="ml-2 shrink-0 text-stone-400">{String(f.format).toUpperCase()}</span>
              </a>
            ))}
          </div>
        </div>
        <Link to="/packages" className="block text-center text-xs text-stone-500 hover:text-amber-700">
          在资料包列表中管理 →
        </Link>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-10 shrink-0 text-stone-400">{label}</span>
      <span className="min-w-0 break-words text-stone-700">{value}</span>
    </div>
  );
}
