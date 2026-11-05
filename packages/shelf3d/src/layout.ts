/** 布局算法（轴系 v2）：ShelvesDetail → 架/层/书位的几何参数。

- X = 时间轴：层前沿贴分段刻度尺，书按发布时间落入对应段，段内左→右排列
- Y(three z) = 二级分类：一组一架，沿排向排开
- Z(three y，竖直) = 三级分类：架内每层一个三级分类（侧板贴层标签）
- 数量由架上的书直接体现（段内并排，超出折行进深）
*/
import type { BookSlot, RackLayout, SceneData, SceneLayout } from "./types";

export const FLOOR_H = 0.72; // 层高（一个三级分类）
export const BOARD_T = 0.045; // 隔板厚
export const SIDE_T = 0.05; // 侧板厚
export const BASE_H = 0.12; // 底座高
export const BOOK_H = 0.52; // 书高
export const BOOK_D = 0.3; // 书深
export const BOOK_GAP = 0.015;
export const COL_W = 0.16; // 每本书列宽
export const SEGMENT_W = 0.95; // 每个时间段的宽度
export const BOOKS_PER_ROW = Math.floor(SEGMENT_W / COL_W); // 每段每行书数
export const RACK_GAP = 1.7; // 架间距
export const MIN_DEPTH = 0.5;

export function bookThickness(fileCount: number): number {
  return Math.min(0.05 + Math.max(1, fileCount) * 0.018, 0.13);
}

/** 计算完整场景布局。 */
export function computeLayout(data: SceneData): SceneLayout {
  const racks: RackLayout[] = [];
  let z = 0;

  for (const group of data.groups) {
    const key = `g${group.l2?.id ?? "none"}`;
    const label = group.l2?.name ?? "未分类";
    const segments = group.segments;
    const segCount = Math.max(segments.length, 1);

    // 层 = 三级分类（后端已按 sort_order 排好，未细分在最后）
    const floors = group.shelves.map((shelf) => ({
      label: shelf.l3?.name ?? "未细分",
      l3Id: shelf.l3?.id ?? null,
      books: [] as BookSlot[],
    }));

    let maxRows = 1;
    group.shelves.forEach((shelf, fi) => {
      const bySeg = new Map<number, BookSlot[]>();
      const sorted = [...(shelf.packages ?? [])].sort((a, b) => {
        const da = a.package.publish_date ?? "";
        const db = b.package.publish_date ?? "";
        if (da !== db) return da < db ? -1 : 1;
        return a.package.title.localeCompare(b.package.title, "zh");
      });
      for (const placement of sorted) {
        const segIndex = segments.findIndex((s) => s.key === placement.segment_key);
        if (segIndex < 0) continue;
        const slot: BookSlot = {
          pkg: placement.package,
          segmentIndex: segIndex,
          segmentKey: placement.segment_key,
          floorIndex: fi,
          col: 0,
          row: 0,
          thickness: bookThickness(placement.package.file_count),
        };
        const list = bySeg.get(segIndex) ?? [];
        list.push(slot);
        bySeg.set(segIndex, list);
      }
      for (const slots of bySeg.values()) {
        const rows = Math.ceil(slots.length / Math.max(BOOKS_PER_ROW, 1));
        slots.forEach((s, i) => {
          s.col = i % Math.max(BOOKS_PER_ROW, 1);
          s.row = Math.floor(i / Math.max(BOOKS_PER_ROW, 1));
        });
        maxRows = Math.max(maxRows, rows);
        floors[fi].books.push(...slots);
      }
    });

    const width = segCount * SEGMENT_W + 2 * SIDE_T + 0.16;
    const depth = Math.max(MIN_DEPTH, maxRows * (BOOK_D + BOOK_GAP) + 0.16);
    const height = BASE_H + floors.length * FLOOR_H + BOARD_T;

    racks.push({
      key,
      label,
      total: group.total,
      width,
      depth,
      height,
      floorCount: floors.length,
      segments,
      floors,
      z: z + depth / 2,
    });
    z += depth + RACK_GAP;
  }

  // 场景居中（z 方向）
  if (racks.length) {
    const zOffset = (racks[0].z - racks[0].depth / 2 + racks[racks.length - 1].z + racks[racks.length - 1].depth / 2) / 2;
    for (const r of racks) r.z -= zOffset;
  }

  const maxWidth = Math.max(...racks.map((r) => r.width), 1.5);

  return {
    racks,
    bounds: {
      minX: -maxWidth / 2,
      maxX: maxWidth / 2,
      minZ: racks.length ? racks[0].z - racks[0].depth / 2 : -1,
      maxZ: racks.length ? racks[racks.length - 1].z + racks[racks.length - 1].depth / 2 : 1,
      maxHeight: Math.max(...racks.map((r) => r.height), 1),
      totalBooks: racks.reduce((acc, r) => acc + r.floors.reduce((a, f) => a + f.books.length, 0), 0),
    },
  };
}

/** 书在架内的局部坐标。 */
export function bookLocalPosition(slot: BookSlot, rack: RackLayout) {
  const innerStart = -rack.width / 2 + SIDE_T + 0.08;
  const x = innerStart + slot.segmentIndex * SEGMENT_W + slot.col * COL_W + COL_W / 2;
  const y = BASE_H + slot.floorIndex * FLOOR_H + BOARD_T + BOOK_H / 2 + 0.012;
  const z = rack.depth / 2 - 0.1 - slot.row * (BOOK_D + BOOK_GAP);
  return { x, y, z };
}

/** 时间段在架内的 x 范围（刻度尺用）。 */
export function segmentXRange(segIndex: number, rack: RackLayout): [number, number] {
  const innerStart = -rack.width / 2 + SIDE_T + 0.08;
  return [innerStart + segIndex * SEGMENT_W, innerStart + (segIndex + 1) * SEGMENT_W];
}
