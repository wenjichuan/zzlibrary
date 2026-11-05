/** 书架视图模型与共享纯函数（无 React）：VM 构建、日期换算、展示格式。
 *
 * 轴系：X=时间、Y=二级分类、Z=三级分类；数量由书脊直接体现。 */
import type { ShelfPackage, ShelfSegment, ShelvesDetail } from "@zzlibrary/shared";

/* ---------- 视图模型 ---------- */

export interface FloorVM {
  label: string;
  l3Id: number | null;
  total: number;
  segments: ShelfSegment[]; // 该层自己的分段网格（三级覆盖 > 二级 > 全局）
  dated: ShelfPackage[]; // 有发布日期，按 (日期, 包名) 升序
  undated: ShelfPackage[]; // 未注明发布时间——不上发布时间轴（编目补全后才上架），仍计入入库轴
  ingest: ShelfPackage[]; // 全部包，按 (入库时刻, 包名) 升序（入库时间轴用）
}

export interface RackVM {
  key: string;
  label: string;
  total: number;
  range: { start: string; end: string } | null; // 发布时间轴范围（各层并集）
  ingestRange: { start: string; end: string } | null; // 入库时间轴范围（created_at 并集）
  floors: FloorVM[];
}

/** ISO 时间戳 → "YYYY-MM-DD"（created_at 前端只用日粒度落位/分段）。 */
export const dayOf = (iso: string) => iso.slice(0, 10);

const addDay = (ymd: string): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function buildRackVMs(data: ShelvesDetail): RackVM[] {
  return data.groups.map((g, gi) => {
    const floors: FloorVM[] = g.shelves.map((shelf) => {
      const dated: ShelfPackage[] = [];
      const undated: ShelfPackage[] = [];
      const seen = new Set<number>();
      for (const pl of shelf.packages ?? []) {
        if (seen.has(pl.package.id)) continue;
        seen.add(pl.package.id);
        (pl.package.publish_date == null ? undated : dated).push(pl.package);
      }
      dated.sort(cmpByDate);
      undated.sort((a, b) => a.title.localeCompare(b.title, "zh"));
      const ingest = [...dated, ...undated]; // 已按包 id 去重
      ingest.sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.title.localeCompare(b.title, "zh"),
      );
      return {
        label: shelf.l3?.name ?? "未细分",
        l3Id: shelf.l3?.id ?? null,
        total: shelf.total,
        segments: shelf.segments ?? [],
        dated,
        undated,
        ingest,
      };
    });
    // 入库时间轴范围：各层 created_at 并集（只有一天则 +1 天，避免零跨度除零）
    const days = [
      ...new Set(
        g.shelves.flatMap((s) => (s.packages ?? []).map((pl) => dayOf(pl.package.created_at))),
      ),
    ].sort();
    const ingestRange = days.length
      ? { start: days[0], end: days[days.length - 1] === days[0] ? addDay(days[0]) : days[days.length - 1] }
      : null;
    return {
      key: `g${g.l2?.id ?? "none"}-${gi}`,
      label: g.l2?.name ?? "未分类",
      total: g.total,
      range: g.range ?? null,
      ingestRange,
      floors,
    };
  });
}

/* ---------- 日期/展示纯函数 ---------- */

export const SERIF = `"Noto Serif SC", "Songti SC", SimSun, serif`;

export function placeholderColor(id: number): string {
  const hue = (id * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 34%, 44%)`;
}

/** 显示日期（"-0221-05-01" / "0630-01-01"）→ 年整数（负 = 公元前）。 */
export function yearNum(d: string): number {
  const neg = d.startsWith("-");
  const y = Number(neg ? d.slice(1, 5) : d.slice(0, 4));
  return neg ? -y : y;
}

export const yearLabel = (y: number) => (y < 0 ? `前${-y}` : String(y));

/** 同年内取 "MM-DD" 部分（负年多一位符号）。 */
const restOf = (d: string) => (d.startsWith("-") ? d.slice(6) : d.slice(5));

/** 资料包排序：年 → 月日 → 包名（同日按包名拼音）。 */
export function cmpByDate(a: ShelfPackage, b: ShelfPackage): number {
  const da = a.publish_date;
  const db = b.publish_date;
  if (!da || !db) return da === db ? a.title.localeCompare(b.title, "zh") : da ? -1 : 1;
  const ya = yearNum(da);
  const yb = yearNum(db);
  if (ya !== yb) return ya - yb;
  const ra = restOf(da);
  const rb = restOf(db);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.title.localeCompare(b.title, "zh");
}

/** 显示日期 → UTC 毫秒。setUTCFullYear 规避 Date.UTC 把 0~99 年映射到 1900+ 的陷阱。 */
export function toUtc(s: string): number {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [y, m, d] = body.split("-").map(Number);
  const dt = new Date(Date.UTC(2000, (m || 1) - 1, d || 1));
  dt.setUTCFullYear(neg ? -(y || 1) : y || 1);
  return dt.getTime();
}

export const yearOf = (ms: number) => new Date(ms).getUTCFullYear();

/** 展示用日期：公元前渲染为「前221」；年份粒度只显示年份。 */
export function prettyDate(d: string | null): string {
  if (!d) return "未注明时间";
  const yText = yearLabel(yearNum(d));
  const rest = d.startsWith("-") ? d.slice(6) : d.slice(5); // "05-01"（负年多一位符号）
  if (rest === "01-01") return yText;
  return rest.endsWith("-01") ? `${yText}-${rest.slice(0, 2)}` : `${yText}-${rest}`;
}
