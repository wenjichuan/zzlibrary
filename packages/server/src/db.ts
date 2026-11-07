/** 数据库（node:sqlite）：建表 DDL 与 SQLAlchemy create_all 产物兼容（存量 DB 直接可用），
 * 附 uuid 回填迁移（跨端同步契约的身份列）与包目录名迁移。 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, readdirSync, renameSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cleanPackageName } from "@zzlibrary/core";
import type { Settings } from "./config";

/** UTC 当前时刻 → 与 SQLAlchemy DateTime 存储一致的定宽文本（含 6 位微秒）。
 * 设备内严格单调（同毫秒/时钟回拨时推进 1ms）——同步 LWW 的时间戳依据。 */
let lastNowMs = 0;
export function nowSqlite(): string {
  const wall = Date.now();
  const ms = wall > lastNowMs ? wall : lastNowMs + 1;
  lastNowMs = ms;
  const d = new Date(ms);
  return (
    d.toISOString().slice(0, 19).replace("T", " ") +
    "." +
    String(d.getUTCMilliseconds()).padStart(3, "0") +
    "000"
  );
}

/** 库内 DATETIME 文本 → ISO 文本（T 分隔；等价 Python datetime.isoformat()）。 */
export function isoFromSqlite(text: string): string {
  return text.replace(" ", "T");
}

const DDL = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER NOT NULL PRIMARY KEY,
  level INTEGER NOT NULL,
  parent_id INTEGER REFERENCES categories (id) ON DELETE RESTRICT,
  name VARCHAR(200) NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_categories_parent_id ON categories (parent_id);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER NOT NULL PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  authors JSON NOT NULL,
  publish_date VARCHAR(11),
  publisher VARCHAR(300),
  tags JSON NOT NULL,
  notes TEXT,
  status VARCHAR(20) NOT NULL,
  file_count INTEGER NOT NULL,
  total_size INTEGER NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_packages_title ON packages (title);
CREATE INDEX IF NOT EXISTS ix_packages_publish_date ON packages (publish_date);
CREATE INDEX IF NOT EXISTS ix_packages_status ON packages (status);

CREATE TABLE IF NOT EXISTS package_paths (
  id INTEGER NOT NULL PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  l1_id INTEGER NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  l2_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  l3_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  CONSTRAINT uq_package_path UNIQUE (package_id, l1_id, l2_id, l3_id)
);
CREATE INDEX IF NOT EXISTS ix_package_paths_package_id ON package_paths (package_id);
CREATE INDEX IF NOT EXISTS ix_package_paths_l1_id ON package_paths (l1_id);
CREATE INDEX IF NOT EXISTS ix_package_paths_l2_id ON package_paths (l2_id);
CREATE INDEX IF NOT EXISTS ix_package_paths_l3_id ON package_paths (l3_id);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER NOT NULL PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  name VARCHAR(500) NOT NULL,
  format VARCHAR(20) NOT NULL,
  file_path VARCHAR(1000) NOT NULL,
  file_size INTEGER NOT NULL,
  page_count INTEGER,
  sort_order INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_files_package_id ON files (package_id);

CREATE TABLE IF NOT EXISTS segment_configs (
  id INTEGER NOT NULL PRIMARY KEY,
  scope VARCHAR(10) NOT NULL,
  l2_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  l3_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  mode VARCHAR(20) NOT NULL,
  params JSON NOT NULL,
  CONSTRAINT uq_segment_scope UNIQUE (scope, l2_id, l3_id)
);
CREATE INDEX IF NOT EXISTS ix_segment_configs_l2_id ON segment_configs (l2_id);
CREATE INDEX IF NOT EXISTS ix_segment_configs_l3_id ON segment_configs (l3_id);

CREATE TABLE IF NOT EXISTS reading_progress (
  file_id INTEGER NOT NULL PRIMARY KEY REFERENCES files (id) ON DELETE CASCADE,
  locator JSON NOT NULL,
  percent FLOAT NOT NULL,
  updated_at DATETIME NOT NULL
);
`;

export function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** 结构迁移：
 * 1) 建表（新库）；
 * 2) uuid 回填——packages/files/categories/package_paths 增加 uuid 列（TEXT 32hex + 唯一索引），
 *    作为跨端同步契约的实体身份（本地整型主键保留为设备内代理键）；
 * 3) 无 uuid 的旧行补齐；
 * 4) 同步契约列（updated_at / files.sha256 / files.local / packages.cover_sha256+palette）
 *    与同步状态表。幂等。 */
export function migrate(db: DatabaseSync): void {
  db.exec(DDL);
  for (const table of ["packages", "files", "categories", "package_paths"]) {
    const cols = columnsOf(db, table);
    if (!cols.has("uuid")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN uuid TEXT`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ix_${table}_uuid ON ${table} (uuid)`);
    }
    const missing = db.prepare(`SELECT id FROM ${table} WHERE uuid IS NULL`).all() as Array<{ id: number }>;
    if (missing.length > 0) {
      const fill = db.prepare(`UPDATE ${table} SET uuid = ? WHERE id = ?`);
      for (const row of missing) {
        fill.run(randomUUID().replaceAll("-", ""), row.id);
      }
    }
  }
  // 同步契约列（幂等）
  const backfill = nowSqlite();
  addColumn(db, "files", "sha256", "TEXT");
  addColumn(db, "files", "local", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "files", "updated_at", "DATETIME", backfill);
  addColumn(db, "package_paths", "updated_at", "DATETIME", backfill);
  addColumn(db, "categories", "updated_at", "DATETIME"); // 下方按 created_at 回填
  addColumn(db, "packages", "cover_sha256", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS ix_packages_cover_sha256 ON packages (cover_sha256)"); // 旧库列由上一行 ALTER 补齐后再建索引
  addColumn(db, "packages", "palette", "TEXT");
  addColumn(db, "segment_configs", "updated_at", "DATETIME", backfill);
  db.exec("UPDATE categories SET updated_at = COALESCE(updated_at, created_at)");
  // 同步状态表（设备本地，不同步自身）
  db.exec(`
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_manifest_cache (
  path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_blob_cache (
  sha256 TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS sync_baselines (
  path TEXT PRIMARY KEY,
  env TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_tombstones (
  path TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  blob_refs TEXT
);
CREATE TABLE IF NOT EXISTS sync_manifest_build (
  path TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  text TEXT NOT NULL,
  stamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_files_sha256 ON files (sha256);
`);
  // 墓碑携带内容块引用（删除记账在云端墓碑里，任何设备可 GC）；旧表补列
  addColumn(db, "sync_tombstones", "blob_refs", "TEXT");
  // 移除短暂的本地 GC 记账表（方案改为云端墓碑记账）
  db.exec("DROP TABLE IF EXISTS sync_gc_pending");
}

function addColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  typeClause: string,
  backfillValue?: string,
): void {
  const cols = columnsOf(db, table);
  if (cols.has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeClause}`);
  if (backfillValue !== undefined) {
    db.prepare(`UPDATE ${table} SET ${column} = COALESCE(${column}, ?)`).run(backfillValue);
  }
}

/** 新实体 uuid 生成。 */
export function newUuid(): string {
  return randomUUID().replaceAll("-", "");
}

/** 包目录从 {id} 迁移为 {入库日期}_{id}_{包名}（幂等，自 Python db.migrate_package_dirs 平移）。 */
export function migratePackageDirs(settings: Settings, db: DatabaseSync): void {
  if (!existsSync(settings.dbPath) || !existsSync(settings.filesDir)) return;
  const rows = db
    .prepare("SELECT id, title, created_at FROM packages")
    .all() as Array<{ id: number; title: string; created_at: string }>;
  for (const { id, title, created_at } of rows) {
    const oldPath = join(settings.filesDir, String(id));
    if (!existsSync(oldPath)) continue;
    const datePart = String(created_at).slice(0, 10) || "unknown";
    const newName = `${datePart}_${id}_${cleanPackageName(title ?? "")}`;
    const newPath = join(settings.filesDir, newName);
    if (newPath === oldPath || existsSync(newPath)) continue;
    renameSync(oldPath, newPath);
    db.prepare(
      "UPDATE files SET file_path = REPLACE(file_path, ?, ?) WHERE package_id = ?",
    ).run(`files/${id}/`, `files/${newName}/`, id);
  }
}

/** 启动兜底：清掉超期暂存（>24h）。 */
export function purgeStaleStaging(settings: Settings): void {
  if (!existsSync(settings.stagingDir)) return;
  const now = Date.now();
  for (const entry of readdirSync(settings.stagingDir)) {
    const p = join(settings.stagingDir, entry);
    try {
      const s = statSync(p);
      if (s.isDirectory() && now - s.mtimeMs > 24 * 3600 * 1000) {
        rmSync(p, { recursive: true, force: true });
      }
    } catch {
      continue;
    }
  }
}

// ---------- 语句缓存与事务 ----------

const stmtCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** 预编译语句缓存（node:sqlite 无内置缓存；按连接隔离）。热点路径用 pstmt 代替 db.prepare。 */
export function pstmt(db: DatabaseSync, sql: string): StatementSync {
  let m = stmtCache.get(db);
  if (m === undefined) {
    m = new Map();
    stmtCache.set(db, m);
  }
  let s = m.get(sql);
  if (s === undefined) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}

/** 同步事务：包裹纯同步的 DB+fs 写段（段内绝不能 await——单连接下异步交错会钻进别人的事务）。 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
