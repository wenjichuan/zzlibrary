/** 语言状态与取词：zustand store + localStorage 持久化（全应用第一个本地存储键）。
 *
 * - useT()：组件内取词（订阅 lang，切换即重渲染）；
 * - t()/currentLang()：非 React 模块（shelfVM/timelineLayout）与事件回调里取词
 *   （读 store 当前值，组件因 useT 订阅而重渲染时会随之重算）；
 * - quote/joinList：中文书名号/全角分隔符与英文引号/半角逗号的本地化助手。
 * 新增语言：加一份字典文件并入 DICTS，其余零改动。 */
import { useMemo } from "react";
import { create } from "zustand";
import { zh, type Dict, type DictKey } from "./zh";
import { en } from "./en";
import { ZH_DISPLAY, type DisplayI18n } from "@zzlibrary/core";

export type { DictKey };

export type Lang = "zh" | "en";
export const LANG_STORAGE_KEY = "zzlib:lang";

const DICTS: Record<Lang, Dict> = { zh, en };

export type Vars = Record<string, string | number>;

/** 词形：{var} 插值（未提供的占位符原样保留，便于发现漏传）。 */
export function tOf(lang: Lang, key: DictKey, vars?: Vars): string {
  let text: string = (DICTS[lang] ?? zh)[key];
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

function detect(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
    return (navigator.language ?? "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "zh";
  }
}

/** 语言切换的全局副作用：<html lang> 与文档标题。 */
function applyDom(lang: Lang): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.title = tOf(lang, "app.title");
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

export const useLang = create<LangState>((set) => ({
  lang: detect(),
  setLang: (lang) => {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      /* 无痕/受限环境忽略 */
    }
    applyDom(lang);
    set({ lang });
  },
}));

// 模块加载即对齐 DOM（首帧前）
applyDom(useLang.getState().lang);

/** 当前语言（非响应式；组件里请用 useT 订阅）。 */
export function currentLang(): Lang {
  return useLang.getState().lang;
}

/** 非 React 上下文取词。 */
export function t(key: DictKey, vars?: Vars): string {
  return tOf(useLang.getState().lang, key, vars);
}

/** 组件内取词：订阅语言，切换即时生效。 */
export function useT(): (key: DictKey, vars?: Vars) => string {
  const lang = useLang((s) => s.lang);
  return useMemo(() => (key: DictKey, vars?: Vars) => tOf(lang, key, vars), [lang]);
}

/* ---------- 本地化排版助手（引号/分隔符随语言） ---------- */

/** 名称引号：中文「…」 / 英文 “…”。 */
export function quote(name: string): string {
  return currentLang() === "zh" ? `「${name}」` : `“${name}”`;
}

/** 列表分隔：中文全角逗号 / 英文半角逗号加空格。 */
export function joinList(items: string[]): string {
  return items.join(currentLang() === "zh" ? "，" : ", ");
}

/** 并列顿号（中文、）——英文同为半角逗号。 */
export const joinDun = joinList;

/** 括注（计数/年份/别名）：中文全角（…）/ 英文半角 (…) 前带空格。 */
export function parens(s: string): string {
  return currentLang() === "zh" ? `（${s}）` : ` (${s})`;
}

/** core 展示钩子（公元前/未注明/其他）按当前语言取。 */
export function displayI18nNow(): DisplayI18n {
  if (useLang.getState().lang === "zh") return ZH_DISPLAY;
  return { bc: (y) => `${y} BC`, undated: t("common.undated"), other: t("common.other") };
}

/** 排序 locale：书名/分类名比较用。 */
export function sortLocale(): string {
  return currentLang() === "zh" ? "zh" : "en";
}
