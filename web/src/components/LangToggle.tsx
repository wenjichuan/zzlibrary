import { useLang, useT } from "../i18n/lang";

/** 语言切换（中/EN）：侧栏与登录页共用。 */
export default function LangToggle({ className = "" }: { className?: string }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  return (
    <button
      className={`rounded-lg border border-current/30 px-2.5 py-1 text-xs opacity-80 transition-opacity hover:opacity-100 ${className}`}
      onClick={() => setLang(lang === "zh" ? "en" : "zh")}
      aria-label={t("nav.langLabel")}
    >
      {lang === "zh" ? "EN" : "中文"}
    </button>
  );
}
