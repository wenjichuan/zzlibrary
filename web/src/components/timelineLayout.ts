/** 时间轴布局引擎（纯函数，无 React）· 方案 C：弹性时间轴长卷。

模型（2026-11-05 定案，取代 M3.13e 的"时间窗 + 跨度自适应"）：
- 全架共享一条**弹性时间→x 映射**：逐区间尺度 s = max(横跨该区间的各层段带 内容宽/时长)，
  各层皆无书的时代空档压成固定窄条（GAP_W，悬停示年跨）——书多的年代长、书少的年代短、
  空档一划而过；
- 映射一次算定 → **长卷固定**：拖拽 = 原生滚动，书脊位置永不重排（不闪现、不消失、不挪窝），
  进出只由视口边缘决定；
- 段带宽 = 该段年代范围的弹性积分宽 ≥ 本层内容宽（尺度函数保证）→ **单行自然间距恒成立**，
  同一天几百本也只是段带变长，全部可读；
- 映射全层共享 → **跨层大致同期对齐**：隋唐被撑宽的年代区间，在东罗马行也是同样的 x 区间
  （区间级对齐，不是年份级——书在段内按日期比例落位）；
- 书在段带内**按日期比例落位 + 最小间距前推 + 右侧留量封顶**（三合一保证整链恒在段内）：密则自然间距铺满，疏则拉开、与同期他层大致同列；书归网格序首个命中段（镜像后端 index_for 闭区间，日历桶右开），同层交叠段（明/清共用 1644）的 x 领域随归属切平、不相交。

性能：建卷 O(书数 + 段数·log) 一次；滚动时布局零计算（浏览器原生滚动合成）。 */
import type { ShelfPackage, ShelfSegment } from "@zzlibrary/shared/client";
import { dayOf, toUtc, type FloorVM } from "./shelfVM";
import { t } from "../i18n/lang";

/* ---------- 常量 ---------- */

export const LABEL_W = 92; // 左侧竖排架签宽
export const SPINE_W = 24; // 统一书脊厚度（px，缩放前）
const GAP = 3; // 书脊间距
const GAP_W = 24; // 时代空档（各层皆无书）的固定窄条宽

/** 估算文本像素宽（CJK ≈ 字号，西文 ≈ 0.55 倍）。 */
export function textWidth(s: string, fontSize: number): number {
  return [...s].reduce(
    (w, ch) => w + (ch.charCodeAt(0) > 0x2e8f ? fontSize : fontSize * 0.55),
    0,
  );
}

/* ---------- 层的轴数据（一次性预计算） ---------- */

/** 一层在某轴模式下的预计算数据：显示序（时间降序）的书、对齐的键毫秒、分段。 */
export interface FloorAxis {
  floor: FloorVM;
  books: ShelfPackage[]; // 显示序：时间降序（最新在最前）
  ms: number[]; // 与 books 对齐（降序）
  segments: ShelfSegment[]; // 原样（架签段菜单等用；入库模式已带 count）
  endInclusive: boolean; // 段的 end 含义：发布轴自定义区间 end=最后一天（含）；入库轴日历桶 end=下一桶起点（不含）
}

export function buildFloorAxis(
  floor: FloorVM,
  books: ShelfPackage[], // 显示序（时间降序）
  segments: ShelfSegment[],
  keyOf: (p: ShelfPackage) => string,
  endInclusive: boolean,
): FloorAxis {
  return { floor, books, ms: books.map((p) => toUtc(keyOf(p))), segments, endInclusive };
}

/** 降序数组二分：首个 arr[i] <= v 的下标（无则 arr.length）。 */
function bisectDescLE(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] > v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ---------- 弹性时间轴 ---------- */

export interface PlacedSpine {
  x: number; // 长卷屏幕坐标（左 = 最新端，0 为全架最新）
  pkg: ShelfPackage;
}

/** 一个段带在长卷上的落位（屏幕区间，左 = 段的新侧）。 */
export interface BandLayout {
  seg: ShelfSegment;
  left: number;
  right: number;
  count: number;
}

export interface ElasticAxis {
  totalW: number; // 长卷总宽
  /** 屏幕 x ↔ ms 折点表（x 升序 = 时间变旧；x=0 是全架最新端）。段内线性，供反查视口时间。 */
  nodes: { x: number; ms: number }[];
  bands: BandLayout[][]; // 与 floors 对齐（各层自己的段带）
  spines: PlacedSpine[][]; // 与 floors 对齐，长卷坐标
  gaps: { left: number; right: number; startMs: number; endMs: number }[]; // 时代空档
}

/** 有起止的有效分段（「未注明时间」「其他」无轴上位置）。 */
const isAxisSeg = (s: ShelfSegment) => !!(s.start && s.end && s.key !== "undated" && s.key !== "other");

/**
 * 建弹性长卷。步骤：
 * 1. 各层各段带收书：归属=首个命中的段（镜像后端 index_for 闭区间首命中；日历桶右开），
 *    内容宽 = n·spineW+(n-1)·GAP；
 * 2. 全体段带边界取并集 → 基本区间；每区间尺度 s = max(覆盖它的段带 内容宽/时长)；
 * 3. 不被任何段带覆盖的连续时代 = 空档（压成 GAP_W 窄条）；不属于任何段带的书（自定义区间外）
 *    归入其日期所在区间，区间宽保底其内容宽；
 * 4. 升序积分得 xFwd(t)，屏幕 x = totalW − xFwd（反向：左 = 最新）；
 * 5. 每层书在段带内按日期比例落位 + 最小间距前推 + 右侧留量封顶（三合一保证整链恒在段内）；
 *    段外书在所在区间内从新侧起找首个空槽，不与既有书脊叠压。
 */
export function buildElasticAxis(floors: FloorAxis[], spineW: number): ElasticAxis | null {
  const DAY = 86400000;
  // 1. 段带收集（归属：网格序首个命中段；日期键均为当日零点，用 边界±1ms 实现开闭）
  interface Band {
    fi: number;
    seg: ShelfSegment;
    startMs: number;
    endMs: number;
    idxs: number[]; // 段内书的数组下标（时间降序）
    count: number;
    contentW: number;
  }
  const bands: Band[] = [];
  const claimed: boolean[][] = floors.map((fa) => new Array(fa.books.length).fill(false));
  let tMin = Infinity;
  let tMax = -Infinity;
  let anyBooks = false;
  floors.forEach((fa, fi) => {
    anyBooks = anyBooks || fa.books.length > 0;
    // 该层上一段的有效归属上界（不含）。同层相邻段交叠时（明/清共用 1644、晚期罗马/拜占庭
    // 共用 476–477）：书按网格序首命中归前段，x 领域也随归属切平——两段带 x 范围不相交，
    // 边界书脊才不会互相叠压
    let prevEndExcl = -Infinity;
    for (const seg of fa.segments) {
      if (!isAxisSeg(seg)) continue;
      const startMs = toUtc(seg.start!);
      const endMs = toUtc(seg.end!);
      const endExcl = fa.endInclusive ? endMs + DAY : endMs; // 归属上界（不含）
      const effStart = Math.max(startMs, prevEndExcl); // 本段 x 领域起点
      if (effStart >= endExcl) continue; // 完全被前段吞没：书全归前段，本段无领域
      const lo = bisectDescLE(fa.ms, endExcl - 1);
      const hi = bisectDescLE(fa.ms, effStart - 1);
      const idxs: number[] = [];
      for (let i = lo; i < hi; i++)
        if (!claimed[fi][i]) {
          claimed[fi][i] = true;
          idxs.push(i);
        }
      bands.push({
        fi,
        seg,
        startMs: effStart,
        endMs: endExcl, // 轴上旧侧边缘=归属上界（不含）：与后段 effStart 相切，无缝、x 范围不相交
        idxs,
        count: idxs.length,
        contentW: idxs.length * spineW + Math.max(0, idxs.length - 1) * GAP,
      });
      tMin = Math.min(tMin, effStart);
      tMax = Math.max(tMax, endExcl);
      prevEndExcl = Math.max(prevEndExcl, endExcl);
    }
  });
  if (!anyBooks || !bands.length || tMin > tMax) return null;

  // 2. 基本区间（并集边界）
  const edges = [...new Set(bands.flatMap((b) => [b.startMs, b.endMs]))].sort((a, b) => a - b);
  const step = spineW + GAP;

  // 各层书归段：未落入任何段的书（自定义区间外）记到其日期所在基本区间
  // intervalIdx → 各层零散书内容宽（段外书）
  const strayByInterval = new Map<number, number>();
  floors.forEach((fa, fi) => {
    fa.ms.forEach((ms, i) => {
      if (claimed[fi][i]) return;
      // 找基本区间 idx：edges 中最后一个 <= ms 的位置（ms 超出全范围则夹到端点区间）
      let idx = 0;
      while (idx + 1 < edges.length && edges[idx + 1] <= ms) idx++;
      if (ms < edges[0]) idx = 0;
      if (ms > edges[edges.length - 1]) idx = edges.length - 2;
      strayByInterval.set(idx, (strayByInterval.get(idx) ?? 0) + step);
    });
  });

  // 3. 逐区间定宽：覆盖段带取最大 内容宽/时长；无覆盖则进入空档游程（GAP_W 保底）
  interface Interval {
    aMs: number;
    bMs: number;
    width: number;
    covered: boolean; // 被任一段带覆盖
  }
  const intervals: Interval[] = [];
  let gapRun: Interval[] | null = null;
  for (let i = 0; i + 1 < edges.length; i++) {
    const aMs = edges[i];
    const bMs = edges[i + 1];
    const dt = bMs - aMs;
    let s = 0;
    for (const b of bands) {
      if (b.startMs <= aMs && b.endMs >= bMs) s = Math.max(s, b.contentW / (b.endMs - b.startMs));
    }
    const stray = strayByInterval.get(i) ?? 0;
    const iv: Interval = { aMs, bMs, width: Math.max(s * dt, stray), covered: s > 0 };
    if (iv.covered || stray > 0) {
      if (gapRun) {
        flushGap(gapRun);
        gapRun = null;
      }
      intervals.push(iv);
    } else {
      (gapRun ??= []).push(iv);
    }
  }
  if (gapRun) flushGap(gapRun);
  function flushGap(run: Interval[]) {
    // 连续无书时代压成一条窄空档（宽度 = GAP_W，与时长无关；悬停示年跨）
    const w = Math.max(
      GAP_W,
      ...run.map((iv) => iv.width), // 保底段外书内容（理论上空档无书，防御）
    );
    const merged: Interval = { aMs: run[0].aMs, bMs: run[run.length - 1].bMs, width: w, covered: false };
    intervals.push(merged);
  }

  // 4. 积分 → 屏幕坐标（反向：左 = 最新）
  const nodesFwd: { x: number; ms: number }[] = [{ x: 0, ms: tMin }];
  let acc = 0;
  for (const iv of intervals) {
    acc += iv.width;
    nodesFwd.push({ x: acc, ms: iv.bMs });
  }
  const totalW = acc;
  const xFwd = (ms: number): number => {
    // 在 nodesFwd 上线性插值（ms 升序）
    let lo = 0;
    let hi = nodesFwd.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nodesFwd[mid].ms < ms) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    const n0 = nodesFwd[lo - 1];
    const n1 = nodesFwd[lo];
    return n0.x + ((ms - n0.ms) / (n1.ms - n0.ms)) * (n1.x - n0.x);
  };
  const screen = (ms: number) => totalW - xFwd(ms); // 左 = 最新（ms 大 → x 小）

  // 5. 段带落位 + 书脊落位
  const bandsOut: BandLayout[][] = floors.map(() => []);
  const spinesOut: PlacedSpine[][] = floors.map(() => []);
  const gapSpans = intervals
    .filter((iv) => !iv.covered)
    .map((iv) => ({
      left: screen(iv.bMs),
      right: screen(iv.aMs),
      startMs: iv.aMs,
      endMs: iv.bMs,
    }));

  for (const b of bands) {
    const left = screen(b.endMs);
    const right = screen(b.startMs);
    bandsOut[b.fi].push({ seg: b.seg, left, right, count: b.count });
    // 段内书（新→旧，x 升序）：日期比例落位 + 最小间距前推 + 右侧留量封顶。
    // 段宽≥内容宽 ⇒ 封顶恒≥前推（可归纳证明），整链必在段内——不做溢出整体左收
    // （旧法在最新书比例位置偏段内右侧时链尾溢出、整体左移会把队首推出段带左缘压进空档）。
    const width = right - left;
    const n = b.count;
    const placed: number[] = [];
    for (let k = 0; k < n; k++) {
      const ms = floors[b.fi].ms[b.idxs[k]];
      const prop = left + ((b.endMs - ms) / (b.endMs - b.startMs)) * width;
      const lo = k ? placed[k - 1] + step : left;
      const hi = right - spineW - (n - 1 - k) * step; // 再晚放，后面的书就挤出段带了
      placed.push(Math.min(Math.max(prop, lo), hi));
    }
    for (let k = 0; k < n; k++) {
      spinesOut[b.fi].push({ x: placed[k], pkg: floors[b.fi].books[b.idxs[k]] });
    }
  }
  // 段外书：归入其日期所在区间的屏幕范围（保底宽度已并入区间宽），
  // 从区间新侧起找首个不与既有书脊叠压的空槽（段外书极少，O(n²) 无碍）
  floors.forEach((fa, fi) => {
    fa.ms.forEach((ms, i) => {
      if (claimed[fi][i]) return;
      const iv = intervals.find((v) => ms >= v.aMs && ms <= v.bMs) ?? intervals[0];
      const l = screen(iv.bMs);
      const r = screen(iv.aMs);
      const arr = spinesOut[fi];
      arr.sort((a, b) => a.x - b.x);
      let x = l;
      for (const s of arr) {
        if (s.x + spineW + GAP <= x) continue;
        if (s.x >= x + step) break;
        x = s.x + step; // 推到该脊右侧再试
      }
      arr.push({ x: Math.min(x, Math.max(l, r - spineW)), pkg: fa.books[i] });
    });
  });
  for (const arr of spinesOut) arr.sort((a, b) => a.x - b.x);
  for (const arr of bandsOut) arr.sort((a, b) => a.left - b.left);

  // nodes：屏幕 x 升序（ms 降序），供反查视口时间
  const nodes = nodesFwd.map((n) => ({ x: totalW - n.x, ms: n.ms })).sort((a, b) => a.x - b.x);

  return { totalW, nodes, bands: bandsOut, spines: spinesOut, gaps: gapSpans };
}

/** 反查：屏幕 x 区间对应的 ms 时间范围（头部「视口 X – Y」显示用）。 */
export function timeAtX(axis: ElasticAxis, x: number): number {
  const ns = axis.nodes;
  if (x <= ns[0].x) return ns[0].ms;
  const last = ns[ns.length - 1];
  if (x >= last.x) return last.ms;
  let lo = 0;
  let hi = ns.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ns[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  const n0 = ns[lo - 1];
  const n1 = ns[lo];
  const f = (x - n0.x) / Math.max(1e-9, n1.x - n0.x);
  return n0.ms + f * (n1.ms - n0.ms);
}

/* ---------- 入库时间轴：自动日历分段（零配置，所有层共用） ---------- */

type CalendarUnit = "week" | "month" | "quarter" | "year";

/** 按全范围跨度自动选粒度：≤2 月按周、≤2 年按月、≤8 年按季、更长按年。 */
function ingestUnit(spanDays: number): CalendarUnit {
  if (spanDays <= 62) return "week";
  if (spanDays <= 730) return "month";
  if (spanDays <= 2922) return "quarter";
  return "year";
}

function unitStart(d: Date, unit: CalendarUnit): Date {
  if (unit === "week") {
    const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    s.setUTCDate(s.getUTCDate() - ((s.getUTCDay() + 6) % 7)); // 周一对齐
    return s;
  }
  if (unit === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (unit === "quarter")
    return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

function nextUnitStart(s: Date, unit: CalendarUnit): Date {
  if (unit === "week") return new Date(s.getTime() + 7 * 86400000);
  if (unit === "month") return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
  if (unit === "quarter") return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 3, 1));
  return new Date(Date.UTC(s.getUTCFullYear() + 1, 0, 1));
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 入库时间轴的分段：日历桶（个人日历无「时代」语义，无需配置；跨层同月自动对齐）。 */
export function ingestSegments(range: { start: string; end: string }): ShelfSegment[] {
  const t0 = toUtc(range.start);
  const t1 = toUtc(range.end);
  const unit = ingestUnit(Math.max(0, (t1 - t0) / 86400000));
  const out: ShelfSegment[] = [];
  let s = unitStart(new Date(t0), unit);
  const end = new Date(t1);
  for (let i = 0; i < 3000 && s <= end; i++) {
    const e = nextUnitStart(s, unit);
    const y = s.getUTCFullYear();
    const m = s.getUTCMonth();
    let seg: ShelfSegment;
    if (unit === "week") {
      seg = {
        key: `in-${ymd(s)}`,
        label: t("tl.week", { m: pad2(m + 1), d: pad2(s.getUTCDate()) }),
        alias: `${y}.${pad2(m + 1)}`,
        start: ymd(s),
        end: ymd(e),
        count: 0,
      };
    } else if (unit === "month") {
      seg = {
        key: `in-${y}-${pad2(m + 1)}`,
        label: t("tl.ym", { y, m: m + 1 }),
        alias: `${String(y).slice(2)}.${pad2(m + 1)}`,
        start: ymd(s),
        end: ymd(e),
        count: 0,
      };
    } else if (unit === "quarter") {
      const q = Math.floor(m / 3) + 1;
      seg = {
        key: `in-${y}-Q${q}`,
        label: t("tl.quarter", { y, q }),
        alias: `Q${q}`,
        start: ymd(s),
        end: ymd(e),
        count: 0,
      };
    } else {
      seg = { key: `in-${y}`, label: t("tl.year", { y }), alias: String(y), start: ymd(s), end: ymd(e), count: 0 };
    }
    out.push(seg);
    s = e;
  }
  return out;
}

/** 给日历分段填每层包数（分段骨架全层共享，count 是层的）。 */
export function withIngestCounts(segs: ShelfSegment[], pkgs: ShelfPackage[]): ShelfSegment[] {
  const days = pkgs.map((p) => dayOf(p.created_at));
  return segs.map((seg) => ({
    ...seg,
    count: days.filter((d) => d >= seg.start! && d < seg.end!).length,
  }));
}
