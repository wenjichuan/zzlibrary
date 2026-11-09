/** 时间分段计算（自 Python services/segmentation.py 平移，行为逐条对齐）。
 *
 * 日期全线使用「带符号定宽年」规范文本（见 dates.ts）：
 * 公元前 -0221-01-01、公元 0630-01-01；定宽+符号保证字典序 = 时间序。
 *
 * - year     每年一段
 * - n_years  每 N 年一段（params.n，默认 5）
 * - decade   按十年（1990–1999；公元前按 -0220–-0211 对齐）
 * - month    每月一段（超过 300 段自动退化为按年）
 * - custom   用户自定义区间（params.ranges=[{start,end,alias}]，起止支持 前618 / -618 /
 *            YYYY / YYYY-MM / YYYY-MM-DD），区间之外入「其他」
 * 无日期的书统一进入末尾的「未注明时间」段。
 */
import { canonicalDateStr, yearOfKey } from "./dates";
import { ZH_DISPLAY, type DisplayI18n } from "./displayI18n";

export const MAX_AUTO_SEGMENTS = 300;
export const UNDATED_KEY = "undated";
export const OTHER_KEY = "other";

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeap(year: number): boolean {
  // 对公元前同样成立（判 0 的取模在 JS 中负年也正确）
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function monthEndStr(year: number, month: number): string {
  const day = month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
  return canonicalDateStr(year, month, day);
}

/** 年份显示：负年（公元前）经 i18n.bc 渲染（前221 / 221 BC）。入参可为序键文本或整年。 */
export function formatYear(canonicalOrYear: string | number, i18n: DisplayI18n = ZH_DISPLAY): string {
  const y = typeof canonicalOrYear === "number" ? canonicalOrYear : yearOfKey(canonicalOrYear);
  return y < 0 ? i18n.bc(-y) : String(y);
}

export interface Segment {
  key: string;
  label: string;
  /** 规范日期序键；custom/undated/other 段可能没有 */
  start: string | null;
  end: string | null;
  /** 别名（如朝代/时期名），custom 段可选 */
  alias?: string | null;
}

export interface SegmentConfigLike {
  mode: string;
  params?: Record<string, unknown> | null;
}

/** 返回日期所属分段下标；未注明时间返回末段。 */
export function indexFor(grid: Segment[], d: string | null | undefined): number {
  const date = d ?? null;
  for (let i = 0; i < grid.length; i++) {
    const seg = grid[i]!;
    if (seg.key === UNDATED_KEY) {
      if (date === null) return i;
      continue;
    }
    if (date !== null && seg.start !== null && seg.end !== null) {
      if (seg.start <= date && date <= seg.end) return i; // 规范文本字典序 = 时间序
    }
  }
  // custom 配置下不在任何区间 → 「其他」段；若没有其他段则兜底最后一段
  if (date !== null) {
    for (let i = 0; i < grid.length; i++) {
      if (grid[i]!.key === OTHER_KEY) return i;
    }
  }
  return grid.length - 1;
}

function yearSegments(dates: string[], i18n: DisplayI18n): Segment[] {
  const years = dates.map(yearOfKey).sort((a, b) => a - b);
  let lo = years[0]!;
  const hi = years[years.length - 1]!;
  if (hi - lo + 1 > MAX_AUTO_SEGMENTS) {
    lo = Math.max(lo, hi - MAX_AUTO_SEGMENTS + 1);
  }
  const out: Segment[] = [];
  for (let y = lo; y <= hi; y++) {
    out.push({
      key: `y${y}`,
      label: formatYear(y, i18n),
      start: canonicalDateStr(y, 1, 1),
      end: canonicalDateStr(y, 12, 31),
    });
  }
  return out;
}

function nYearsSegments(dates: string[], nRaw: number, i18n: DisplayI18n): Segment[] {
  const n = Math.max(1, Math.min(Math.trunc(nRaw || 5), 100));
  const years = dates.map(yearOfKey);
  // 对齐到 1 mod n 网格（公元前可用）；JS 需用 Math.floor 复刻 Python 整除
  let startYear = (Math.floor((Math.min(...years) - 1) / n)) * n + 1;
  const hiYear = Math.max(...years);
  const segments: Segment[] = [];
  while (startYear <= hiYear && segments.length < MAX_AUTO_SEGMENTS) {
    let endYear = Math.min(startYear + n - 1, 9999);
    if (endYear === 0) endYear = -1; // 无公元 0 年：前1 结束这一段，下一段从公元 1 开始
    segments.push({
      key: `ny${startYear}`,
      label: `${formatYear(startYear, i18n)}–${formatYear(endYear, i18n)}`,
      start: canonicalDateStr(startYear, 1, 1),
      end: canonicalDateStr(endYear, 12, 31),
    });
    startYear += n;
    if (startYear === 0) startYear = 1;
  }
  return segments;
}

function decadeSegments(dates: string[], i18n: DisplayI18n): Segment[] {
  const years = dates.map(yearOfKey);
  const lo = Math.floor(Math.min(...years) / 10) * 10;
  const hi = Math.floor(Math.max(...years) / 10) * 10;
  const segments: Segment[] = [];
  for (let d0 = lo; d0 <= hi && segments.length < MAX_AUTO_SEGMENTS; d0 += 10) {
    let startYear = d0;
    let d1 = d0 + 9;
    if (d0 === 0) {
      // 无公元 0 年：公元 1~9 单独成段
      startYear = 1;
      d1 = 9;
    }
    segments.push({
      key: `d${d0}`,
      label: `${formatYear(startYear, i18n)}–${formatYear(d1, i18n)}`,
      start: canonicalDateStr(startYear, 1, 1),
      end: canonicalDateStr(d1, 12, 31),
    });
  }
  return segments;
}

function monthSegments(dates: string[], i18n: DisplayI18n): Segment[] {
  const lo = dates.reduce((a, b) => (a < b ? a : b));
  const hi = dates.reduce((a, b) => (a > b ? a : b));
  const loY = yearOfKey(lo);
  const hiY = yearOfKey(hi);
  const loM = Number(lo.slice(5, 7));
  const hiM = Number(hi.slice(5, 7));
  const total = (hiY - loY) * 12 + hiM - loM + 1;
  if (total > MAX_AUTO_SEGMENTS) return yearSegments(dates, i18n);
  const segments: Segment[] = [];
  let year = loY;
  let month = loM;
  while (year < hiY || (year === hiY && month <= hiM)) {
    segments.push({
      key: `m${year}${String(month).padStart(2, "0")}`,
      label: `${formatYear(year, i18n)}-${String(month).padStart(2, "0")}`,
      start: canonicalDateStr(year, month, 1),
      end: monthEndStr(year, month),
    });
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return segments;
}

/** 宽松解析区间边界：前618 / -618 / YYYY（→1/1 或 12/31）、YYYY-MM、YYYY-MM-DD。 */
function parseBoundary(value: unknown, isEnd: boolean): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  let rest = s;
  let neg = false;
  if (rest.startsWith("公元前")) {
    neg = true;
    rest = rest.slice(3).trim();
  } else if (rest.startsWith("前")) {
    neg = true;
    rest = rest.slice(1).trim();
  } else if (rest.startsWith("-")) {
    neg = true;
    rest = rest.slice(1).trim();
  }
  const m = /^(\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(rest);
  if (!m) return null;
  const year = neg ? -Number(m[1]) : Number(m[1]);
  if (year === 0 || year < -9999) return null;
  const month = m[2] ? Number(m[2]) : null;
  const day = m[3] ? Number(m[3]) : null;
  if (month === null) {
    return isEnd ? canonicalDateStr(year, 12, 31) : canonicalDateStr(year, 1, 1);
  }
  if (!(1 <= month && month <= 12)) return null;
  if (day === null) {
    return isEnd ? monthEndStr(year, month) : canonicalDateStr(year, month, 1);
  }
  if (!(1 <= day && day <= 31)) return null;
  return canonicalDateStr(year, month, day);
}

/** 解析一条自定义区间 → (start, end, alias)；无效返回 null。alias 兼容旧 label 字段。 */
export function parseRange(raw: unknown): [string, string, string | null] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  let start = parseBoundary(r.start, false);
  let end = parseBoundary(r.end, true);
  if (start === null || end === null) return null;
  if (end < start) [start, end] = [end, start];
  const alias = String(r.alias ?? r.label ?? "").trim() || null;
  return [start, end, alias];
}

function customSegments(ranges: unknown[], i18n: DisplayI18n): Segment[] {
  const segments: Segment[] = [];
  for (const r of ranges) {
    const parsed = parseRange(r);
    if (parsed === null) continue;
    const [start, end, alias] = parsed;
    segments.push({
      key: `c${start}_${end}`,
      label: `${formatYear(start, i18n)}–${formatYear(end, i18n)}`,
      alias,
      start,
      end,
    });
  }
  segments.sort((a, b) => (a.start! < b.start! ? -1 : a.start! > b.start! ? 1 : a.end! < b.end! ? -1 : 1));
  if (segments.length > 0) {
    segments.push({ key: OTHER_KEY, label: i18n.other, start: null, end: null });
  }
  return segments;
}

/** 根据组内日期与配置生成分段网格（含「未注明时间」段）。展示词经 i18n 钩子注入（默认中文）。 */
export function computeGrid(
  dates: (string | null)[],
  config: SegmentConfigLike | null,
  i18n: DisplayI18n = ZH_DISPLAY,
): Segment[] {
  const dated = dates.filter((d): d is string => d !== null).sort();
  const segments: Segment[] = [];
  const mode = config ? config.mode : "year";
  const params = (config?.params ?? {}) as Record<string, unknown>;

  if (mode === "custom") {
    const ranges = Array.isArray(params.ranges) ? (params.ranges as unknown[]) : [];
    segments.push(...customSegments(ranges, i18n));
    if (segments.length === 0 && dated.length > 0) {
      segments.push(...yearSegments(dated, i18n));
    }
  } else if (dated.length > 0) {
    if (mode === "n_years") {
      segments.push(...nYearsSegments(dated, Number(params.n ?? 5), i18n));
    } else if (mode === "decade") {
      segments.push(...decadeSegments(dated, i18n));
    } else if (mode === "month") {
      segments.push(...monthSegments(dated, i18n));
    } else {
      segments.push(...yearSegments(dated, i18n));
    }
  }

  if (dates.some((d) => d === null)) {
    segments.push({ key: UNDATED_KEY, label: i18n.undated, start: null, end: null });
  }
  return segments;
}
