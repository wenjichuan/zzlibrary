/** 入库元数据的纯逻辑部分（自 Python services/ingest.py 平移；文件 I/O 抽取器在 server 侧）。 */
import { canonicalDateStr } from "./dates";

const DATE_PATTERNS: [RegExp, "ymd" | "ym" | "y"][] = [
  [/(\d{4})-(\d{1,2})-(\d{1,2})/, "ymd"],
  [/(\d{4})\/(\d{1,2})\/(\d{1,2})/, "ymd"],
  [/(\d{4})-(\d{1,2})(?![-\d])/, "ym"],
  [/(\d{4})(?![-\d])/, "y"],
];

/** 从文件元数据宽松抽取日期 → 规范序键（公元前在此不指望出现，统一公元）。 */
export function parseLooseDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = String(value).trim();
  for (const [pattern, kind] of DATE_PATTERNS) {
    const m = pattern.exec(v);
    if (!m) continue;
    if (kind === "ymd") {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (!(1 <= mo && mo <= 12) || !(1 <= d && d <= 31)) continue;
      return canonicalDateStr(y, mo, d);
    }
    if (kind === "ym") {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      if (!(1 <= mo && mo <= 12)) continue;
      return canonicalDateStr(y, mo, 1);
    }
    return canonicalDateStr(Number(m[1]), 1, 1);
  }
  return null;
}

/** 文件名主干 → 猜测标题：去扩展名、下划线换空格；空则回退完整文件名。 */
export function stemTitle(filename: string): string {
  const name = filename.replaceAll("\\", "/");
  const base = name.slice(name.lastIndexOf("/") + 1);
  const stem = base.slice(0, base.lastIndexOf(".") >= 0 ? base.lastIndexOf(".") : base.length).trim();
  return stem.replace(/_+/g, " ") || base;
}

/** 包目录名清洗（入库目录 {日期}_{id}_{包名} 用）：非法字符替换、去首尾点空格、截断 40 字符。 */
export function cleanPackageName(name: string): string {
  const cleaned = name.replace(/[\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  return cleaned.slice(0, 40) || "未命名";
}
