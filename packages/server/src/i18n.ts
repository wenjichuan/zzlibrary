/** 服务端双语消息与展示词汇：按请求 Accept-Language 协商（缺省 zh）。
 *
 * 消息以稳定键承载、词句住本文件字典；web 的 fetch 同源自带浏览器 Accept-Language，
 * 用户在界面上主动选择的语言也经 localStorage 写入请求头（shared/client.ts）。
 * core 的展示词（公元前/未注明/其他）经 displayI18nOf 注入，core 本体不含多语言。 */
import { ZH_DISPLAY, type DisplayI18n } from "@zzlibrary/core";

export type Lang = "zh" | "en";

/** 请求上下文的最小结构（Hono Context 结构满足；便于测试直接构造）。 */
interface LangCtx {
  req: { header(name: string): string | undefined };
}

/** Accept-Language 协商：zh/en 前缀（忽略大小写）谁先出现用谁；两者皆无 → zh。 */
export function langOf(c: LangCtx): Lang {
  const tags = (c.req.header("Accept-Language") ?? "").split(",").map((t) => t.trim().toLowerCase());
  for (const tag of tags) {
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "zh";
}

// C2 先承载日期错误（DateParseError code）；C4 补齐全量路由消息。
const MESSAGES: Record<Lang, Record<string, string>> = {
  zh: {
    "date.format": "日期格式无效：'{value}'，应为 前221 / -221 / 221 BC / YYYY、YYYY-MM 或 YYYY-MM-DD",
    "date.yearZero": "没有公元 0 年：公元前一年请写「前1」（或 1 BC），公元一年请写「1」",
    "date.invalid": "日期无效：'{value}'",
  },
  en: {
    "date.format": "Invalid date format: '{value}'. Expected 221 BC / -221 / YYYY, YYYY-MM or YYYY-MM-DD",
    "date.yearZero": "There is no year 0: write \"1 BC\" (or 前1) for 1 BCE, or \"1\" for 1 AD",
    "date.invalid": "Invalid date: '{value}'",
  },
};

/** 取某语言的消息（{var} 插值；缺键回退中文再回退键名本身）。 */
export function msgFor(lang: Lang, key: string, vars?: Record<string, unknown>): string {
  let text: string = MESSAGES[lang]?.[key] ?? MESSAGES.zh[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

/** 取当前请求语言的消息。 */
export function msg(c: LangCtx, key: string, vars?: Record<string, unknown>): string {
  return msgFor(langOf(c), key, vars);
}

/** 当前请求语言的 core 展示钩子（书架段带 / 公元前年 / 未注明）。 */
export function displayI18nOf(lang: Lang): DisplayI18n {
  return lang === "en"
    ? { bc: (y) => `${y} BC`, undated: "Undated", other: "Other" }
    : ZH_DISPLAY;
}
