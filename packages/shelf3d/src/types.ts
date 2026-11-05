/** 3D 书架场景的数据与布局类型（轴系 v2：X=时间、Y=二级、Z=三级）。 */

export interface ScenePackage {
  id: number;
  title: string;
  authors: string[];
  publish_date: string | null;
  file_count: number;
  formats: string[];
  status: string;
}

export interface ScenePlacement {
  segment_key: string;
  package: ScenePackage;
}

export interface SceneSegment {
  key: string;
  label: string;
  start: string | null;
  end: string | null;
  count: number;
}

export interface SceneShelf {
  l3: { id: number; name: string } | null;
  counts: Record<string, number>;
  total: number;
  packages: ScenePlacement[];
}

export interface SceneGroup {
  l2: { id: number; name: string } | null;
  segments: SceneSegment[];
  shelves: SceneShelf[];
  total: number;
}

export interface SceneData {
  l1: { id: number; name: string };
  groups: SceneGroup[];
  total: number;
}

/** 一本书（资料包）在场景中的最终放置。 */
export interface BookSlot {
  pkg: ScenePackage;
  segmentIndex: number; // 时间段序号（沿 X）
  segmentKey: string;
  floorIndex: number; // 层序号 = 三级分类（沿 Z 竖直）
  col: number; // 段内列
  row: number; // 段内折行
  thickness: number;
}

/** 一层 = 一个三级分类。 */
export interface FloorLayout {
  label: string;
  l3Id: number | null;
  books: BookSlot[];
}

/** 一架 = 一个二级分类。 */
export interface RackLayout {
  key: string;
  label: string;
  total: number; // 包数（组牌展示）
  width: number; // 沿 x（时间轴）
  depth: number; // 沿 z（折行进深）
  height: number;
  floorCount: number;
  segments: SceneSegment[];
  floors: FloorLayout[];
  z: number; // 架中心（three z）
}

export interface SceneLayout {
  racks: RackLayout[];
  bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    maxHeight: number;
    totalBooks: number;
  };
}

export type ViewMode = "aisle" | "shelf";
