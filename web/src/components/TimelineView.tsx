/** 时间轴视图（X-Z · 书架正面）· 方案 C：弹性时间轴长卷。

布局引擎在 timelineLayout.ts（共享弹性映射，建卷一次）；本文件只管交互与渲染：
- **拖拽 = 原生滚动**（横向 1:1 跟手、纵向滚层；>4px 吞 click 防误触）；书脊位置建卷时定死，
  进出只由视口边缘决定——不闪现、不消失、不挪窝；
- 点左侧架签选段跳转（滚动定位）；书脊大小变化重建长卷；
- 楼层纵向窗口化 + 横向按视口裁剪；空档窄条悬停示年跨。 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { api, type ShelfPackage, type ShelfSegment } from "@zzlibrary/shared/client";
import { usePanToScroll } from "../hooks/panScroll";
import { ViewHint } from "./ui";
import {
  SERIF,
  dayOf,
  placeholderColor,
  prettyDate,
  toUtc,
  yearLabel,
  yearNum,
  yearOf,
  type FloorVM,
  type RackVM,
} from "./shelfVM";
import {
  LABEL_W,
  SPINE_W,
  buildElasticAxis,
  buildFloorAxis,
  ingestSegments,
  textWidth,
  timeAtX,
  withIngestCounts,
  type BandLayout,
  type ElasticAxis,
  type PlacedSpine,
} from "./timelineLayout";

interface SpineHoverHandlers {
  onEnter: (pkg: ShelfPackage, e: MouseEvent) => void;
  onMove: (pkg: ShelfPackage, e: MouseEvent) => void;
  onLeave: () => void;
}

/** 立柱宽 = 架签列 + 左留白。留白是视图层概念（引擎输出的长卷坐标不含它）。 */
const RAIL_W = LABEL_W + 20;

function Spine({
  pkg,
  left,
  bottom,
  width,
  height,
  onPackageClick,
  hover,
}: {
  pkg: ShelfPackage;
  left: number;
  bottom: number;
  width: number;
  height: number;
  onPackageClick: (id: number) => void;
  hover: SpineHoverHandlers;
}) {
  const year = pkg.publish_date ? yearLabel(yearNum(pkg.publish_date)) : "";
  return (
    <button
      title={`${pkg.title}${pkg.publish_date ? `（${year}）` : ""}`}
      onClick={() => {
        hover.onLeave(); // 点击开详情即收卡——预览卡（z-50）不得盖住详情抽屉（z-30），也不留 250ms 悬停计时器
        onPackageClick(pkg.id);
      }}
      onMouseEnter={(e) => hover.onEnter(pkg, e)}
      onMouseMove={(e) => hover.onMove(pkg, e)}
      onMouseLeave={hover.onLeave}
      className="group/spine absolute overflow-hidden rounded-[2px] transition-transform hover:z-10 hover:-translate-y-1.5 hover:shadow-[0_8px_16px_rgba(60,40,10,0.4)]"
      style={{
        left,
        bottom,
        width,
        height,
        background: placeholderColor(pkg.id),
        boxShadow: "0 2px 4px rgba(70,50,20,0.35)",
      }}
    >
      <img
        src={api.packageSpineUrl(pkg.id)}
        alt={pkg.title}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover object-top"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
      {pkg.file_count > 1 && (
        <span className="absolute inset-x-0 bottom-0 bg-black/35 text-center text-[8px] leading-3 text-white">
          {pkg.file_count}
        </span>
      )}
    </button>
  );
}

/** 架签点击弹出的时间段列表（新→旧，含包数；无轴上位置的行不进列表）。 */
function FloorSegMenu({
  floor,
  segments,
  onPick,
  onClose,
}: {
  floor: FloorVM;
  segments: ShelfSegment[];
  onPick: (seg: ShelfSegment) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        className="absolute left-0 top-0 z-40 max-h-72 w-56 overflow-auto rounded-lg border border-wood-line bg-wood-cream py-1 shadow-xl"
        style={{ left: LABEL_W + 6 }}
      >
        <div className="px-3 py-1 text-[10px] text-wood-mid">
          {floor.label} · 时间段（新→旧）
        </div>
        {[...segments]
          .filter((s) => s.end) // 无日期段（未注明时间/其他）无轴上位置，不进跳转列表
          .reverse()
          .map((seg) => (
            <button
              key={seg.key}
              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-wood-ink hover:bg-wood-badge"
              onClick={() => onPick(seg)}
            >
              <span>
                {seg.label}
                {seg.alias ? `（${seg.alias}）` : ""}
              </span>
              <span className="text-[10px] text-wood-mid">{seg.count} 包</span>
            </button>
          ))}
      </div>
    </>
  );
}

/** 书脊悬停预览卡内容。 */
function SpinePreviewCard({ pkg, axis }: { pkg: ShelfPackage; axis: "publish" | "ingest" }) {
  return (
    <div
      className="pointer-events-none flex gap-2.5 rounded-lg border border-wood-line bg-white/95 p-2.5 shadow-xl"
      style={{ width: 228 }}
    >
      <img
        src={api.packageCoverUrl(pkg.id)}
        alt=""
        className="h-[86px] w-[60px] shrink-0 rounded object-cover shadow"
      />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-xs font-semibold leading-4 text-stone-800">
          {pkg.title}
        </div>
        <div className="mt-1 truncate text-[10px] text-stone-500">
          {pkg.authors.join("，") || "佚名"}
        </div>
        <div className="text-[10px] text-stone-500">
          {axis === "ingest" ? `入库 ${dayOf(pkg.created_at)}` : prettyDate(pkg.publish_date)}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1 text-[9px]">
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-amber-800">
            {pkg.file_count} 文件
          </span>
          <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-stone-600">{pkg.status}</span>
        </div>
      </div>
    </div>
  );
}

/** 悬停卡宿主（叶组件 + imperative API）：显示/换书/跟手全由 ref 直驱，
 * 不经过 TimelineView 的 state——换悬停书目时整条时间轴零重渲染；
 * 换书重挂首帧先按最近指针定位再上屏（无 (0,0) 闪现）。 */
export interface HoverCardApi {
  show: (pkg: ShelfPackage, x: number, y: number) => void;
  hide: () => void;
  move: (x: number, y: number) => void;
}
const SpineHoverCard = forwardRef<HoverCardApi, { axis: "publish" | "ingest" }>(
  function SpineHoverCard({ axis }, ref) {
    const [pkg, setPkg] = useState<ShelfPackage | null>(null);
    const elRef = useRef<HTMLDivElement | null>(null);
    const pos = useRef({ x: 0, y: 0 });
    const apply = () => {
      const el = elRef.current;
      if (el === null) return;
      el.style.left = `${Math.min(pos.current.x + 14, window.innerWidth - 240)}px`;
      el.style.top = `${Math.max(8, pos.current.y - 16)}px`;
    };
    useLayoutEffect(() => {
      if (pkg !== null) apply(); // 挂载/换书首帧：定位先于上屏
    }, [pkg]);
    useImperativeHandle(
      ref,
      () => ({
        show: (p, x, y) => {
          pos.current = { x, y };
          setPkg(p); // 同引用 bail-out，不重渲染
        },
        hide: () => setPkg(null),
        move: (x, y) => {
          pos.current = { x, y };
          apply();
        },
      }),
      [],
    );
    if (pkg === null) return null;
    return (
      <div ref={elRef} className="pointer-events-none fixed z-50" style={{ left: 0, top: 0 }}>
        <SpinePreviewCard pkg={pkg} axis={axis} />
      </div>
    );
  },
);

export function TimelineView({
  rack,
  onBack,
  onPackageClick,
  initialScrollX = 0,
  onScrollX,
}: {
  rack: RackVM;
  onBack: () => void;
  onPackageClick: (pkgId: number) => void;
  /** 进架时恢复的横向滚动位置（LibraryPage 按架记忆，返回侧视再进来不丢位置） */
  initialScrollX?: number;
  /** 滚动时实时上报横向位置（供记忆——卸载时机不可靠：passive cleanup 时 ref 已摘、节点可能已换） */
  onScrollX?: (x: number) => void;
}) {
  const [scale, setScale] = useState(1); // 书脊大小缩放（按钮，物理尺寸；变化后重建长卷）
  const [axis, setAxis] = useState<"publish" | "ingest">("publish"); // X 轴模式：发布时间 / 入库时间
  const [segMenu, setSegMenu] = useState<number | null>(null); // 左侧架签的段选择弹层（层序号 | null）
  const scrollRef = useRef<HTMLDivElement>(null); // 长卷横向滚动容器（内层）
  const outerRef = useRef<HTMLDivElement>(null); // 纵向滚动容器（外层，含立柱+长卷）
  const floorsRef = useRef<HTMLDivElement>(null);

  const effRange = axis === "ingest" ? rack.ingestRange : rack.range;
  const fullT0 = effRange?.start != null ? toUtc(effRange.start) : 0;
  const fullT1 = effRange?.end != null ? toUtc(effRange.end) : 1;

  // 每层的轴数据：一次性预计算（书序/键毫秒），切架/切轴时才重建
  const floorAxes = useMemo(() => {
    const ingestSegs = rack.ingestRange ? ingestSegments(rack.ingestRange) : [];
    return rack.floors.map((floor) => {
      // 反向长卷：左 = 最新；升序数组反转得时间降序
      const books = [...(axis === "ingest" ? floor.ingest : floor.dated)].reverse();
      const segments =
        axis === "ingest" ? withIngestCounts(ingestSegs, floor.ingest) : floor.segments;
      const keyOf =
        axis === "ingest"
          ? (p: ShelfPackage) => dayOf(p.created_at)
          : (p: ShelfPackage) => p.publish_date ?? "";
      return buildFloorAxis(floor, books, segments, keyOf, axis === "publish");
    });
  }, [rack, axis]);

  const spineW = Math.max(15, Math.round(SPINE_W * scale));
  const bookH = Math.round(150 * scale);

  // 弹性长卷：全架共享映射，建卷一次（书脊位置在此定死）
  const axisData: ElasticAxis | null = useMemo(
    () => (effRange ? buildElasticAxis(floorAxes, spineW) : null),
    [floorAxes, spineW, effRange],
  );
  const canvasW = axisData ? axisData.totalW : 0;

  // 拖拽 = 滚动（横向卷内层 1:1 跟手、纵向滚外层）；共享钩子（与排视图同一实现）
  const { onPanStart, onPanMove, onPanEnd } = usePanToScroll(
    { inner: scrollRef, outer: outerRef },
    // 程序性赋值 scrollLeft 在部分环境（IAB webview）不触发 scroll 事件——同步兜底更新视口状态；
    // 带相等性守卫（与滚动监听路径同款）：拖拽期间 ~60 move/s 不应等于 60 次全视图重渲染
    () => {
      const inner = scrollRef.current;
      const outer = outerRef.current;
      if (!inner || !outer) return;
      setVp((prev) =>
        prev.x === inner.scrollLeft && prev.y === outer.scrollTop
          ? prev
          : { ...prev, x: inner.scrollLeft, y: outer.scrollTop },
      );
    },
  );

  // 书脊 hover 预览卡（250ms 延迟，避免扫过时闪烁）。
  // 卡片是叶组件（SpineHoverCard，imperative API）——显示/换书/跟手全走 ref，
  // 时间轴视图根零重渲染；换书首帧先定位再上屏（无 (0,0) 闪现）。
  // 悬停只服务真鼠标（hover:hover 细指针）——触屏 tap 会派发合成鼠标事件：
  // 卡片左上角闪现（挂载竞态）→ 合成 mouseleave 立即清卡 → 卡片盖在手指下抢走 click（详情打不开）。
  // 触屏上点书脊直接走 onClick 开详情，不经过预览卡。
  const canHover =
    typeof window !== "undefined" &&
    window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;
  const hoverTimer = useRef<number | null>(null);
  const hoverCard = useRef<HoverCardApi | null>(null);
  // 卸载清残留定时器（250ms 窗口内退出视图不再打到已卸载组件）
  useEffect(() => () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
  }, []);
  const hoverHandlers = useMemo<SpineHoverHandlers>(
    () => ({
      onEnter: (pkg, e) => {
        if (!canHover) return;
        if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
        const x = e.clientX;
        const y = e.clientY;
        hoverTimer.current = window.setTimeout(() => hoverCard.current?.show(pkg, x, y), 250);
      },
      onMove: (pkg, e) => {
        if (!canHover) return;
        const h = hoverCard.current;
        if (h === null) return;
        h.move(e.clientX, e.clientY); // 跟手直改 DOM（state 仅在换书时变化且同引用 bail-out）
        h.show(pkg, e.clientX, e.clientY);
      },
      onLeave: () => {
        if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
        hoverCard.current?.hide();
      },
    }),
    [canHover],
  );

  // 滚动回调经 ref 取用（滚动监听只挂一次不重挂）
  const onScrollXRef = useRef(onScrollX);
  onScrollXRef.current = onScrollX;

  // 视口状态：纵向窗口化（外层 scrollTop/clientHeight）+ 横向裁剪（内层 scrollLeft/clientWidth）
  const [vp, setVp] = useState({ y: 0, x: 0, w: 1200, h: 1600, floorsTop: 0 });
  useEffect(() => {
    const inner = scrollRef.current;
    const outer = outerRef.current;
    const fl = floorsRef.current;
    if (!inner || !outer) return;
    const update = () => {
      // 立柱与长卷同一纵向文档流，行顶一致——floorsTop 以外层为基准
      const floorsTop = fl
        ? fl.getBoundingClientRect().top - outer.getBoundingClientRect().top + outer.scrollTop
        : 0;
      setVp((prev) =>
        prev.y === outer.scrollTop &&
        prev.x === inner.scrollLeft &&
        prev.w === inner.clientWidth &&
        prev.h === outer.clientHeight &&
        prev.floorsTop === floorsTop
          ? prev
          : { y: outer.scrollTop, x: inner.scrollLeft, w: inner.clientWidth, h: outer.clientHeight, floorsTop },
      );
    };
    // 滚动位置实时上报（滚动记忆走实时 Map.set，卸载时机不可靠）
    const reportScroll = () => onScrollXRef.current?.(inner.scrollLeft);
    update();
    inner.addEventListener("scroll", update, { passive: true });
    inner.addEventListener("scroll", reportScroll, { passive: true });
    outer.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(inner);
    ro.observe(outer);
    if (fl) ro.observe(fl);
    return () => {
      inner.removeEventListener("scroll", update);
      inner.removeEventListener("scroll", reportScroll);
      outer.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [rack.key]);

  // 首次进架：恢复记忆的滚动位置（无记忆=左缘最新端）；切轴仍回左缘（两种轴坐标不同源）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = initialScrollX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rack.key]);

  // 切轴回左缘——但跳过挂载首跑（否则会覆盖上面恢复的滚动位置）
  const axisInitRef = useRef(axis);
  useEffect(() => {
    if (axisInitRef.current === axis) return;
    axisInitRef.current = axis;
    const el = scrollRef.current;
    if (el) el.scrollLeft = 0;
  }, [axis]);

  // 层高（长卷模型：层高与视口无关）。立柱与长卷是两列各自渲染，行高必须由同一公式给定：
  // = max(层体内容高, 架签文字所需高, 空层最小高)——立柱行/长卷行/窗口化偏移三方共用
  const FLOOR_GAP = 8;
  const chipTextH = (fa: (typeof floorAxes)[number]) => {
    const label =
      fa.floor.label.length > 6 ? fa.floor.label.slice(0, 6) + "…" : fa.floor.label;
    const n = axis === "publish" ? fa.floor.dated.length : fa.floor.total;
    return textWidth(`${label}（${n}）`, 13) * 1.18 + 6; // vertical-rl 竖排：字高≈文本宽
  };
  // 层体高（有书=书高+10；空层=矮位 0.6 倍）——行高计算/立柱占位/层体渲染三处共用，公式单源
  const floorBodyH = (fa: (typeof floorAxes)[number]) => (fa.books.length > 0 ? bookH + 10 : bookH * 0.6);
  const rowHs = floorAxes.map((fa) => {
    const bodyH = floorBodyH(fa);
    return Math.max(bodyH + 22 + 18, chipTextH(fa), fa.books.length ? 0 : Math.max(bookH + 30, 84));
  });
  const offsets: number[] = [];
  let acc = 0;
  for (const h of rowHs) {
    offsets.push(acc);
    acc += h + FLOOR_GAP;
  }
  const floorsTotalH = Math.max(0, acc);

  const visTop = vp.y - vp.floorsTop - 200;
  const visBottom = visTop + vp.h + 400;
  let firstIdx = -1;
  let lastIdx = -1;
  rowHs.forEach((h, i) => {
    if (offsets[i] + h >= visTop && offsets[i] <= visBottom) {
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
    }
  });
  if (firstIdx < 0) {
    firstIdx = 0;
    lastIdx = rowHs.length - 1;
  }
  // 横向可见区间（内容坐标，±60px 缓冲；书脊/段带/空档线按此裁剪）
  const vx0 = vp.x - 60;
  const vx1 = vp.x + vp.w + 60;
  const inViewX = (x: number, w: number) => x + w >= vx0 && x <= vx1;

  // 头部「视口 X – Y」：反查长卷映射（长卷坐标=内层滚动坐标，无偏移）
  const viewT0 = axisData ? timeAtX(axisData, Math.max(0, vp.x)) : 0;
  const viewT1 = axisData ? timeAtX(axisData, vp.x + vp.w) : 0;

  const jumpToBand = (fi: number, seg: ShelfSegment) => {
    const el = scrollRef.current;
    const band: BandLayout | undefined = axisData?.bands[fi]?.find((b) => b.seg.key === seg.key);
    // 瞬时滚动：IAB 等 webview 对 smooth scrollTo / rAF 动画可能不执行
    if (el && band) el.scrollLeft = Math.max(0, band.left - 40);
    setSegMenu(null);
  };

  return (
    <div className="flex h-full flex-col bg-paper">
      {/* 头部 */}
      <div className="flex items-center gap-3 border-b border-paper-line bg-paper-deep/80 px-5 py-3">
        <button
          onClick={onBack}
          className="rounded-lg border border-wood-line bg-wood-cream px-3 py-1.5 text-xs text-wood-ink transition-colors hover:border-wood hover:bg-wood-cream-hover"
        >
          ← 返回侧视
        </button>
        <span className="text-sm font-semibold text-wood-deep" style={{ fontFamily: SERIF }}>
          {rack.label}
        </span>
        <span className="rounded-full bg-wood-badge px-2 py-0.5 text-xs text-wood-ink-soft">{rack.total} 包</span>
        {effRange && axisData && (
          <span className="hidden text-[11px] text-stone-400 md:inline zz-hide-short">
            {`视口 ${yearLabel(yearOf(viewT1))} – ${yearLabel(yearOf(viewT0))}（全范围 ${yearLabel(yearOf(fullT0))} – ${yearLabel(yearOf(fullT1))}）`}
          </span>
        )}
        {/* 轴模式切换：发布时间（各层独立分段）/ 入库时间（共用日历分段）——核心功能，全尺寸保留 */}
        <div className="ml-3 flex overflow-hidden rounded border border-wood-line text-[11px] leading-none">
          {(
            [
              ["publish", "按发布时间"],
              ["ingest", "按入库时间"],
            ] as const
          ).map(([mode, name]) => (
            <button
              key={mode}
              className={`px-2 py-1 transition-colors ${
                axis === mode
                  ? "bg-wood text-wood-cream"
                  : "bg-wood-cream text-wood-ink hover:bg-wood-cream-hover"
              }`}
              onClick={() => setAxis(mode)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1 text-xs text-stone-500">
          书脊
          <button
            aria-label="缩小书脊"
            className="rounded border border-wood-line bg-wood-cream px-3 py-1 text-wood-ink hover:border-wood"
            onClick={() => setScale((s) => Math.max(0.6, +(s - 0.2).toFixed(1)))}
          >
            －
          </button>
          <span className="w-8 text-center" aria-live="off">{Math.round(scale * 100)}%</span>
          <button
            aria-label="放大书脊"
            className="rounded border border-wood-line bg-wood-cream px-3 py-1 text-wood-ink hover:border-wood"
            onClick={() => setScale((s) => Math.min(2.0, +(s + 0.2).toFixed(1)))}
          >
            ＋
          </button>
        </div>
      </div>

      {/* 顶部：操作提示（放滚动区外——界面说明不随横滚滑动、不作为拖拽起点）；
          手机/矮视口隐藏（提示是鼠标语义，触屏不适用且挤占书脊高度） */}
      <ViewHint className="px-5 pb-1 text-[11px] leading-4 text-stone-500">
        拖拽=平移长卷 · 滚轮=上下浏览 · 悬停书脊=预览 · 点击书脊=详情 · 点架签=选段跳转
      </ViewHint>
      {/* 时间轴主体（M3.17 立柱出卷）：外层纵向滚动；内部两列——立柱（不随横向滚动）+ 长卷（内层横向滚动）。
          两列同一纵向文档流、共用 rowHs 行高 → 架签与层板天然同行对齐；无 sticky、无悬浮遮盖，
          长卷坐标=内层滚动坐标（无偏移换算）。触屏两轴原生滚动都放行，自定义拖拽兜底驱动两容器 */}
      <div
        ref={outerRef}
        className="min-h-0 flex-1 touch-pan-y overscroll-contain overflow-y-auto"
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerLeave={onPanEnd}
        onPointerCancel={onPanEnd}
      >
        <div className="flex py-3">
          {/* 立柱：轴区占位 + 各层竖排架签（普通列）。border-r=立板边线，层板底线左端搭在其上 */}
          <div
            className="shrink-0 border-r border-wood-line/70 bg-paper pl-5 pr-2"
            style={{ width: RAIL_W }}
          >
            {/* 与长卷「轴线(12) + mt-1(4)」等高的占位 */}
            <div style={{ height: 16 }} />
            {firstIdx > 0 && <div style={{ height: offsets[firstIdx] }} />}
            {floorAxes.slice(firstIdx, lastIdx + 1).map((fa, idx) => {
              const fi = firstIdx + idx;
              const floor = fa.floor;
              const bodyH = floorBodyH(fa);
              return (
                <div
                  key={fi}
                  className="relative flex items-center justify-center"
                  style={{ height: rowHs[fi], marginBottom: FLOOR_GAP }}
                >
                  {/* 竖排架签：点击/回车展开该层的时间段列表（跳转=滚动定位）——键盘可操作（role+tabIndex+Enter/Space） */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`选择「${floor.label}」的时间段`}
                    className="flex cursor-pointer items-center justify-center rounded-[3px] transition-colors hover:border-wood"
                    onClick={() => setSegMenu(segMenu === fi ? null : fi)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSegMenu(segMenu === fi ? null : fi);
                      }
                    }}
                    style={{
                      // minHeight（非 height）+ nowrap：放不下让架签长高，
                      // 绝不压缩折行——vertical-rl 折行后行序从右往左，视觉上字序会颠倒（埃及→及埃）
                      minHeight: Math.max(bodyH * 0.62, 56),
                      whiteSpace: "nowrap",
                      writingMode: "vertical-rl",
                      fontFamily: SERIF,
                      fontSize: 13,
                      letterSpacing: "0.12em",
                      color: "#4a3a22",
                      backgroundImage: "linear-gradient(180deg,#f6efdc,#eadfc2)",
                      border: "1px solid #c9b58c",
                      boxShadow: "0 1px 2px rgba(70,50,20,0.25)",
                    }}
                    title={
                      (axis === "publish" && floor.undated.length > 0
                        ? `另有 ${floor.undated.length} 本未注明时间，不在时间轴显示（资料包页可筛出补全） · `
                        : "") + "点击选择时间段"
                    }
                  >
                    {floor.label.length > 6 ? floor.label.slice(0, 6) + "…" : floor.label}
                    <span className="text-[10px] tracking-normal text-wood-mid">
                      （{axis === "publish" ? floor.dated.length : floor.total}）
                    </span>
                  </div>
                  {segMenu === fi && (
                    <FloorSegMenu
                      floor={floor}
                      segments={fa.segments}
                      onClose={() => setSegMenu(null)}
                      onPick={(seg) => jumpToBand(fi, seg)}
                    />
                  )}
                </div>
              );
            })}
            {lastIdx < floorAxes.length - 1 && (
              <div
                style={{
                  height: Math.max(0, floorsTotalH - (offsets[lastIdx] + rowHs[lastIdx] + FLOOR_GAP)),
                }}
              />
            )}
          </div>

          {/* 长卷（内层横向滚动）：顶部细轴线 + 各层体。长卷坐标与滚动坐标同源，
              段带/书脊/空档条直接用 x，无任何偏移换算 */}
          <div
            ref={scrollRef}
            data-testid="tl-inner"
            className="min-w-0 flex-1 overflow-x-auto [touch-action:pan-x_pan-y] overscroll-contain"
          >
            <div className="pr-5" style={{ width: canvasW ? canvasW + 20 : undefined }}>
              {/* 顶部细轴线（随长卷滚动，无刻度） */}
              {axisData && (
                <div
                  className="shrink-0 border-b-2 border-[#6d543c]"
                  style={{ width: canvasW, height: 12 }}
                />
              )}

              {/* 层（三级分类）：段带 + 书脊（长卷坐标）；纵向窗口化 + 横向裁剪 */}
              <div ref={floorsRef} className="relative mt-1" style={{ minHeight: floorsTotalH }}>
                {/* 时代空档：全层皆无书的年代压成窄条。命中区=整条空档列（24px，悬停高亮+title 示年跨），
                    别收窄到 1px 边框——title 悬停基本停不进去；z-10 盖过层体（定位元素 DOM 靠后） */}
                {axisData?.gaps
                  .filter((g) => inViewX(g.left, g.right - g.left))
                  .map((g, i) => (
                    <div
                      key={`gap${i}`}
                      className="absolute bottom-0 top-0 z-10 cursor-help border-l border-dashed border-[#8a6d4e]/60 hover:bg-[#8a6d4e]/10"
                      style={{ left: g.left, width: g.right - g.left }}
                      title={`${yearLabel(yearOf(g.startMs - 1))} → ${yearLabel(yearOf(g.endMs))} · ${Math.round((g.endMs - g.startMs) / 3.15576e10)} 年无产出或未收录`}
                    />
                  ))}

                {firstIdx > 0 && <div style={{ height: offsets[firstIdx] }} />}
                {floorAxes.slice(firstIdx, lastIdx + 1).map((fa, idx) => {
                  const fi = firstIdx + idx;
                  const floor = fa.floor;
                  const bodyH = floorBodyH(fa);
                  const bands = axisData?.bands[fi] ?? [];
                  const spines: PlacedSpine[] = axisData?.spines[fi] ?? [];
                  return (
                    <div key={fi} style={{ height: rowHs[fi], marginBottom: FLOOR_GAP }}>
                      {/* 层体：长卷一行（段带 + 书脊按视口横向裁剪） */}
                      {axisData && (
                        <div
                          className="relative shrink-0"
                          style={{
                            width: canvasW,
                            height: bodyH + 22 + 18,
                            backgroundImage:
                              "linear-gradient(180deg, rgba(255,250,235,0.28), rgba(120,95,60,0.08))",
                            boxShadow: "inset 0 2px 5px rgba(90,70,40,0.16)",
                          }}
                        >
                          {bands
                            // 0 包段带不渲染标签条：空段弹性宽度≈0，多条会塌进空档窄条里
                            // 叠成深色墙（自动按年分段 + 跨度大 + 书极少时一年一空段）；"该时代无书"
                            // 由空档条/段菜单表达即可
                            .filter((b) => b.count > 0 && inViewX(b.left, b.right - b.left))
                            .map((b) => {
                              const width = Math.max(2, b.right - b.left);
                              // 直接显示整串，能显示多少显示多少：放不下的部分由条带
                              // overflow-hidden 截断（用户拍板：不要降级顺序，也不借用邻条）。
                              // 完整信息始终在悬停 title / 段菜单里。
                              const text = b.seg.alias ? `${b.seg.label}（${b.seg.alias}）` : b.seg.label;
                              const textW = textWidth(text, 10.5);
                              return (
                                <div
                                  key={b.seg.key}
                                  className="absolute top-0 flex items-center overflow-hidden whitespace-nowrap border-l-2 px-1"
                                  style={{
                                    left: b.left,
                                    width,
                                    height: 22,
                                    fontFamily: SERIF,
                                    fontSize: 10.5,
                                    letterSpacing: "0.05em",
                                    color: "#f3e9d2",
                                    backgroundColor: "rgba(122, 92, 62, 0.85)",
                                    borderLeftColor: "#5c4530",
                                  }}
                                  title={`${b.seg.label}${b.seg.alias ? `（${b.seg.alias}）` : ""} · ${b.count} 包`}
                                >
                                  {/* 文字随视口在段带内滑移：滚进宽带内部（隋唐 1671px/拜占庭
                                      2300px+）仍恒可见；marginLeft 夹在 [0, 段宽-文字宽]，
                                      段尾过后随段滑出。（不用 sticky——overflow-hidden 条带盒
                                      会吞掉 sticky） */}
                                  <span
                                    style={{
                                      marginLeft: Math.max(
                                        0,
                                        Math.min(vp.x - b.left, width - textW - 10),
                                      ),
                                    }}
                                  >
                                    {text}
                                  </span>
                                </div>
                              );
                            })}

                          {spines.map(({ x, pkg }) =>
                            inViewX(x, spineW) ? (
                              <Spine
                                key={pkg.id}
                                pkg={pkg}
                                left={x}
                                bottom={12 + 9}
                                width={spineW}
                                height={bookH}
                                onPackageClick={onPackageClick}
                                hover={hoverHandlers}
                              />
                            ) : null,
                          )}

                          {floor.total === 0 && (
                            <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-[#b3a684]/70">
                              空
                            </span>
                          )}

                          {/* 层底隔板 */}
                          <div
                            className="pointer-events-none absolute inset-x-0 bottom-0 h-[9px]"
                            style={{
                              backgroundImage:
                                "linear-gradient(180deg,#b28e63 0%, #8a6a48 50%, #6f533a 100%)",
                              boxShadow:
                                "0 2px 3px rgba(60,40,15,0.3), inset 0 1px 0 rgba(255,240,210,0.3)",
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
                {lastIdx < floorAxes.length - 1 && (
                  <div
                    style={{
                      height: Math.max(0, floorsTotalH - (offsets[lastIdx] + rowHs[lastIdx] + FLOOR_GAP)),
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 底部：读图要领（随轴模式变化）——放滚动区外（放长卷列里会跟 canvasW 变窄折行）；手机/矮视口隐藏让位书脊 */}
      <ViewHint className="px-5 pb-2 pt-1 text-[11px] leading-4 text-stone-500">
        {axis === "publish"
          ? "弹性时间轴：书多的年代长、书少的年代短；跨层同列≈同一时代 · 空档=该时代无产出或未收录（悬停示年跨） · 未注明时间不上轴（资料包页可补全）"
          : "入库时间轴：所有层共用日历分段，同月同列"}
      </ViewHint>

      {/* 书脊悬停预览卡（叶组件，ref 直驱） */}
      <SpineHoverCard ref={hoverCard} axis={axis} />
    </div>
  );
}
