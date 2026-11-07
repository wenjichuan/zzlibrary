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

/** 书架侧视概览：SQL GROUP BY 聚合计数（(包,l2,l3) 三元组去重语义下推），零包体装载零 N+1——大馆藏的默认入口。
 * 返回与 ShelvesDetail 同构的轻载荷（segments 空、无 packages），前端 buildRackVMs 直接消费。 */
shelvesRouter.get("/api/shelves/:l1Id/overview", (c) => {
  const db = c.get("db");
  const l1 = l1Or404(db, Number(c.req.param("l1Id")));
  const grp = db
    .prepare(
      "SELECT pp.l2_id AS l2_id, COUNT(DISTINCT pp.package_id) AS total," +
        " MIN(p.publish_date) AS rmin, MAX(p.publish_date) AS rmax," +
        " MAX(CASE WHEN p.publish_date IS NULL THEN 1 ELSE 0 END) AS has_und" +
        " FROM package_paths pp JOIN packages p ON p.id = pp.package_id WHERE pp.l1_id = ? GROUP BY pp.l2_id",
    )
    .all(l1.id) as Array<{ l2_id: number | null; total: number; rmin: string | null; rmax: string | null; has_und: number }>;
  const sub = db
    .prepare(
      "SELECT pp.l2_id AS l2_id, pp.l3_id AS l3_id, COUNT(DISTINCT pp.package_id) AS total" +
        " FROM package_paths pp WHERE pp.l1_id = ? GROUP BY pp.l2_id, pp.l3_id",
    )
    .all(l1.id) as Array<{ l2_id: number | null; l3_id: number | null; total: number }>;
  const total = (db
    .prepare("SELECT COUNT(DISTINCT package_id) AS n FROM package_paths WHERE l1_id = ?")
    .get(l1.id) as { n: number }).n;

  const subByGroup = new Map<number | null, Array<{ l3: { id: number; name: string } | null; total: number }>>();
  for (const s of sub) {
    const l3cat = s.l3_id === null ? null : getCategory(db, s.l3_id);
    const arr = subByGroup.get(s.l2_id) ?? [];
    arr.push({ l3: l3cat ? { id: l3cat.id, name: l3cat.name } : null, total: s.total });
    subByGroup.set(s.l2_id, arr);
  }
  const groups = grp
    .map((g) => {
      const l2cat = g.l2_id === null ? null : getCategory(db, g.l2_id);
      return {
        cat: l2cat,
        g,
        shelves: (subByGroup.get(g.l2_id) ?? []).map((s) => ({
          l3: s.l3,
          segments: [] as unknown[],
          config: { scope: "l3", l2_id: g.l2_id, l3_id: s.l3?.id ?? null, mode: "year", params: {} },
          counts: {},
          total: s.total,
        })),
      };
    })
    .sort((a, b) => (a.cat?.sort_order ?? Infinity) - (b.cat?.sort_order ?? Infinity))
    .map(({ cat, g, shelves }) => ({
      l2: cat ? { id: cat.id, name: cat.name } : null,
      range: g.rmin !== null ? { start: g.rmin, end: g.rmax } : null,
      has_undated: g.has_und === 1,
      shelves,
      total: g.total,
    }));
  return c.json({ l1: { id: l1.id, name: l1.name }, groups, total });
});

/** 单架详情（正面时间轴入口）：只装载该二级组的包（formats 批量聚合），进架才拉包体——替代整 L1 全量 with_packages。 */
shelvesRouter.get("/api/shelves/:l1Id/rack", (c) => {
  const db = c.get("db");
  const l1 = l1Or404(db, Number(c.req.param("l1Id")));
  const l2Raw = c.req.query("l2") ?? "";
  const l2None = l2Raw === "none";
  const l2Id = l2None ? null : Number(l2Raw);
  if (!l2None && !Number.isInteger(l2Id)) throw new HTTPException(422, { message: "l2 需为数字 id 或 none" });

  const cond = l2None ? "pp.l1_id = ? AND pp.l2_id IS NULL" : "pp.l1_id = ? AND pp.l2_id = ?";
  const args: Array<number> = l2None ? [l1.id] : [l1.id, l2Id!];
  const rows = db
    .prepare(`SELECT * FROM packages WHERE EXISTS (SELECT 1 FROM package_paths pp WHERE pp.package_id = packages.id AND ${cond}) ORDER BY packages.id`)
    .all(...args) as RawPkg[];
  const pkgs = attachRackRelations(db, rows);
  const cats = collectCats(db, pkgs);
  return c.json(buildShelves({ id: l1.id, name: l1.name }, pkgs, cats, loadConfigRows(db), true));
});

/** 批量补挂 formats（只要 format 列）与 paths——单架包集的两条 IN 查询，替代每包 2 条的 N+1。 */
function attachRackRelations(db: Env["Variables"]["db"], rows: RawPkg[]): AggPackage[] {
  const ids = rows.map((r) => r.id);
  const formatsBy = new Map<number, Set<string>>();
  const pathsBy = new Map<number, Array<{ l1_id: number; l2_id: number | null; l3_id: number | null }>>();
  const chunkIn = (n = 400) => {
    const outArr: number[][] = [];
    for (let i = 0; i < ids.length; i += n) outArr.push(ids.slice(i, i + n));
    return outArr;
  };
  for (const chunk of chunkIn()) {
    const ph = chunk.map(() => "?").join(",");
    for (const f of db
      .prepare(`SELECT package_id, format FROM files WHERE package_id IN (${ph})`)
      .all(...chunk) as Array<{ package_id: number; format: string }>) {
      const set = formatsBy.get(f.package_id) ?? new Set<string>();
      set.add(f.format);
      formatsBy.set(f.package_id, set);
    }
    for (const p of db
      .prepare(`SELECT package_id, l1_id, l2_id, l3_id FROM package_paths WHERE package_id IN (${ph}) ORDER BY id`)
      .all(...chunk) as Array<{ package_id: number; l1_id: number; l2_id: number | null; l3_id: number | null }>) {
      const arr = pathsBy.get(p.package_id) ?? [];
      arr.push({ l1_id: p.l1_id, l2_id: p.l2_id, l3_id: p.l3_id });
      pathsBy.set(p.package_id, arr);
    }
  }
  return rows.map((r) => {
    let authors: string[] = [];
    try {
      authors = JSON.parse(r.authors);
    } catch {
      /* 防御 */
    }
    return {
      id: r.id,
      title: r.title,
      authors,
      publish_date: r.publish_date,
      created_at: isoFromSqlite(r.created_at),
      file_count: r.file_count,
      status: r.status,
      formats: [...(formatsBy.get(r.id) ?? new Set<string>())],
      paths: pathsBy.get(r.id) ?? [],
    };
  });
}

/** 从包路径收集分类字典（buildShelves 的 cats 入参）。 */
function collectCats(db: Env["Variables"]["db"], pkgs: AggPackage[]): Map<number, AggCategory> {
  const catIds = new Set<number>();
  for (const p of pkgs) {
    for (const path of p.paths) {
      catIds.add(path.l1_id);
      if (path.l2_id !== null) catIds.add(path.l2_id);
      if (path.l3_id !== null) catIds.add(path.l3_id);
    }
  }
  const cats = new Map<number, AggCategory>();
  if (catIds.size > 0) {
    const ph = [...catIds].map(() => "?").join(",");
    for (const row of db
      .prepare(`SELECT id, name, sort_order FROM categories WHERE id IN (${ph})`)
      .all(...catIds) as Array<{ id: number; name: string; sort_order: number }>) {
      cats.set(row.id, row);
    }
  }
  return cats;
}

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
