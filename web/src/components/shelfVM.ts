/** 书架视图模型与共享纯函数（无 React）：VM 构建、日期换算、展示格式。
 *
 * 轴系：X=时间、Y=二级分类、Z=三级分类；数量由书脊直接体现。
 * 日期域函数（公元前显示/逆解析）全部转发 core——本文件只保留视图模型与排序。 */
import { displayToUtc, prettyDisplayDate, restOfDisplay, yearLabelOf, yearOfDisplay } from "@zzlibrary/core";
import { displayI18nNow } from "../i18n/lang";
import type { ShelfPackage, ShelfSegment, ShelvesDetail } from "@zzlibrary/shared/client";
import { sortLocale, t } from "../i18n/lang";

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
  range: { start: string | null; end: string | null } | null; // 发布时间轴范围（各层并集；wire 契约允许端点为 null）
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
      undated.sort((a, b) => a.title.localeCompare(b.title, sortLocale()));
      const ingest = [...dated, ...undated]; // 已按包 id 去重
      ingest.sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.title.localeCompare(b.title, sortLocale()),
      );
      return {
        label: shelf.l3?.name ?? t("lib.unsplit"),
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
      label: g.l2?.name ?? t("common.uncategorized"),
      total: g.total,
      range: g.range ?? null,
      ingestRange,
      floors,
    };
  });
}

/** 架 key（`g<l2标识>-<组序>`）→ l2 标识（数字 id 或 "none"）。
 * key 格式的编/解码同住此文件——消费方（LibraryPage）不再自行字符串手术。 */
export function l2KeyOfRack(rackKey: string): string {
  return rackKey.split("-")[0]!.slice(1);
}

/* ---------- 日期/展示纯函数 ---------- */

/** 包状态键 → 显示词（DB/API 存语言无关键，显示层经字典翻译）。未知值原样透出。 */
export function statusLabel(s: string): string {
  if (s === "unread") return t("status.unread");
  if (s === "reading") return t("status.reading");
  if (s === "done") return t("status.done");
  return s;
}

export const SERIF = `"Noto Serif SC", "Songti SC", SimSun, serif`;

export function placeholderColor(id: number): string {
  const hue = (id * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 34%, 44%)`;
}

/** 显示日期 → 年整数（负 = 公元前）。转发 core（域规则唯一出处）。 */
export const yearNum = yearOfDisplay;

export const yearLabel = (y: number) => yearLabelOf(y, displayI18nNow());

/** 同年内取 "MM-DD" 部分（负年多一位符号）。转发 core。 */
const restOf = restOfDisplay;

/** 资料包排序：年 → 月日 → 包名（同日按包名拼音）。 */
function cmpByDate(a: ShelfPackage, b: ShelfPackage): number {
  const da = a.publish_date;
  const db = b.publish_date;
  if (!da || !db) return da === db ? a.title.localeCompare(b.title, sortLocale()) : da ? -1 : 1;
  const ya = yearNum(da);
  const yb = yearNum(db);
  if (ya !== yb) return ya - yb;
  const ra = restOf(da);
  const rb = restOf(db);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.title.localeCompare(b.title, sortLocale());
}

/** 显示日期 → UTC 毫秒。转发 core。 */
export const toUtc = displayToUtc;

export const yearOf = (ms: number) => new Date(ms).getUTCFullYear();

/** 展示用日期。转发 core。 */
export const prettyDate = (d: string | null) => prettyDisplayDate(d, displayI18nNow());
