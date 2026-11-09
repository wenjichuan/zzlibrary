/** 数据库（node:sqlite）：单一 DDL 即全部 schema（uuid/内容寻址/展示列都直接建在表上——
 * 1.0 未发布无存量库要迁移，ALTER/回填类迁移已随上线前清理移除）；
 * 幂等；不删除旧调试库可能残留的 sync_* 表（1.1 若启用同步可续用基线）。 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Settings } from "./config";

/** UTC 当前时刻 → 定宽文本（含 6 位微秒）。设备内严格单调（同毫秒/时钟回拨时推进 1ms）。 */
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

/** 库内 DATETIME 文本 → ISO 文本（T 分隔）。 */
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
  created_at DATETIME NOT NULL,
  updated_at DATETIME,
  uuid TEXT
);
CREATE INDEX IF NOT EXISTS ix_categories_parent_id ON categories (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_categories_uuid ON categories (uuid);

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
  updated_at DATETIME NOT NULL,
  cover_sha256 TEXT,
  palette TEXT,
  uuid TEXT
);
CREATE INDEX IF NOT EXISTS ix_packages_title ON packages (title);
CREATE INDEX IF NOT EXISTS ix_packages_publish_date ON packages (publish_date);
CREATE INDEX IF NOT EXISTS ix_packages_created_id ON packages (created_at, id); -- 「最新入库」排序免全表扫+排序（深翻页也不走临时排序）
CREATE INDEX IF NOT EXISTS ix_packages_status ON packages (status);
CREATE INDEX IF NOT EXISTS ix_packages_cover_sha256 ON packages (cover_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ix_packages_uuid ON packages (uuid);

CREATE TABLE IF NOT EXISTS package_paths (
  id INTEGER NOT NULL PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  l1_id INTEGER NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  l2_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  l3_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  updated_at DATETIME,
  uuid TEXT,
  CONSTRAINT uq_package_path UNIQUE (package_id, l1_id, l2_id, l3_id)
);
CREATE INDEX IF NOT EXISTS ix_package_paths_package_id ON package_paths (package_id);
CREATE INDEX IF NOT EXISTS ix_package_paths_l1_id ON package_paths (l1_id);
CREATE INDEX IF NOT EXISTS ix_package_paths_l2_id ON package_paths (l2_id);
CREATE INDEX IF NOT EXISTS ix_package_paths_l3_id ON package_paths (l3_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_package_paths_uuid ON package_paths (uuid);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER NOT NULL PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  name VARCHAR(500) NOT NULL,
  format VARCHAR(20) NOT NULL,
  file_path VARCHAR(1000) NOT NULL,
  file_size INTEGER NOT NULL,
  page_count INTEGER,
  sort_order INTEGER NOT NULL,
  sha256 TEXT,
  local INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME,
  uuid TEXT
);
CREATE INDEX IF NOT EXISTS ix_files_package_id ON files (package_id);
CREATE INDEX IF NOT EXISTS ix_files_sha256 ON files (sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ix_files_uuid ON files (uuid);

CREATE TABLE IF NOT EXISTS segment_configs (
  id INTEGER NOT NULL PRIMARY KEY,
  scope VARCHAR(10) NOT NULL,
  l2_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  l3_id INTEGER REFERENCES categories (id) ON DELETE CASCADE,
  mode VARCHAR(20) NOT NULL,
  params JSON NOT NULL,
  updated_at DATETIME,
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
  // WAL 下 NORMAL 的崩溃语义：最多丢最后一个事务、库文件绝不损坏（SQLite 官方推荐搭配）。
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

/** 建表 + 应用级 KV + FTS 索引一次性重建（幂等）。 */
export function migrate(db: DatabaseSync): void {
  db.exec(DDL);
  db.exec(`
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
  // 全文搜索（trigram 分词：支持中文子串；≥3 字查询走 FTS，短查询回退 LIKE）
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS packages_fts USING fts5(
  title, authors, publisher, tags, notes,
  content='packages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS trg_packages_fts_ai AFTER INSERT ON packages BEGIN
  INSERT INTO packages_fts(rowid, title, authors, publisher, tags, notes)
  VALUES (new.id, new.title, new.authors, new.publisher, new.tags, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS trg_packages_fts_ad AFTER DELETE ON packages BEGIN
  INSERT INTO packages_fts(packages_fts, rowid, title, authors, publisher, tags, notes)
  VALUES ('delete', old.id, old.title, old.authors, old.publisher, old.tags, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS trg_packages_fts_au AFTER UPDATE OF title, authors, publisher, tags, notes ON packages BEGIN
  INSERT INTO packages_fts(packages_fts, rowid, title, authors, publisher, tags, notes)
  VALUES ('delete', old.id, old.title, old.authors, old.publisher, old.tags, old.notes);
  INSERT INTO packages_fts(rowid, title, authors, publisher, tags, notes)
  VALUES (new.id, new.title, new.authors, new.publisher, new.tags, new.notes);
END;
`);
  // 存量索引一次性重建。守卫必须用持久旗标——外部内容 FTS 表的 COUNT(*) 报的是内容表行数，
  // 空索引也会「对得上」，按计数判断永远不会触发重建（已实测踩坑）。
  const flag = db.prepare("SELECT value FROM app_state WHERE key = 'fts_v1_rebuilt'").get() as
    | { value: string }
    | undefined;
  if (flag === undefined) {
    db.exec("INSERT INTO packages_fts(packages_fts) VALUES ('rebuild')");
    db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('fts_v1_rebuilt', '1')").run();
  }
  // 状态词改语言无关键（i18n 前置）：旧调试库的中文存量值一次性归一（幂等；新库无此数据）
  db.exec(
    "UPDATE packages SET status = CASE status" +
      " WHEN '在读' THEN 'reading' WHEN '已读' THEN 'done' WHEN '未读' THEN 'unread'" +
      " ELSE status END",
  );
}

/** 新实体 uuid 生成。 */
export function newUuid(): string {
  return randomUUID().replaceAll("-", "");
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
