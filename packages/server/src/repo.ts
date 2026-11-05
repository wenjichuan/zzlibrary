/** 包/文件/路径的数据访问与 API 序列化（对应 Python packages.py 的 _package_out 等）。 */
import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { computePackageStatus, displayDate } from "@zzlibrary/core";
import { isoFromSqlite } from "./db";
import { getCategory, type CategoryRow } from "./deps";

export interface FileRow {
  id: number;
  package_id: number;
  name: string;
  format: string;
  file_path: string;
  file_size: number;
  page_count: number | null;
  sort_order: number;
}

export interface PackagePathRow {
  id: number;
  package_id: number;
  l1_id: number;
  l2_id: number | null;
  l3_id: number | null;
}

export interface PackageRow {
  id: number;
  title: string;
  authors: string; // JSON text
  publish_date: string | null;
  publisher: string | null;
  tags: string; // JSON text
  notes: string | null;
  status: string;
  file_count: number;
  total_size: number;
  created_at: string;
  updated_at: string;
}

export interface ProgressRow {
  file_id: number;
  locator: string; // JSON text
  percent: number;
  updated_at: string;
}

export interface PackageFull {
  row: PackageRow;
  files: FileRow[]; // sort_order, id 升序
  paths: PackagePathRow[]; // id 升序
}

export function loadFiles(db: DatabaseSync, packageId: number): FileRow[] {
  return db
    .prepare("SELECT * FROM files WHERE package_id = ? ORDER BY sort_order, id")
    .all(packageId) as FileRow[];
}

export function loadPaths(db: DatabaseSync, packageId: number): PackagePathRow[] {
  return db
    .prepare("SELECT * FROM package_paths WHERE package_id = ? ORDER BY id")
    .all(packageId) as PackagePathRow[];
}

export function getPackageFull(db: DatabaseSync, packageId: number): PackageFull | null {
  const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId) as
    | PackageRow
    | undefined;
  if (!row) return null;
  return { row, files: loadFiles(db, packageId), paths: loadPaths(db, packageId) };
}

export function getPackageOr404(db: DatabaseSync, packageId: number): PackageFull {
  const pkg = getPackageFull(db, packageId);
  if (pkg === null) throw new HTTPException(404, { message: "资料包不存在" });
  return pkg;
}

function parseJsonArray(text: string): string[] {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export interface PackageOutJson {
  id: number;
  title: string;
  authors: string[];
  classifications: Array<{
    l1: { id: number; name: string };
    l2: { id: number; name: string } | null;
    l3: { id: number; name: string } | null;
  }>;
  publish_date: string | null;
  publisher: string | null;
  tags: string[];
  status: string;
  file_count: number;
  total_size: number;
  notes: string | null;
  created_at: string;
}

export function packageOut(db: DatabaseSync, pkg: PackageFull, catCache: Map<number, CategoryRow | null>): PackageOutJson {
  const cat = (cid: number | null): CategoryRow | null => {
    if (cid === null) return null;
    if (!catCache.has(cid)) catCache.set(cid, getCategory(db, cid));
    return catCache.get(cid) ?? null;
  };
  const r = pkg.row;
  const classifications: PackageOutJson["classifications"] = [];
  for (const p of pkg.paths) {
    const l1c = cat(p.l1_id);
    if (l1c === null) continue; // 防御：悬挂路径（正常不会出现）
    const l2c = cat(p.l2_id);
    const l3c = cat(p.l3_id);
    classifications.push({
      l1: { id: l1c.id, name: l1c.name },
      l2: l2c ? { id: l2c.id, name: l2c.name } : null,
      l3: l3c ? { id: l3c.id, name: l3c.name } : null,
    });
  }
  return {
    id: r.id,
    title: r.title,
    authors: parseJsonArray(r.authors),
    classifications,
    publish_date: displayDate(r.publish_date),
    publisher: r.publisher,
    tags: parseJsonArray(r.tags),
    status: r.status,
    file_count: r.file_count,
    total_size: r.total_size,
    notes: r.notes,
    created_at: isoFromSqlite(r.created_at),
  };
}

export interface ProgressOutJson {
  file_id: number;
  locator: Record<string, unknown>;
  percent: number;
  updated_at: string;
}

export function progressOut(p: ProgressRow | null | undefined): ProgressOutJson | null {
  if (!p) return null;
  let locator: Record<string, unknown> = {};
  try {
    locator = JSON.parse(p.locator) as Record<string, unknown>;
  } catch {
    locator = {};
  }
  return {
    file_id: p.file_id,
    locator,
    percent: p.percent,
    updated_at: isoFromSqlite(p.updated_at),
  };
}

export function getProgress(db: DatabaseSync, fileId: number): ProgressRow | null {
  return (db.prepare("SELECT * FROM reading_progress WHERE file_id = ?").get(fileId) as
    | ProgressRow
    | undefined) ?? null;
}

export interface FileDetailJson {
  id: number;
  name: string;
  format: string;
  file_size: number;
  page_count: number | null;
  sort_order: number;
  has_cover: boolean;
  progress: ProgressOutJson | null;
}

export type PackageDetailJson = PackageOutJson & { files: FileDetailJson[] };

/** 包状态重算（写事件时调用）：由包内可读文件进度聚合。 */
export function recomputePackageStatus(db: DatabaseSync, packageId: number): void {
  const rows = db
    .prepare(
      "SELECT f.format AS format, p.percent AS percent FROM files f" +
        " LEFT JOIN reading_progress p ON p.file_id = f.id WHERE f.package_id = ?" +
        " ORDER BY f.sort_order, f.id",
    )
    .all(packageId) as Array<{ format: string; percent: number | null }>;
  const status = computePackageStatus(
    rows.map((r) => ({ format: r.format, percent: r.percent === null ? null : Number(r.percent) })),
  );
  db.prepare("UPDATE packages SET status = ? WHERE id = ?").run(status, packageId);
}

/** 冗余计数同步（文件增删后）。 */
export function syncCounts(db: DatabaseSync, packageId: number): void {
  const agg = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS s FROM files WHERE package_id = ?")
    .get(packageId) as { n: number; s: number };
  db.prepare("UPDATE packages SET file_count = ?, total_size = ? WHERE id = ?").run(
    agg.n,
    agg.s,
    packageId,
  );
}

/** 启动对账：按当前规则重算所有包状态（幂等，返回变化数）。 */
export function recomputeAllPackageStatuses(db: DatabaseSync): number {
  const ids = db.prepare("SELECT id, status FROM packages").all() as Array<{ id: number; status: string }>;
  let changed = 0;
  for (const { id, status } of ids) {
    const before = status;
    recomputePackageStatus(db, id);
    const after = (db.prepare("SELECT status FROM packages WHERE id = ?").get(id) as { status: string }).status;
    if (after !== before) changed += 1;
  }
  return changed;
}
