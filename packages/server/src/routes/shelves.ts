/** 书架聚合 API：书架视图的数据源（以资料包为单位，多分类路径）。 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  buildShelves,
  computeGrid,
  displayDate,
  filterShelfPackages,
  resolveConfigWithScope,
  type AggCategory,
  type AggPackage,
  type SegmentConfigRow,
} from "@zzlibrary/core";
import type { Env } from "../env";
import { getCategory, parseIdFilter, type CategoryRow } from "../deps";
import { isoFromSqlite } from "../db";
import type { FileRow, PackageRow } from "../repo";

export const shelvesRouter = new Hono<Env>();

/** 馆藏统计（首页四卡）：纯 COUNT 轻端点——替代「拉 100 包列表算文件数」（超 100 包即错）的旧做法。 */
shelvesRouter.get("/api/stats", (c) => {
  const db = c.get("db");
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return c.json({
    packages: n("SELECT COUNT(*) AS n FROM packages"),
    files: n("SELECT COUNT(*) AS n FROM files"),
    l1: n("SELECT COUNT(*) AS n FROM categories WHERE level = 1"),
    l2: n("SELECT COUNT(*) AS n FROM categories WHERE level = 2"),
    l3: n("SELECT COUNT(*) AS n FROM categories WHERE level = 3"),
  });
});

function l1Or404(db: Env["Variables"]["db"], l1Id: number): CategoryRow {
  const c = getCategory(db, l1Id);
  if (c === null || c.level !== 1) throw new HTTPException(404, { message: "一级分类不存在" });
  return c;
}

interface RawPkg extends PackageRow {
  __files?: FileRow[];
  __paths?: Array<{ l1_id: number; l2_id: number | null; l3_id: number | null }>;
}

/** 加载至少一条路径属于该一级分类的包（含文件与路径）。 */
function loadL1Packages(db: Env["Variables"]["db"], l1Id: number): AggPackage[] {
  const rows = db
    .prepare(
      "SELECT * FROM packages WHERE EXISTS (SELECT 1 FROM package_paths pp WHERE pp.package_id = packages.id AND pp.l1_id = ?) ORDER BY packages.id",
    )
    .all(l1Id) as RawPkg[];
  const fileStmt = db.prepare("SELECT * FROM files WHERE package_id = ? ORDER BY sort_order, id");
  const pathStmt = db.prepare("SELECT l1_id, l2_id, l3_id FROM package_paths WHERE package_id = ? ORDER BY id");
  return rows.map((r) => {
    const files = fileStmt.all(r.id) as FileRow[];
    const paths = pathStmt.all(r.id) as Array<{ l1_id: number; l2_id: number | null; l3_id: number | null }>;
    let authors: string[] = [];
    try {
      authors = JSON.parse(r.authors);
    } catch { /* 防御 */ }
    return {
      id: r.id,
      title: r.title,
      authors,
      publish_date: r.publish_date,
      created_at: isoFromSqlite(r.created_at),
      file_count: r.file_count,
      status: r.status,
      formats: [...new Set(files.map((f) => f.format))],
      paths,
    };
  });
}

function loadConfigRows(db: Env["Variables"]["db"]): SegmentConfigRow[] {
  return (db.prepare("SELECT scope, l2_id, l3_id, mode, params FROM segment_configs").all() as Array<
    Omit<SegmentConfigRow, "params"> & { params: string }
  >).map((r) => {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(r.params);
    } catch { /* 防御 */ }
    return { ...r, params } as SegmentConfigRow;
  });
}

shelvesRouter.get("/api/shelves", (c) => {
  const db = c.get("db");
  const l1Id = Number(c.req.query("l1"));
  if (!Number.isInteger(l1Id)) throw new HTTPException(422, { message: "必须指定一级分类" });
  const includePackages = ["1", "true"].includes(c.req.query("with_packages") ?? "");
  const l1Cat = l1Or404(db, l1Id);
  const pkgs = loadL1Packages(db, l1Id);

  // 聚合用到的二级/三级分类
  const catIds = new Set<number>();
  const pathStmt = db.prepare("SELECT l2_id, l3_id FROM package_paths WHERE l1_id = ?");
  for (const p of pathStmt.all(l1Id) as Array<{ l2_id: number | null; l3_id: number | null }>) {
    if (p.l2_id !== null) catIds.add(p.l2_id);
    if (p.l3_id !== null) catIds.add(p.l3_id);
  }
  const cats = new Map<number, AggCategory>();
  if (catIds.size > 0) {
    const placeholders = [...catIds].map(() => "?").join(",");
    for (const row of db
      .prepare(`SELECT id, name, sort_order FROM categories WHERE id IN (${placeholders})`)
      .all(...catIds) as Array<{ id: number; name: string; sort_order: number }>) {
      cats.set(row.id, row);
    }
  }
  return c.json(buildShelves(l1Cat, pkgs, cats, loadConfigRows(db), includePackages));
});

shelvesRouter.get("/api/shelves/packages", (c) => {
  const db = c.get("db");
  const l1Id = Number(c.req.query("l1"));
  if (!Number.isInteger(l1Id)) throw new HTTPException(422, { message: "必须指定一级分类" });
  const l1Cat = l1Or404(db, l1Id);
  const [l2Id, l2None] = parseIdFilter(c.req.query("l2"));
  const [l3Id, l3None] = parseIdFilter(c.req.query("l3"));
  const segment = c.req.query("segment") ?? null;
  if (l2Id === null && !l2None) {
    throw new HTTPException(422, { message: "必须指定二级分类（数字 id 或 none）" });
  }

  const pkgs = loadL1Packages(db, l1Cat.id);
  const groupPkgs = pkgs.filter((p) =>
    p.paths.some(
      (path) => path.l1_id === l1Cat.id && (l2None ? path.l2_id === null : path.l2_id === l2Id),
    ),
  );
  // 组内去重后的包日期（同一包多条路径只计一次）；指定三级时用该层的覆盖配置
  const groupUnique = new Map(groupPkgs.map((p) => [p.id, p]));
  const configRows = loadConfigRows(db);
  const { config } = resolveConfigWithScope(configRows, l2None ? null : l2Id, l3None ? null : l3Id);
  const grid = computeGrid(
    [...groupUnique.values()].map((p) => p.publish_date),
    config,
  );
  const result = filterShelfPackages(pkgs, l1Cat.id, l2Id, l2None, l3Id, l3None, grid, segment);
  return c.json(
    result.map((p) => ({
      id: p.id,
      title: p.title,
      authors: p.authors,
      publish_date: displayDate(p.publish_date),
      file_count: p.file_count,
      formats: [...new Set(p.formats ?? [])].sort(),
      status: p.status,
    })),
  );
});
