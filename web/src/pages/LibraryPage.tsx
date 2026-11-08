import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type FileDetail, type PackageDetail, type ShelvesDetail } from "@zzlibrary/shared/client";
import { AisleView } from "../components/aisleView";
import { TimelineView } from "../components/TimelineView";
import { useReaderOverlay } from "../components/ReaderOverlay";
import PackageDetailBody from "../components/PackageDetailBody";
import { buildRackVMs, type RackVM } from "../components/shelfVM";
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
  const [rackVMs, setRackVMs] = useState<Map<string, RackVM>>(new Map());
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
    setRackVMs(new Map());
    // 概览轻载荷（SQL 聚合计数，零包体）——进架才按组拉包
    api
      .shelvesOverview(Number(l1Id))
      .then(setData)
      .catch((err) => push("error", err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [l1Id, push]);

  const l1 = tree.find((n) => n.id === Number(l1Id));
  const racks = useMemo(() => (data ? buildRackVMs(data) : []), [data]);
  /** 架 key（g<l2id>-<gi>）→ l2 标识（数字 id 或 "none"） */
  const l2KeyOf = (rackKey: string) => rackKey.split("-")[0]!.slice(1);
  const currentL2Key = selectedRack !== null ? l2KeyOf(selectedRack) : null;
  const currentRack = currentL2Key !== null ? (rackVMs.get(currentL2Key) ?? null) : null;

  const handleRackSelect = (key: string) => {
    setSelectedRack(key);
    const l2key = l2KeyOf(key);
    if (rackVMs.has(l2key)) return;
    api
      .shelfRack(Number(l1Id), l2key)
      .then((d) => {
        const vm = buildRackVMs(d).find((r) => l2KeyOf(r.key) === l2key) ?? null;
        if (vm !== null) setRackVMs((prev) => new Map(prev).set(l2key, vm));
      })
      .catch((err) => {
        setSelectedRack(null); // 失败退回侧视——避免卡在「正在上架…」且无返回按钮
        push("error", err instanceof Error ? err.message : "加载失败");
      });
  };

  const openPackage = async (pkgId: number) => {
    try {
      const fresh = await api.getPackage(pkgId);
      setDetailPkg(fresh);
      // 就地补丁架缓存里该包的状态——时间轴悬停卡不再陈旧（②）
      setRackVMs((prev) => patchPackageStatus(prev, pkgId, fresh.status));
    } catch (err) {
      push("error", err instanceof Error ? err.message : "加载失败");
    }
  };

  const { openReader, readerNode } = useReaderOverlay(detailPkg, openPackage);

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
      {/* 顶部栏：矮视口（横屏手机）且处于时间轴详情态时隐藏——工具栏已有「返回侧视」，整行让位书脊 */}
      <div
        className={
          "flex items-center justify-between border-b border-stone-200 bg-white/70 px-4 py-2.5 backdrop-blur" +
          (selectedRack !== null ? " zz-hide-short" : "")
        }
      >
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
        {currentRack !== null ? (
          <TimelineView
            rack={currentRack}
            onBack={() => setSelectedRack(null)}
            onPackageClick={(id) => void openPackage(id)}
          />
        ) : selectedRack !== null ? (
          <div className="flex h-full items-center justify-center text-sm text-stone-400">正在上架…</div>
        ) : (
          <AisleView racks={racks} onRackSelect={handleRackSelect} />
        )}

        {detailPkg && (
          <PackageDrawer
            pkg={detailPkg}
            onClose={() => setDetailPkg(null)}
            onRead={openReader}
          />
        )}
      </div>

      {readerNode}
    </div>
  );
}

function PackageDrawer({
  pkg,
  onClose,
  onRead,
}: {
  pkg: PackageDetail;
  onClose: () => void;
  onRead: (f: FileDetail) => void;
}) {
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full flex-col overflow-y-auto border-l border-stone-200 bg-white/95 shadow-2xl backdrop-blur sm:w-96">
      <div className="sticky top-0 flex items-center justify-between border-b border-stone-200 bg-white px-4 py-3">
        <h3 className="truncate text-sm font-semibold text-stone-800">包详情</h3>
        <button className="rounded p-1 text-stone-400 hover:bg-stone-100" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="space-y-4 p-4">
        <PackageDetailBody detail={pkg} onRead={onRead} />
        <Link to="/packages" className="block text-center text-xs text-stone-500 hover:text-amber-700">
          在资料包列表中管理 →
        </Link>
      </div>
    </div>
  );
}

/** 架缓存内就地补丁某包状态（读完/编辑后悬停卡不陈旧）；未命中的架原引用保留。 */
function patchPackageStatus(prev: Map<string, RackVM>, pkgId: number, status: string): Map<string, RackVM> {
  const next = new Map<string, RackVM>();
  for (const [key, vm] of prev) {
    const hit = vm.floors.some((f) => f.dated.some((p) => p.id === pkgId) || f.undated.some((p) => p.id === pkgId));
    if (!hit) {
      next.set(key, vm);
      continue;
    }
    next.set(key, {
      ...vm,
      floors: vm.floors.map((f) => ({
        ...f,
        dated: f.dated.map((p) => (p.id === pkgId ? { ...p, status } : p)),
        undated: f.undated.map((p) => (p.id === pkgId ? { ...p, status } : p)),
        ingest: f.ingest.map((p) => (p.id === pkgId ? { ...p, status } : p)),
      })),
    });
  }
  return next;
}
