/** 跨设备陈旧性哨兵（聚焦驱动，用户设计拍板：砍掉定时心跳，只留聚焦探测）：
 * 窗口重新聚焦/页面重新可见 → 防抖 2s → GET /api/sync/check（服务端 1 个小 GET 比对 revision，
 * 云端更新才真同步）→ 变更则广播 zzlib:cloud-synced 事件 + toast。
 * 防重入：本组件 inFlight + 服务端单飞锁双保险；离线静默（check 永不抛错给用户看）。 */
import { useEffect } from "react";
import { api } from "@zzlibrary/shared/client";
import { useToast } from "../stores/toast";

export const CLOUD_SYNCED_EVENT = "zzlib:cloud-synced";

export default function CloudSyncWatcher() {
  const { push } = useToast();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const run = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const r = await api.syncCheck();
        if (r.changed) {
          window.dispatchEvent(
            new CustomEvent(CLOUD_SYNCED_EVENT, { detail: { applied: r.applied } }),
          );
          push("success", `云端有更新，已同步（${r.applied} 条变更）`);
        }
      } catch {
        /* 离线/未登录等：聚焦探测静默 */
      } finally {
        inFlight = false;
      }
    };

    const onWake = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, 2000);
    };
    const onVisibility = () => {
      if (!document.hidden) onWake();
    };

    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [push]);

  return null;
}
