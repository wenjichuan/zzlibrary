/** 同步契约：版本化清单的线上格式（wire format）。
 *
 * 云端布局（两级索引，读端只认 library.json）：
 *   /library.json                                根索引：revision + 各集合索引的 sha256
 *   /db/<collection>.json                        集合索引：清单相对路径 → 清单内容 sha256
 *   /db/<collection>/<uuid前2位>/<uuid>.json     实体清单（含墓碑 deleted=true）
 *   /blobs/<sha256前2位>/<sha256>                内容寻址不可变块（文件字节/封面图）
 *
 * 原则：
 * - 本地 SQLite 是唯一工作副本，界面永不直接读清单；
 * - 清单只增不改语义（墓碑代替删除，条目永不出索引）→ 索引合并在并发下是安全的并集；
 * - blob 以内容哈希寻址 → 天然去重、永不冲突；
 * - encryption 字段预留（null=明文），将来客户端加密升 manifestVersion 渐进迁移。 */

export const MANIFEST_VERSION = 1;

export type Collection =
  | "categories"
  | "packages"
  | "package-paths"
  | "files"
  | "progress"
  | "segment-configs";

export const COLLECTIONS: readonly Collection[] = [
  "categories",
  "packages",
  "package-paths",
  "files",
  "progress",
  "segment-configs",
];

/** 应用远端清单的顺序（引用先于被引用；progress 依赖 files 的本地落位）。 */
export const APPLY_ORDER: readonly Collection[] = [
  "categories",
  "segment-configs",
  "packages",
  "package-paths",
  "files",
  "progress",
];

// ---------- 实体数据（wire 格式：uuid 互引，无本地整型 id） ----------

export interface CategoryData {
  level: number;
  parentUuid: string | null;
  name: string;
  sortOrder: number;
  createdAt: string;
}

export interface PackageData {
  title: string;
  authors: string[];
  /** 规范日期键（-0221-01-01 形式），与库内存储一致 */
  publishDate: string | null;
  publisher: string | null;
  tags: string[];
  notes: string | null;
  /** 真封面内容块（null=本地确定性生成占位封面） */
  coverSha256: string | null;
  /** 书脊调色板（真封面不在本地时保证书脊颜色稳定） */
  palette: string[] | null;
  createdAt: string;
}

export interface PackagePathData {
  packageUuid: string;
  l1Uuid: string;
  l2Uuid: string | null;
  l3Uuid: string | null;
}

export interface FileData {
  packageUuid: string;
  name: string;
  format: string;
  sha256: string;
  size: number;
  pageCount: number | null;
  sortOrder: number;
}

export interface ProgressData {
  locator: Record<string, unknown>;
  percent: number;
}

export interface SegmentConfigData {
  scope: "global" | "l2" | "l3";
  scopeUuid: string | null;
  mode: string;
  params: Record<string, unknown>;
}

// ---------- 清单信封 ----------

export interface ManifestEnvelope<T = unknown> {
  manifestVersion: number;
  kind: Collection;
  /** segment-configs 用 "global"/"l2-<uuid>"/"l3-<uuid>"，其余为 32hex */
  uuid: string;
  /** 数据版本（LWW 依据；设备本地单调生成） */
  updatedAt: string;
  deleted: boolean;
  encryption: null;
  data: T;
}

/** 以固定键序构造信封 → JSON.stringify 确定性（data 对象也须固定键序构造）。 */
export function envelope<T>(
  kind: Collection,
  uuid: string,
  updatedAt: string,
  data: T,
  deleted = false,
): ManifestEnvelope<T> {
  return {
    manifestVersion: MANIFEST_VERSION,
    kind,
    uuid,
    updatedAt,
    deleted,
    encryption: null,
    data,
  };
}

/** 清单规范 JSON 文本（哈希与上传都用这份字节）。 */
export function manifestText(env: ManifestEnvelope): string {
  return JSON.stringify(env);
}

// ---------- 路径 ----------

export function manifestPath(kind: Collection, uuid: string): string {
  return `db/${kind}/${uuid.slice(0, 2)}/${uuid}.json`;
}

export function collectionIndexPath(kind: Collection): string {
  return `db/${kind}.json`;
}

export function blobPath(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256}`;
}

export const LIBRARY_INDEX_PATH = "library.json";

/** 集合索引：清单相对路径（含分桶目录） → 清单内容 sha256。 */
export type CollectionIndex = Record<string, string>;

export interface LibraryIndex {
  manifestVersion: number;
  /** 每次推送 +1；读端用它 + 集合哈希判断增量 */
  revision: number;
  collections: Partial<Record<Collection, string>>;
}

// ---------- 哈希 ----------

type DigestInput = Parameters<typeof crypto.subtle.digest>[1];

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as DigestInput);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** 解析清单路径 → { kind, uuid }（墓碑生成用；路径即身份）。 */
export function parseManifestPath(path: string): { kind: Collection; uuid: string } | null {
  const m = /^db\/([a-z-]+)\/[0-9a-z]{2}\/([A-Za-z0-9-]+)\.json$/.exec(path);
  if (!m) return null;
  if (!(COLLECTIONS as readonly string[]).includes(m[1]!)) return null;
  return { kind: m[1] as Collection, uuid: m[2]! };
}
