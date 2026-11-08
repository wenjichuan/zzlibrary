import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type ToastKind = "success" | "error";
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastContext = createContext<{ push: (kind: ToastKind, text: string) => void }>({
  push: () => undefined,
});

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<number[]>([]);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, kind, text }]);
    timers.current.push(window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3600));
  }, []);
  // 卸载清残留定时器
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    [],
  );
  const value = useMemo(() => ({ push }), [push]); // 稳定引用：toast 增删不再连带全站消费页重渲染
  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live：屏幕阅读器可感知成功/失败提示 */}
      <div role="status" aria-live="polite" className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`zz-fade-in rounded-lg px-4 py-2.5 text-sm shadow-lg ${
              t.kind === "success" ? "bg-emerald-700 text-white" : "bg-red-700 text-white"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
