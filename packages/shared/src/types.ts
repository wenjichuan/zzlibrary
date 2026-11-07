import type { FullSyncReport, ShelvesPayload } from "@zzlibrary/core";

/** 与后端 schemas.py 对齐的类型定义（资料包模型）。 */

export type BookStatus = "未读" | "在读" | "已读";
export type SegmentMode = "year" | "n_years" | "decade" | "month" | "custom";

export interface CategoryRef {
  id: number;
  name: string;
}

export interface CategoryNode {
  id: number;
  level: number;
  parent_id: number | null;
  name: string;
  sort_order: number;
  children: CategoryNode[];
}

/** 包内文件 */
export interface FileItem {
  id: number;
  name: string;
  format: string;
  file_size: number;
  page_count: number | null;
  sort_order: number;
}

export interface FileDetail extends FileItem {
  has_cover: boolean;
  /** 设备本地是否有字节（false=云端，读取时透明取回） */
  local?: boolean;
  progress: Progress | null;
}

/** 一条已解析的分类路径 */
export interface CategoryPath {
  l1: CategoryRef;
  l2: CategoryRef | null;
  l3: CategoryRef | null;
}

/** 一条待写入的分类路径（l1 可空 = 未选择） */
export interface PathInput {
  l1_id: number | null;
  l2_id: number | null;
  l3_id: number | null;
}

export interface Package {
  id: number;
  title: string;
  authors: string[];
  classifications: CategoryPath[];
  publish_date: string | null;
  publisher: string | null;
  tags: string[];
  status: BookStatus | string;
  file_count: number;
  total_size: number;
  notes: string | null;
  created_at: string;
}

export interface PackageDetail extends Package {
  files: FileDetail[];
  /** 是否有真封面（false=本地生成的占位封面；存量 PDF 补齐用） */
  has_real_cover?: boolean;
  /** 是否可安全释放本地字节（已配置云且本地现存内容全部确认上云） */
  can_release?: boolean;
}

export interface PackagePage {
  total: number;
  page: number;
  page_size: number;
  items: Package[];
}

export interface PackageMetaInput {
  title: string;
  authors: string[];
  classifications: PathInput[];
  publish_date: string | null;
  publisher: string | null;
  tags: string[];
  notes: string | null;
}

export interface StageMeta {
  title: string | null;
  authors: string[];
  publish_date: string | null;
  publisher: string | null;
  page_count: number | null;
}

export interface StagedFile {
  stage_id: string;
  filename: string;
  size: number;
  format: string;
  meta: StageMeta;
  has_cover: boolean;
}

export interface SegmentConfig {
  scope: string; // global / l2 / l3
  l2_id: number | null;
  l3_id?: number | null;
  mode: SegmentMode | string;
  params: Record<string, unknown>;
}

export interface SegmentConfigBundle {
  global: SegmentConfig;
  overrides: SegmentConfig[];
}

export interface CustomRange {
  label?: string;
  alias?: string;
  start: string;
  end: string;
}

export interface ShelfSegment {
  key: string;
  label: string;
  alias?: string | null;
  start: string | null;
  end: string | null;
  count: number;
}

/** 组（二级分类）内比例时间轴的统一范围：各层分段并集 ∪ 藏书日期。 */
/** 馆藏统计（GET /api/stats，首页四卡） */
export interface Stats {
  packages: number;
  files: number;
  l1: number;
  l2: number;
  l3: number;
}

export interface ShelfPackage {
  id: number;
  title: string;
  authors: string[];
  publish_date: string | null;
  created_at: string;
  file_count: number;
  formats: string[];
  status: BookStatus | string;
}

export interface Progress {
  file_id: number;
  locator: Record<string, unknown>;
  percent: number;
  updated_at: string;
}

// ---------- 同步与备份（SyncReport/同步报告的 wire 形状以 core 同步引擎为单源） ----------

export interface SyncConfig {
  provider: "fs" | "webdav" | "s3";
  autoSync: boolean;
  fs?: { root: string };
  webdav?: { baseUrl: string; username?: string; password?: string; rootPath?: string };
  s3?: {
    endpoint: string; region: string; bucket: string;
    accessKeyId: string; secretAccessKey: string; prefix?: string;
  };
}

export interface GcReport {
  tombstonesRemoved: number;
  blobsRemoved: number;
  blobBytesRemoved: number;
  blobsSkippedReferenced: number;
  errors: string[];
}

export interface SyncStatus {
  configured: boolean;
  autoSync: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastReport: SyncReport | null;
  revision: number;
  pendingHashFiles: number;
  running: boolean;
}

/** 同步报告：core 引擎出参的别名（字段漂移在此编译期暴露）。 */
export type SyncReport = FullSyncReport;

/** 书架详情载荷：core buildShelves 出参的别名（server/web 与聚合器在此编译期绑定）。 */
export type ShelvesDetail = ShelvesPayload;
