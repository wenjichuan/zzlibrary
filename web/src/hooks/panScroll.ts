/** 共享「拖拽=滚动 + 位移吞 click」交互钩子——时间轴/排视图同款行为，替代两份各自漂移的副本。
 * - 位移超过 4px 判定为拖拽：内层横向跟手滚、外层（可空）纵向滚
 * - 拖拽结束后吞掉随之而来的 click（capture + once）防误触书脊/书架；
 *   pointercancel 后浏览器不再派发 click，once 监听器会残留吞掉下一次合法点击——带限时自毁
 * - onSync：程序性赋值 scrollLeft 在部分 WebView（IAB）不触发 scroll 事件——同步兜底回调 */
import { useRef } from "react";

export interface PanScrollRefs {
  inner: React.RefObject<HTMLElement | null>;
  outer?: React.RefObject<HTMLElement | null>;
}

export function usePanToScroll({ inner, outer }: PanScrollRefs, onSync?: () => void) {
  const dragRef = useRef<{ x0: number; y0: number; sl0: number; st0: number; moved: boolean } | null>(null);

  const onPanStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = inner.current;
    if (!el) return;
    dragRef.current = {
      x0: e.clientX,
      y0: e.clientY,
      sl0: el.scrollLeft,
      st0: outer?.current?.scrollTop ?? 0,
      moved: false,
    };
  };

  const onPanMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = inner.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      const host = outer?.current ?? el;
      host.style.cursor = "grabbing";
      host.style.userSelect = "none";
    }
    el.scrollLeft = d.sl0 - dx;
    if (outer?.current) outer.current.scrollTop = d.st0 - dy;
    onSync?.();
  };

  const onPanEnd = () => {
    const d = dragRef.current;
    dragRef.current = null;
    const host = outer?.current ?? inner.current;
    if (host) {
      host.style.cursor = "";
      host.style.userSelect = "";
    }
    if (d?.moved) {
      const swallow = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      host?.addEventListener("click", swallow, { capture: true, once: true });
      // pointercancel 分支：click 永不来，250ms 后自毁，保住下一次合法点击
      window.setTimeout(() => host?.removeEventListener("click", swallow, { capture: true }), 250);
    }
  };

  return { onPanStart, onPanMove, onPanEnd };
}
