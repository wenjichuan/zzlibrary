/** 基础 UI 组件。 */
import { useEffect, useRef } from "react";

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md";
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const sizes = size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm";
  const variants = {
    primary: "bg-amber-700 text-white hover:bg-amber-800",
    outline: "border border-stone-300 bg-white text-stone-700 hover:border-amber-600 hover:text-amber-800",
    ghost: "text-stone-600 hover:bg-stone-100",
    danger: "border border-red-200 bg-white text-red-600 hover:bg-red-50",
  }[variant];
  return <button className={`${base} ${sizes} ${variants} ${className}`} {...props} />;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-amber-600 focus:ring-2 focus:ring-amber-600/15"
      {...props}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-amber-600 focus:ring-2 focus:ring-amber-600/15"
      rows={3}
      {...props}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-amber-600 focus:ring-2 focus:ring-amber-600/15"
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-sm font-medium text-stone-700">{label}</span>
        {hint && <span className="text-xs text-stone-500">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

/** 模态弹层：Esc 关闭 + 简易焦点圈定（Tab 不逃出面板）+ 关闭还焦 + 背板点击关闭。 */
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // onClose 常为内联箭头函数——经 ref 取用，effect 只挂一次（否则每次父渲染都会触发还焦逻辑）
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus(); // 初始焦点进面板（Shift+Tab 可回到关闭按钮）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key === "Tab" && panel !== null) {
        const focusables = panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.(); // 关闭后焦点还给打开者
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`zz-fade-in zz-modal-h w-full outline-none ${wide ? "max-w-3xl" : "max-w-lg"} overflow-y-auto rounded-xl bg-white shadow-2xl`}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-stone-200 bg-white px-5 py-3.5">
          <h2 className="text-base font-semibold text-stone-800">{title}</h2>
          <button
            aria-label="关闭"
            className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/** 视图说明行：桌面显示；手机/矮视口隐藏让位主内容（书架两视图同款口径）。 */
export function ViewHint({ className = "", style, children }: { className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div className={`hidden md:block zz-hide-short ${className}`} style={style}>
      {children}
    </div>
  );
}

/** 页面容器：统一 mx-auto + 内边距节奏（各页 max-w 经 maxW 收口，不再各自手抄）。
 * 注意映射表必须写字面量——Tailwind JIT 不生成动态拼接的类。 */
const PAGE_MAX_W = {
  "2xl": "max-w-2xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
} as const;

export function PageShell({
  maxW = "5xl",
  children,
}: {
  maxW?: keyof typeof PAGE_MAX_W;
  children: React.ReactNode;
}) {
  return <div className={`mx-auto ${PAGE_MAX_W[maxW]} px-6 py-6`}>{children}</div>;
}

export function Spinner({ text }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-stone-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-amber-700" />
      {text ?? "加载中…"}
    </div>
  );
}

export function Empty({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-16 text-stone-400">
      <div className="text-4xl">{icon}</div>
      <div className="text-sm font-medium text-stone-600">{title}</div>
      {hint && <div className="text-xs">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-y-2">
      <h1 className="text-xl font-semibold text-stone-800">{title}</h1>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}
