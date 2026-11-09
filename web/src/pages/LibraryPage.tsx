import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type FileDetail, type PackageDetail, type ShelvesDetail } from "@zzlibrary/shared/client";
import { AisleView } from "../components/aisleView";
import { TimelineView } from "../components/TimelineView";
import { useReaderOverlay } from "../components/ReaderOverlay";
import PackageDetailBody from "../components/PackageDetailBody";
import { buildRackVMs, l2KeyOfRack, type RackVM } from "../components/shelfVM";
import { Empty, Spinner } from "../components/ui";
import { useCategories } from "../stores/categories";
import { useToast } from "../stores/toast";
import { useT } from "../i18n/lang";

export default function LibraryPage() {
  const t = useT();
  const { l1Id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<ShelvesDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRack, setSelectedRack] = useState<string | null>(null);
  const [detailPkg, setDetailPkg] = useState<PackageDetail | null>(null);
  const [rackVMs, setRackVMs] = useState<Map<string, RackVM>>(new Map());
  const tree = useCategories((s) => s.tree);
  const loadCategories = useCategories((s) => s.load);
  const { push } = useToast();
  // 请求代际：切分类后旧请求的迟到响应一律丢弃（污染新库的架缓存/详情抽屉）
  const reqGen = useRef(0);
  // 各架时间轴横向滚动位置记忆（l2 key → scrollLeft）：出架再回来接着读
  const rackScroll = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    if (!l1Id) return;
    const gen = ++reqGen.current;
    setLoading(true);
    setLoadError(null);
    // 清旧库：避免切换期间闪现上一个分类的书架、失败后停留在错误的库
    setData(null);
    setSelectedRack(null);
    setDetailPkg(null);
    setRackVMs(new Map());
    // 概览轻载荷（SQL 聚合计数，零包体）——进架才按组拉包
    api
      .shelvesOverview(Number(l1Id))
      .then((d) => {
        if (reqGen.current !== gen) return;
        setData(d);
      })
      .catch((err) => {
        if (reqGen.current !== gen) return;
        // 网络失败≠分类不存在：给真错误态而非误导性空态
        setLoadError(err instanceof Error ? err.message : t("common.loadFail"));
        push("error", err instanceof Error ? err.message : t("common.loadFail"));
      })
      .finally(() => {
        if (reqGen.current === gen) setLoading(false);
      });
  }, [l1Id, push]);

  const l1 = tree.find((n) => n.id === Number(l1Id));
  const racks = useMemo(() => (data ? buildRackVMs(data) : []), [data]);
  const currentL2Key = selectedRack !== null ? l2KeyOfRack(selectedRack) : null;
  const currentRack = currentL2Key !== null ? (rackVMs.get(currentL2Key) ?? null) : null;

  const handleRackSelect = (key: string) => {
    setSelectedRack(key);
    const l2key = l2KeyOfRack(key);
    if (rackVMs.has(l2key)) return;
    const gen = reqGen.current;
    api
      .shelfRack(Number(l1Id), l2key)
      .then((d) => {
        if (reqGen.current !== gen) return;
        const vm = buildRackVMs(d).find((r) => l2KeyOfRack(r.key) === l2key) ?? null;
        if (vm !== null) setRackVMs((prev) => new Map(prev).set(l2key, vm));
      })
      .catch((err) => {
        if (reqGen.current !== gen) return;
        setSelectedRack(null); // 失败退回侧视——避免卡在「正在上架…」且无返回按钮
        push("error", err instanceof Error ? err.message : t("common.loadFail"));
      });
  };

  const openPackage = async (pkgId: number) => {
    const gen = reqGen.current;
    try {
      const fresh = await api.getPackage(pkgId);
      if (reqGen.current !== gen) return;
      setDetailPkg(fresh);
      // 就地补丁架缓存里该包的状态——时间轴悬停卡不再陈旧（②）
      setRackVMs((prev) => patchPackageStatus(prev, pkgId, fresh.status));
    } catch (err) {
      if (reqGen.current !== gen) return;
      push("error", err instanceof Error ? err.message : t("common.loadFail"));
    }
  };

  const { openReader, readerNode } = useReaderOverlay(detailPkg, openPackage);

  // Esc 关详情抽屉（与 Modal 同款语义）
  useEffect(() => {
    if (detailPkg === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailPkg(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detailPkg]);

  if (loading && !data) {
    return <Spinner text={t("lib.building")} />;
  }

  if (loadError !== null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty
          icon="📡"
          title={t("lib.loadFailTitle")}
          hint={t("lib.loadFailHint", { msg: loadError })}
        />
      </div>
    );
  }

  if (!data || racks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty
          icon="🏛"
          title={l1 ? t("lib.emptyTitle", { name: l1.name }) : t("lib.noCat")}
          hint={t("lib.emptyHint")}
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
                {t("lib.nGroups", { name: n.name, n: n.children.length })}
              </option>
            ))}
            {tree.length === 0 && <option value={l1Id}>{data.l1.name}</option>}
          </select>
          <span className="text-sm font-semibold text-stone-700">{data.l1.name}</span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">{t("common.nPkgs", { n: data.total })}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {([["aisle", t("lib.viewAisle")], ["timeline", t("lib.viewTimeline")]] as const).map(([key, label]) => {
            const active = key === "aisle" ? !currentRack : !!currentRack;
            return (
              <span
                key={key}
                className={`rounded-lg px-3 py-1.5 ${
                  active ? "bg-amber-700 text-white" : "bg-white text-stone-500 border border-stone-200"
                } ${key === "timeline" && !currentRack ? "opacity-50" : ""}`}
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
            initialScrollX={rackScroll.current.get(currentL2Key ?? "") ?? 0}
            onScrollX={(x) => {
              if (currentL2Key !== null) rackScroll.current.set(currentL2Key, x);
            }}
          />
        ) : selectedRack !== null ? (
          <div className="flex h-full items-center justify-center text-sm text-stone-400">{t("lib.racking")}</div>
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
  const t = useT();
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full flex-col overflow-y-auto border-l border-stone-200 bg-white/95 shadow-2xl backdrop-blur sm:w-96">
      <div className="sticky top-0 flex items-center justify-between border-b border-stone-200 bg-white px-4 py-3">
        <h3 className="truncate text-sm font-semibold text-stone-800">{t("lib.drawerTitle")}</h3>
        <button aria-label={t("lib.closeDetail")} className="rounded p-1.5 text-stone-400 hover:bg-stone-100" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="space-y-4 p-4">
        <PackageDetailBody detail={pkg} onRead={onRead} />
        <Link to="/packages" className="block text-center text-xs text-stone-500 hover:text-amber-700">
          {t("lib.manage")}
        </Link>
      </div>
    </div>
  );
}

/** 架缓存内就地补丁某包状态（读完/编辑后悬停卡不陈旧）；未命中或状态未变的架**原引用保留**——
 * rack 身份不变则 TimelineView 的 floorAxes/弹性长卷 memo 命中，不触发全卷重算重渲染。 */
function patchPackageStatus(prev: Map<string, RackVM>, pkgId: number, status: string): Map<string, RackVM> {
  const next = new Map<string, RackVM>();
  for (const [key, vm] of prev) {
    const hit = vm.floors.some((f) => f.dated.some((p) => p.id === pkgId) || f.undated.some((p) => p.id === pkgId));
    if (!hit) {
      next.set(key, vm);
      continue;
    }
    const unchanged = vm.floors.every(
      (f) =>
        f.dated.every((p) => p.id !== pkgId || p.status === status) &&
        f.undated.every((p) => p.id !== pkgId || p.status === status),
    );
    if (unchanged) {
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
