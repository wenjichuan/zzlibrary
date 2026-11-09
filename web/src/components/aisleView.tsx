/** 排视图（Y-Z · 书架侧面）：一架 = 一个二级分类的**书架侧面**——顶铜牌 + 整块木侧板
 * （看不见书）+ 横隔板板沿 + 板沿间插卡式标签牌（三级分类名 + 藏书数）→ 多架并排对比。 */
import { useEffect, useRef, useState } from "react";
import { usePanToScroll } from "../hooks/panScroll";
import { SERIF, type RackVM } from "./shelfVM";
import { t } from "../i18n/lang";
import { ViewHint } from "./ui";

const SIDE_W = 208; // 书架（侧视）宽 px
const BAND_H = 62; // 隔板之间的层档高 px

const AISLE_STEP = SIDE_W + 36; // 书架列步长（宽 + gap-9）

export function AisleView({
  racks,
  onRackSelect,
}: {
  racks: RackVM[];
  onRackSelect: (key: string) => void;
}) {
  const maxRackTotal = Math.max(...racks.map((r) => r.total), 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 书架横向窗口化：只渲染视口（±2 架）内的书架，两侧占位块撑住滚动条
  const [win, setWin] = useState<[number, number]>([0, racks.length]);
  // 程序性滚动（拖拽钩子写 scrollLeft）后的窗口同步兜底——部分 WebView 不触发 scroll 事件
  const syncWinRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const first = Math.max(0, Math.floor(el.scrollLeft / AISLE_STEP) - 2);
      const last = Math.min(racks.length, Math.ceil((el.scrollLeft + el.clientWidth) / AISLE_STEP) + 2);
      setWin((prev) => (prev[0] === first && prev[1] === last ? prev : [first, last]));
    };
    update();
    syncWinRef.current = update;
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      syncWinRef.current = () => undefined;
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [racks.length]);

  // 拖拽 = 滚动（与正面时间轴同一实现，共享钩子）；双轴同容器：inner/outer 指向同一滚动元素
  const { onPanStart, onPanMove, onPanEnd } = usePanToScroll(
    { inner: scrollRef, outer: scrollRef },
    () => syncWinRef.current(),
  );

  const [first, last] = win;
  return (
    <div className="flex h-full flex-col bg-paper">
      {/* 说明放滚动区外（界面文字不随横/纵滚动滑动，也不作为拖拽起点），与正面时间轴口径一致；手机/矮视口隐藏让位书架 */}
      <ViewHint className="px-8 pb-1 pt-5 text-[13px] text-stone-600" style={{ fontFamily: SERIF }}>
        {t("aisle.hint")}
      </ViewHint>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overscroll-contain overflow-auto"
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerLeave={onPanEnd}
        onPointerCancel={onPanEnd}
      >
        <div className="px-8 pb-4 pt-3">
          {/* 顶牌对齐：层数多的书架向下延伸，不破坏顶牌线的横向对比 */}
          <div className="flex items-start gap-9 pb-10">
            {first > 0 && <div className="shrink-0" style={{ width: first * AISLE_STEP - 36 }} />}
            {racks.slice(first, last).map((rack) => (
              <BookcaseSide
                key={rack.key}
                rack={rack}
                maxRackTotal={maxRackTotal}
                onSelect={() => onRackSelect(rack.key)}
              />
            ))}
            {last < racks.length && (
              <div className="shrink-0" style={{ width: (racks.length - last) * AISLE_STEP - 36 }} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 实体书架侧面：一整块侧板（看不见书），横隔板板沿一条条，
 * 每个层档贴一张插卡式标签牌（三级分类名 + 藏书数 + 数量填充条）。
 * 层数多的书架自然向下延伸（纵向滚动浏览）。 */
function BookcaseSide({
  rack,
  maxRackTotal,
  onSelect,
}: {
  rack: RackVM;
  maxRackTotal: number;
  onSelect: () => void;
}) {
  const maxFloorTotal = Math.max(...rack.floors.map((f) => f.total), 1);
  return (
    <button
      onClick={onSelect}
      className="group relative block shrink-0 rounded-[6px] p-0 text-left transition-all hover:-translate-y-1 hover:shadow-[0_14px_34px_rgba(74,54,26,0.3)]"
      style={{ width: SIDE_W }}
      title={t("aisle.enterRack", { name: rack.label })}
    >
      {/* 顶牌：二级分类名（铜牌）+ 数量填充条（相对全场最大书架） */}
      <div
        className="mx-auto mb-1 flex w-[88%] flex-col rounded-[4px] px-3 py-1.5"
        style={{
          fontFamily: SERIF,
          backgroundImage: "linear-gradient(180deg,#c9a86b,#a8874f)",
          border: "1px solid #8a6c3c",
          boxShadow:
            "inset 0 1px 0 rgba(255,240,200,0.5), inset 0 -1px 0 rgba(70,50,20,0.35), 0 1px 3px rgba(60,42,18,0.35)",
        }}
      >
        <span className="flex items-baseline justify-between">
          <span className="truncate text-[14px] font-semibold tracking-[0.08em] text-wood-deep">
            {rack.label}
          </span>
          <span className="ml-2 shrink-0 text-[10px] text-[#57431f]">{t("common.nPkgs", { n: rack.total })}</span>
        </span>
        <span
          className="mt-1 h-[3px] rounded-full bg-[#3d2c12]/55"
          style={{ width: `${Math.max(6, Math.round((rack.total / maxRackTotal) * 100))}%` }}
        />
      </div>

      {/* 整块木侧板 */}
      <div
        className="rounded-[5px]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(93deg, rgba(84,60,34,0.05) 0 2px, transparent 2px 9px), repeating-linear-gradient(0deg, rgba(255,244,220,0.045) 0 1px, transparent 1px 21px), linear-gradient(180deg,#a9865f, #8d6c47)",
          boxShadow:
            "0 2px 10px rgba(74,54,26,0.2), inset 3px 0 0 rgba(255,240,210,0.14), inset -3px 0 0 rgba(60,42,22,0.28)",
        }}
      >
        {/* 顶板沿 */}
        <BoardEdge />
        {/* 层档：板沿之间 = 一张插卡式标签牌（底部填充条=该架内相对藏书量） */}
        {rack.floors.map((floor, fi) => (
          <div key={fi}>
            <div className="flex items-center" style={{ height: BAND_H }}>
              <div
                className="mx-auto flex w-[82%] flex-col rounded-[3px] px-3 py-1.5"
                style={{
                  fontFamily: SERIF,
                  backgroundImage: "linear-gradient(180deg,#f8f1de,#eee1c4)",
                  border: "1px solid #c9b58c",
                  boxShadow: "inset 0 1px 0 rgba(255,252,240,0.8), 0 1px 2px rgba(70,50,20,0.3)",
                }}
                title={t("aisle.floorTitle", { name: floor.label, n: floor.total })}
              >
                <span className="flex items-baseline justify-between">
                  <span className="truncate text-[13px] tracking-[0.1em] text-wood-ink">
                    {floor.label}
                  </span>
                  <span className="ml-2 shrink-0 text-[11px] text-wood-mid">{floor.total}</span>
                </span>
                <span
                  className="mt-1 h-[3px] rounded-full bg-wood/70"
                  style={{
                    width: `${Math.max(5, Math.round((floor.total / maxFloorTotal) * 100))}%`,
                  }}
                />
              </div>
            </div>
            <BoardEdge />
          </div>
        ))}
        {/* 底座 */}
        <div
          className="h-[14px] rounded-b-[4px]"
          style={{
            backgroundImage: "linear-gradient(180deg,#8d6c47,#5f4529)",
            boxShadow: "0 3px 4px rgba(50,34,14,0.4)",
          }}
        />
      </div>

      <span className="pointer-events-none absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-[#3d2c12] px-2.5 py-0.5 text-[10px] text-amber-100 opacity-0 transition-opacity group-hover:opacity-100">
        {t("aisle.front")}
      </span>
    </button>
  );
}

/** 横隔板板沿（从侧面看到的一条窄木沿）。 */
function BoardEdge() {
  return (
    <div
      className="h-[9px]"
      style={{
        backgroundImage: "linear-gradient(180deg,#b28e63 0%, #8a6a48 55%, #6f533a 100%)",
        boxShadow: "0 2px 3px rgba(50,34,14,0.35), inset 0 1px 0 rgba(255,240,210,0.3)",
      }}
    />
  );
}
