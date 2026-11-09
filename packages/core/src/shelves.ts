/** 书架聚合（多分类路径版，自 Python services/aggregate.py 平移为纯函数）。
 *
 * 某一级分类下的资料包 = 至少一条路径 l1_id 命中的包。
 * - 组（二级分类）按路径的 l2_id 分组，空 → 「未分类」组
 * - 书架按路径的 l3_id 划分，空 → 「未细分」书架
 * - (包, l2, l3) 三元组去重：同一包多条路径落在同一书架只算一本
 * - 组/l1 的 total 与各层计数均按**去重后的包数**统计
 * - 时间分段按**每层（三级分类）独立计算**：三级覆盖 > 二级覆盖 > 全局默认
 * - 组内统一 range（各层分段并集 ∪ 藏书日期）供比例时间轴跨层对齐
 *
 * DB 行（包/路径/分类/分段配置）由调用方查出后传入；输出 payload 键名与
 * Python API 完全一致（snake_case），web 客户端零改动。
 */
import { displayDate } from "./dates";
import { computeGrid, indexFor, type Segment, type SegmentConfigLike } from "./segmentation";
import { ZH_DISPLAY, type DisplayI18n } from "./displayI18n";

export interface AggCategory {
  id: number;
  name: string;
  sort_order: number;
}

export interface AggPath {
  l1_id: number;
  l2_id: number | null;
  l3_id: number | null;
}

/** 聚合输入的包（formats 仅 include_packages 时需要；paths 需按 id 升序）。 */
export interface AggPackage {
  id: number;
  title: string;
  authors: string[];
  publish_date: string | null;
  /** ISO 文本（T 分隔） */
  created_at: string;
  file_count: number;
  status: string;
  formats?: string[];
  paths: AggPath[];
}

export interface SegmentConfigRow {
  scope: "global" | "l2" | "l3";
  l2_id: number | null;
  l3_id: number | null;
  mode: string;
  params: Record<string, unknown> | null;
}

export type EffectiveScope = "default" | "global" | "l2" | "l3";

export interface EffectiveConfig {
  config: SegmentConfigLike;
  scope: EffectiveScope;
}

const GLOBAL_DEFAULT: SegmentConfigLike = { mode: "year", params: {} };

function toConfigLike(row: SegmentConfigRow): SegmentConfigLike {
  return { mode: row.mode, params: row.params ?? {} };
}

/** 三级覆盖 > 二级覆盖 > 全局默认，附带生效来源。 */
export function resolveConfigWithScope(
  rows: SegmentConfigRow[],
  l2Id: number | null,
  l3Id: number | null = null,
): EffectiveConfig {
  if (l3Id !== null) {
    const row = rows.find((r) => r.scope === "l3" && r.l3_id === l3Id);
    if (row) return { config: toConfigLike(row), scope: "l3" };
  }
  if (l2Id !== null) {
    const row = rows.find((r) => r.scope === "l2" && r.l2_id === l2Id);
    if (row) return { config: toConfigLike(row), scope: "l2" };
  }
  const global = rows.find((r) => r.scope === "global");
  if (global) return { config: toConfigLike(global), scope: "global" };
  return { config: GLOBAL_DEFAULT, scope: "default" };
}

function ref(c: AggCategory | undefined): { id: number; name: string } | null {
  return c ? { id: c.id, name: c.name } : null;
}

/** 输出 payload（与 Python build_shelves 返回的 dict 逐字段一致）。 */
export interface ShelvesPayload {
  l1: { id: number; name: string };
  groups: Array<{
    l2: { id: number; name: string } | null;
    range: { start: string | null; end: string | null } | null;
    has_undated: boolean;
    shelves: Array<{
      l3: { id: number; name: string } | null;
      segments: Array<{
        key: string;
        label: string;
        alias: string | null;
        start: string | null;
        end: string | null;
        count: number;
      }>;
      config: {
        scope: string;
        l2_id: number | null;
        l3_id: number | null;
        mode: string;
        params: Record<string, unknown>;
      };
      counts: Record<string, number>;
      total: number;
      packages?: Array<{
        segment_key: string;
        package: {
          id: number;
          title: string;
          authors: string[];
          publish_date: string | null;
          created_at: string;
          file_count: number;
          formats: string[];
          status: string;
        };
      }>;
    }>;
    total: number;
  }>;
  total: number;
}

/** pkgs 应为「至少一条路径 l1_id == l1.id」的包（调用方过滤）。
 * include_packages=true 时书架内嵌每本书的放置信息（segment_key + 包摘要）。 */
export function buildShelves(
  l1: { id: number; name: string },
  pkgs: AggPackage[],
  cats: Map<number, AggCategory>,
  configRows: SegmentConfigRow[],
  includePackages = false,
  i18n: DisplayI18n = ZH_DISPLAY,
): ShelvesPayload {
  // (包, 路径) 对 → 按 (pkg, l2, l3) 去重（首个命中保留）
  const pairs = new Map<string, { pkg: AggPackage; path: AggPath }>();
  for (const p of pkgs) {
    for (const path of p.paths) {
      if (path.l1_id !== l1.id) continue;
      const key = `${p.id}|${path.l2_id ?? ""}|${path.l3_id ?? ""}`;
      if (!pairs.has(key)) pairs.set(key, { pkg: p, path });
    }
  }

  const byL2 = new Map<number | null, Array<{ pkg: AggPackage; path: AggPath }>>();
  for (const pair of pairs.values()) {
    const list = byL2.get(pair.path.l2_id) ?? [];
    list.push(pair);
    byL2.set(pair.path.l2_id, list);
  }

  const definedL2 = [...byL2.keys()]
    .filter((k): k is number => k !== null && cats.has(k))
    .map((k) => cats.get(k)!)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const orderedKeys: Array<number | null> = definedL2.map((c) => c.id);
  if (byL2.has(null)) orderedKeys.push(null);

  const groupsPayload: ShelvesPayload["groups"] = [];
  const seenPkgIdsTotal = new Set<number>();
  for (const l2Key of orderedKeys) {
    const groupPairs = byL2.get(l2Key)!;
    const groupPkgIds = new Set(groupPairs.map(({ pkg }) => pkg.id));
    for (const id of groupPkgIds) seenPkgIdsTotal.add(id);
    const l2Cat = l2Key !== null ? cats.get(l2Key) : undefined;

    // 书架按 l3 分组（组内每包每架至多一次）
    const byL3 = new Map<number | null, Set<number>>();
    const pkgMap = new Map(groupPairs.map(({ pkg }) => [pkg.id, pkg]));
    for (const { pkg, path } of groupPairs) {
      const set = byL3.get(path.l3_id) ?? new Set<number>();
      set.add(pkg.id);
      byL3.set(path.l3_id, set);
    }
    const definedL3 = [...byL3.keys()]
      .filter((k): k is number => k !== null && cats.has(k))
      .map((k) => cats.get(k)!)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    const orderedL3: Array<number | null> = definedL3.map((c) => c.id);
    if (byL3.has(null)) orderedL3.push(null);

    const shelvesPayload: ShelvesPayload["groups"][number]["shelves"] = [];
    let groupStart: string | null = null;
    let groupEnd: string | null = null;
    let hasUndated = false;
    for (const l3Key of orderedL3) {
      const shelfPkgIds = byL3.get(l3Key)!;
      const shelfPkgs = [...shelfPkgIds].map((pid) => pkgMap.get(pid)!);
      const { config, scope } = resolveConfigWithScope(configRows, l2Key, l3Key);
      const grid: Segment[] = computeGrid(
        shelfPkgs.map((p) => p.publish_date),
        config,
        i18n,
      );

      const counts: Record<string, number> = {};
      for (const seg of grid) counts[seg.key] = 0;
      const placements: NonNullable<ShelvesPayload["groups"][number]["shelves"][number]["packages"]> = [];
      for (const p of shelfPkgs) {
        if (p.publish_date === null) hasUndated = true;
        if (grid.length > 0) {
          const segKey = grid[indexFor(grid, p.publish_date)]!.key;
          counts[segKey] = (counts[segKey] ?? 0) + 1;
          if (includePackages) {
            placements.push({
              segment_key: segKey,
              package: {
                id: p.id,
                title: p.title,
                authors: [...(p.authors ?? [])],
                publish_date: displayDate(p.publish_date),
                created_at: p.created_at,
                file_count: p.file_count,
                formats: [...new Set(p.formats ?? [])].sort(),
                status: p.status,
              },
            });
          }
        }
      }

      // 层的时间跨度：分段网格并集 ∪ 该层藏书日期（比例时间轴跨层对齐用）
      const starts = [
        ...grid.filter((s) => s.start !== null).map((s) => s.start!),
        ...shelfPkgs.filter((p) => p.publish_date !== null).map((p) => p.publish_date!),
      ];
      const ends = [
        ...grid.filter((s) => s.end !== null).map((s) => s.end!),
        ...shelfPkgs.filter((p) => p.publish_date !== null).map((p) => p.publish_date!),
      ];
      let shelfStart: string | null = null;
      let shelfEnd: string | null = null;
      for (const s of starts) if (shelfStart === null || s < shelfStart) shelfStart = s;
      for (const s of ends) if (shelfEnd === null || s > shelfEnd) shelfEnd = s;
      if (shelfStart !== null) {
        if (groupStart === null || shelfStart < groupStart) groupStart = shelfStart;
      }
      if (shelfEnd !== null) {
        if (groupEnd === null || shelfEnd > groupEnd) groupEnd = shelfEnd;
      }

      const l3Cat = l3Key !== null ? cats.get(l3Key) : undefined;
      const shelfPayload: ShelvesPayload["groups"][number]["shelves"][number] = {
        l3: ref(l3Cat),
        segments: grid.map((seg) => ({
          key: seg.key,
          label: seg.label,
          alias: seg.alias ?? null,
          start: displayDate(seg.start),
          end: displayDate(seg.end),
          count: counts[seg.key] ?? 0,
        })),
        config: {
          scope,
          l2_id: l2Key,
          l3_id: l3Key,
          mode: config.mode,
          params: (config.params ?? {}) as Record<string, unknown>,
        },
        counts,
        total: shelfPkgIds.size,
      };
      if (includePackages) shelfPayload.packages = placements;
      shelvesPayload.push(shelfPayload);
    }

    groupsPayload.push({
      l2: ref(l2Cat),
      range:
        groupStart !== null && groupEnd !== null
          ? { start: displayDate(groupStart), end: displayDate(groupEnd) }
          : null,
      has_undated: hasUndated,
      shelves: shelvesPayload,
      total: groupPkgIds.size,
    });
  }

  return {
    l1: { id: l1.id, name: l1.name },
    groups: groupsPayload,
    total: seenPkgIdsTotal.size,
  };
}

