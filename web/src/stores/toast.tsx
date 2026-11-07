import { createContext, useCallback, useContext, useMemo, useState } from "react";

type ToastKind = "success" | "error" | "info";
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
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3600);
  }, []);
  const value = useMemo(() => ({ push }), [push]); // 稳定引用：toast 增删不再连带全站消费页重渲染
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`zz-fade-in rounded-lg px-4 py-2.5 text-sm shadow-lg ${
              t.kind === "success"
                ? "bg-emerald-700 text-white"
                : t.kind === "error"
                  ? "bg-red-700 text-white"
                  : "bg-stone-800 text-stone-50"
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
