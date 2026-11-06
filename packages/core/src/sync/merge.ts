/** 合并规则（纯函数，全端共用）：
 * - 元数据字段：updated_at 新者胜；同值并列时 uuid 字典序决胜 → 任意设备合并结果一致；
 * - 行集合（分类路径/文件）：按 uuid 并集，行内字段仍走 LWW；
 * - 阅读进度：读得最远为准（percent 最大者的 locator 整体跟随）；重置=墓碑，永远生效。 */

import type { ManifestEnvelope } from "./contract";

export interface Versioned {
  updatedAt: string;
  uuid: string;
}

/** 远端版本是否胜过本地（LWW + uuid 决胜）。 */
export function remoteWins(local: Versioned, remote: Versioned): boolean {
  if (remote.updatedAt !== local.updatedAt) return remote.updatedAt > local.updatedAt;
  return remote.uuid > local.uuid;
}

export interface ProgressLike {
  percent: number;
  updatedAt: string;
  uuid: string;
}

/** 活跃进度合并（墓碑语义在引擎层处理）：远端是否应覆盖本地。 */
export function remoteProgressWins(local: ProgressLike | null, remote: ProgressLike): boolean {
  if (local === null) return true;
  if (remote.percent !== local.percent) return remote.percent > local.percent;
  return remoteWins(local, remote);
}

/** 清单应用结果的抽象（设备侧据此落库）。 */
export type ApplyOutcome = "applied" | "local-newer" | "tombstone-applied" | "noop";

// ---------- 三方合并（字段级 LWW 的落地） ----------

export function jsonEq(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** base=上次同步时的云端版本，local=本地现行，remote=远端新到。
 * 逐顶层键：两端都没动→保留；只有一端改→取改端；两端都改→远端（调用点已保证
 * remote.updatedAt 胜出才走到合并；并列时取远端保证全端确定性）。
 * 设备把合并结果存为本地版本（updatedAt=远端值），下次推送把合并态传播开。 */
export function merge3(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  bothChanged: "local" | "remote" = "remote",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const k of keys) {
    const b = base[k];
    const l = local[k];
    const r = remote[k];
    if (jsonEq(r, b)) out[k] = l; // 远端没动 → 本地为准（含两端都没动）
    else if (jsonEq(l, b)) out[k] = r; // 本地没动 → 远端为准
    else out[k] = bothChanged === "local" ? l : r; // 两端都改 → 时间戳新的一方
  }
  return out;
}

/** 设备侧应用远端清单的通用前置判断（progress 由设备按取最大规则单独处理）。
 * 墓碑同样走 LWW：本地在墓碑之后又编辑过（updatedAt 更新）→ 本地胜，
 * 下次推送会以非墓碑清单复活该实体。 */
export function decideApply(
  local: Versioned | null,
  remote: ManifestEnvelope,
): ApplyOutcome {
  if (local === null) return remote.deleted ? "noop" : "applied";
  if (remote.deleted) return remoteWins(local, remote) ? "tombstone-applied" : "local-newer";
  return remoteWins(local, remote) ? "applied" : "local-newer";
}
