/** 数据库（node:sqlite）：建表 DDL 与 SQLAlchemy create_all 产物兼容（存量 DB 直接可用），
 * 附 uuid 回填迁移（跨端同步契约的身份列）与包目录名迁移。 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, renameSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cleanPackageName } from "@zzlibrary/core";
import type { Settings } from "./config";

/** UTC 当前时刻 → 与 SQLAlchemy DateTime 存储一致的定宽文本（含 6 位微秒）。 */
export function nowSqlite(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ") + ".000000";
}

/** Date → 同上格式（毫秒截断到微秒位补零）。 */
export function toSqliteText(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ") + ".000000";
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

CREATE TABLE IF NOT EXISTS package_paths (
  id INTEGER NOT NULL PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  l1_id INTEGER NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  l2_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  l3_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  CONSTRAINT uq_package_path UNIQUE (package_id, l1_id, l2_id, l3_id)
);
CREATE INDEX IF NOT EXISTS ix_package_paths_package_id ON package_paths (package_id);

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
 * 3) 无 uuid 的旧行补齐。幂等。 */
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
