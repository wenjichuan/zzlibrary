/** 日期规范（与原 Python 后端 bit 级兼容）。
 *
 * 日期统一用文本承载（无公元 0 年，Python date 不支持公元前）。两种形态：
 * - 序键（存储/比较用）：公元 "YYYY-MM-DD"；公元前年用 9 补码（前1 → -9999、前221 → -9779），
 *   保证字典序 = 时间序，SQL ORDER BY / min-max / 字符串比较直接可用。
 * - 显示（API 出参用）：公元同序键；公元前 "-0221-05-01"（人类可读）。
 */

const DATE_PARTS = /^(\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/;

/** 年月日 → 序键文本（负年 = 公元前，9 补码编码：前1→-9999、前221→-9779）。 */
export function canonicalDateStr(year: number, month = 1, day = 1): string {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  if (year < 0) return `-${String(9999 + year + 1).padStart(4, "0")}-${m}-${d}`;
  return `${String(year).padStart(4, "0")}-${m}-${d}`;
}

/** 序键 → 整年（公元前为负，如 -9779 → -221）。 */
export function yearOfKey(key: string): number {
  if (key.startsWith("-")) return Number(key.slice(1, 5)) - 10000;
  return Number(key.slice(0, 4));
}

/** 序键 → 显示文本（公元不变；公元前 -9779-05-01 → -0221-05-01）。 */
export function displayDate(key: string | null): string | null {
  if (!key || !key.startsWith("-")) return key;
  const y = Math.abs(yearOfKey(key));
  return `-${String(y).padStart(4, "0")}${key.slice(5)}`;
}

/** 接受 前221 / 公元前221 / -221 / YYYY / YYYY-MM / YYYY-MM-DD → 规范序键。
 * 缺省部分取 1 号；无效抛 Error（message 与 Python 版一致）。 */
export function parsePartialDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s0 = String(value).trim();
  let s = s0;
  let neg = false;
  if (s.startsWith("公元前")) {
    neg = true;
    s = s.slice(3).trim();
  } else if (s.startsWith("前")) {
    neg = true;
    s = s.slice(1).trim();
  } else if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1).trim();
  }
  const m = DATE_PARTS.exec(s);
  if (!m) {
    throw new Error(`日期格式无效：'${String(value)}'，应为 前221 / -221 / YYYY、YYYY-MM 或 YYYY-MM-DD`);
  }
  let year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 1;
  const day = m[3] ? Number(m[3]) : 1;
  if (neg) year = -year;
  if (year === 0) throw new Error("没有公元 0 年：公元前一年请写「前1」，公元一年请写「1」");
  if (!(1 <= month && month <= 12) || !(1 <= day && day <= 31)) {
    throw new Error(`日期无效：'${String(value)}'`);
  }
  return canonicalDateStr(year, month, day);
}
