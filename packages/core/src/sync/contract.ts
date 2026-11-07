/** 同步契约：版本化清单的线上格式（wire format）。
 *
 * v2 云端布局（两级索引 + 分桶聚合，读端只认 library.json）：
 *   /library.json                       根索引：revision + 各集合桶索引的 sha256
 *   /db/<collection>.idx.json           集合桶索引：桶号 → 桶文件 sha256（稀疏，只列非空桶）
 *   /db/<collection>/<桶号>.json        桶聚合：{ entities: { <uuid>: 信封 } }（含墓碑 deleted=true）
 *   /blobs/<sha256前2位>/<sha256>       内容寻址不可变块（文件字节/封面图）
 *
 * v1→v2：清单从"每实体一文件"改为"每桶一文件"（1024 桶/集合，bucketOf 分桶）。
 * 云对象数 = min(实体数, 1024)/集合 与馆藏规模解耦；单实体编辑只重写所在桶；
 * 桶索引封顶 1024 条（~78KB）不随馆藏涨。设备侧的 manifestPath 仍为逐实体逻辑键
 * （缓存/基线/墓碑记账用），不再是云上真实路径。
 *
 * 原则：
 * - 本地 SQLite 是唯一工作副本，界面永不直接读清单；
 * - 清单只增不改语义（墓碑代替删除，实体永不出桶）→ 桶索引合并在并发下是安全的并集；
 * - blob 以内容哈希寻址 → 天然去重、永不冲突；
 * - encryption 字段预留（null=明文），将来客户端加密升 manifestVersion 渐进迁移。 */

export const MANIFEST_VERSION = 2;

/** 每集合桶数。10万包时单桶 ~34KB、100万包 ~340KB；桶索引封顶 1024 条不随馆藏涨。
 * 调整它 = 再升一次 manifestVersion + 云端全量重推。 */
export const BUCKET_COUNT = 1024;

/** 实体 → 桶号（补零 4 位十进制）。hex uuid 取前 8 位取模（v4 前缀全随机 → 均匀）；
 * 非 hex 键（segment-configs 的 global/l2-<uuid>/l3-<uuid>）用 FNV-1a。全设备确定性。 */
export function bucketOf(uuid: string): string {
  let n: number;
  if (/^[0-9a-f]{32}$/.test(uuid)) {
    n = parseInt(uuid.slice(0, 8), 16) % BUCKET_COUNT;
  } else {
    n = 0x811c9dc5;
    for (let i = 0; i < uuid.length; i++) {
      n ^= uuid.charCodeAt(i);
      n = Math.imul(n, 0x01000193) >>> 0;
    }
    n %= BUCKET_COUNT;
  }
  return String(n).padStart(4, "0");
}

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

/** 逐实体逻辑键（设备侧缓存/基线/墓碑记账的身份；v2 起不再是云上真实路径）。 */
export function manifestPath(kind: Collection, uuid: string): string {
  return `db/${kind}/${uuid.slice(0, 2)}/${uuid}.json`;
}

/** 桶文件云路径。 */
export function bucketPath(kind: Collection, bucket: string): string {
  return `db/${kind}/${bucket}.json`;
}

export function collectionIndexPath(kind: Collection): string {
  return `db/${kind}.idx.json`;
}

export function blobPath(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256}`;
}

export const LIBRARY_INDEX_PATH = "library.json";

/** 集合桶索引：桶号 → 桶文件 sha256（稀疏，只列非空桶）。 */
export type CollectionIndex = Record<string, string>;

/** 桶聚合文件内容。entities 键为 uuid，序列化按字典序（确定性字节 → 确定性哈希）。 */
export interface BucketAggregate {
  manifestVersion: number;
  kind: Collection;
  bucket: string;
  entities: Record<string, ManifestEnvelope>;
}

/** 桶聚合规范 JSON 文本（哈希与上传都用这份字节；uuid 字典序插入 → 插入序保留）。 */
export function bucketText(kind: Collection, bucket: string, envelopes: Iterable<ManifestEnvelope>): string {
  const entities: Record<string, ManifestEnvelope> = {};
  const keys: string[] = [];
  for (const env of envelopes) {
    keys.push(env.uuid);
    entities[env.uuid] = env;
  }
  keys.sort();
  const sorted: Record<string, ManifestEnvelope> = {};
  for (const k of keys) sorted[k] = entities[k]!;
  const agg: BucketAggregate = { manifestVersion: MANIFEST_VERSION, kind, bucket, entities: sorted };
  return JSON.stringify(agg);
}

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

/** 解析逻辑键 → { kind, uuid }（墓碑生成/桶归属推导用；键即身份）。 */
export function parseManifestPath(path: string): { kind: Collection; uuid: string } | null {
  const m = /^db\/([a-z-]+)\/[0-9a-z]{2}\/([A-Za-z0-9-]+)\.json$/.exec(path);
  if (!m) return null;
  if (!(COLLECTIONS as readonly string[]).includes(m[1]!)) return null;
  return { kind: m[1] as Collection, uuid: m[2]! };
}
