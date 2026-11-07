/** SQLite 版同步设备（LocalDevice 实现）：本地库 ↔ 清单的双向映射。
 * - buildManifests：全表快照 → 确定性清单（文件哈希缺失的行先跳过，等哈希回填后自愈）；
 * - applyRemote：decideApply/进度取大 + 三方字段合并（基线 sync_baselines）后落库，
 *   分类墓碑强制连带删除引用它的路径行（并记墓碑传播）；
 * - 本地删除走 sync_tombstones 表（推送时幂等上传墓碑）。
 * 本地标志 files.local 与 file_path 是设备本地状态，永不进清单。 */
import {
  decideApply,
  envelope,
  jsonEq,
  manifestPath,
  manifestText,
  merge3,
  parseManifestPath,
  remoteProgressWins,
  sha256Hex,
  type ApplyOutcome,
  type CategoryData,
  type Collection,
  type FileData,
  type LocalDevice,
  type LocalManifest,
  type ManifestEnvelope,
  type PackageData,
  type PackagePathData,
  type ProgressData,
  type SegmentConfigData,
} from "@zzlibrary/core";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "./config";
import { isoFromSqlite, newUuid, nowSqlite } from "./db";
import { recomputePackageStatus, syncCounts } from "./repo";
import { pstmt } from "./db";

interface FileRowFull {
  id: number;
  package_id: number;
  uuid: string;
  name: string;
  format: string;
  file_path: string;
  file_size: number;
  page_count: number | null;
  sort_order: number;
  sha256: string | null;
  local: number;
  updated_at: string;
}

/** 记墓碑（含内容块引用=删除记账，随墓碑同步传播——云端墓碑是权威账本，
 * 任何设备（含新机恢复后）都能据此 GC，账不会因换设备/库损坏而丢失）。 */
export function recordTombstone(
  db: DatabaseSync,
  kind: Collection,
  uuid: string,
  blobRefs?: Array<{ sha256: string; size: number }>,
): void {
  const path = manifestPath(kind, uuid);
  db.prepare("INSERT OR REPLACE INTO sync_tombstones (path, updated_at, blob_refs) VALUES (?, ?, ?)").run(
    path,
    nowSqlite(),
    blobRefs !== undefined && blobRefs.length > 0 ? JSON.stringify(blobRefs) : null,
  );
}

/** 远端墓碑里携带的内容块引用（容错读取，供本地墓碑记忆保真传播）。 */
function tombstoneRefs(env: ManifestEnvelope): Array<{ sha256: string; size: number }> | undefined {
  const refs = (env.data as { blobRefs?: unknown } | null)?.blobRefs;
  if (!Array.isArray(refs)) return undefined;
  const out: Array<{ sha256: string; size: number }> = [];
  for (const r of refs) {
    const sha = (r as { sha256?: unknown })?.sha256;
    if (typeof sha === "string" && sha !== "") {
      out.push({ sha256: sha, size: Number((r as { size?: unknown })?.size) || 0 });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** 删除包时的连带墓碑（包/路径/文件/进度）；文件墓碑带内容块引用、包墓碑带封面引用。 */
export function recordPackageTombstones(db: DatabaseSync, pkg: {
  row: { id: number; uuid: string; cover_sha256?: string | null };
  files: Array<{ uuid: string; sha256?: string | null; file_size?: number }>;
  paths: Array<{ uuid: string }>;
}): void {
  recordTombstone(db, "packages", pkg.row.uuid, [
    { sha256: pkg.row.cover_sha256 ?? "", size: 0 },
  ].filter((r) => r.sha256 !== ""));
  for (const p of pkg.paths) recordTombstone(db, "package-paths", p.uuid);
  for (const f of pkg.files) {
    recordTombstone(
      db,
      "files",
      f.uuid,
      typeof f.sha256 === "string" && f.sha256 !== ""
        ? [{ sha256: f.sha256, size: f.file_size ?? 0 }]
        : undefined,
    );
    recordTombstone(db, "progress", f.uuid);
  }
}

export class SqliteSyncDevice implements LocalDevice {
  readonly deviceId: string;
  private dirtyPackages = new Set<number>();
  private inTransaction = false;

  constructor(
    private db: DatabaseSync,
    private settings: Settings,
  ) {
    const row = pstmt(this.db, "SELECT value FROM sync_state WHERE key = 'device_id'").get() as
      | { value: string }
      | undefined;
    if (row !== undefined) {
      this.deviceId = row.value;
    } else {
      this.deviceId = newUuid();
      this.db
        .prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('device_id', ?)")
        .run(this.deviceId);
    }
  }

  // ---------- 工具 ----------

  private pkgUuidToId = new Map<string, number>();
  private pkgIdToUuid = new Map<number, string>();
  private catUuidToId = new Map<string, number>();

  private loadUuidMaps(): void {
    this.pkgUuidToId.clear();
    this.catUuidToId.clear();
    this.pkgIdToUuid.clear();
    for (const r of pstmt(this.db, "SELECT id, uuid FROM packages").all() as Array<{ id: number; uuid: string }>) {
      this.pkgUuidToId.set(r.uuid, r.id);
      this.pkgIdToUuid.set(r.id, r.uuid);
    }
    for (const r of pstmt(this.db, "SELECT id, uuid FROM categories").all() as Array<{ id: number; uuid: string }>) {
      this.catUuidToId.set(r.uuid, r.id);
    }
  }

  private iso(text: string | null | undefined): string | null {
    return text === null || text === undefined ? null : isoFromSqlite(text);
  }

  private fromIso(text: string): string {
    return text.replace("T", " ");
  }

  /** 三方合并辅助：返回合并后的 data 与「是否相对远端有变化」。 */
  private merged(env: ManifestEnvelope, localRowVersion: string, localData: Record<string, unknown>): {
    data: Record<string, unknown>;
    changed: boolean;
  } {
    const path = manifestPath(env.kind, env.uuid);
    const base = pstmt(this.db, "SELECT env FROM sync_baselines WHERE path = ?").get(path) as
      | { env: string }
      | undefined;
    const remote = env.data as Record<string, unknown>;
    if (base === undefined) return { data: remote, changed: false };
    let baseEnv: ManifestEnvelope;
    try {
      baseEnv = JSON.parse(base.env) as ManifestEnvelope;
    } catch {
      return { data: remote, changed: false };
    }
    if (baseEnv.deleted) return { data: remote, changed: false };
    const mergedData = merge3(
      baseEnv.data as Record<string, unknown>,
      localData,
      remote,
      env.updatedAt >= localRowVersion ? "remote" : "local",
    );
    return { data: mergedData, changed: !jsonEq(mergedData, remote) };
  }

  private markDirty(packageId: number | null): void {
    if (packageId !== null) this.dirtyPackages.add(packageId);
  }

  // ---------- buildManifests ----------

  async buildManifests(): Promise<Map<string, LocalManifest>> {
    const out = new Map<string, LocalManifest>();
    const put = async (env: ManifestEnvelope, blobs: string[]) => {
      const text = manifestText(env);
      out.set(manifestPath(env.kind, env.uuid), {
        env, text, sha: await sha256Hex(text), blobSha256s: blobs,
      });
    };

    const catRows = this.db
      .prepare("SELECT * FROM categories ORDER BY id")
      .all() as Array<{
      id: number; uuid: string; level: number; parent_id: number | null; name: string;
      sort_order: number; created_at: string; updated_at: string;
    }>;
    const catIdToUuid = new Map(catRows.map((r) => [r.id, r.uuid]));
    for (const r of catRows) {
      await put(
        envelope("categories", r.uuid, this.iso(r.updated_at) ?? "", {
          level: r.level,
          parentUuid: r.parent_id === null ? null : (catIdToUuid.get(r.parent_id) ?? null),
          name: r.name,
          sortOrder: r.sort_order,
          createdAt: this.iso(r.created_at) ?? "",
        } satisfies CategoryData),
        [],
      );
    }

    const pkgRows = this.db
      .prepare("SELECT id, uuid, title, authors, publish_date, publisher, tags, notes, cover_sha256, palette, created_at, updated_at FROM packages ORDER BY id")
      .all() as Array<{
      id: number; uuid: string; title: string; authors: string; publish_date: string | null;
      publisher: string | null; tags: string; notes: string | null; cover_sha256: string | null;
      palette: string | null; created_at: string; updated_at: string;
    }>;
    for (const r of pkgRows) {
      this.pkgUuidToId.set(r.uuid, r.id);
      this.pkgIdToUuid.set(r.id, r.uuid);
      let palette: PackageData["palette"] = null;
      if (r.palette) {
        try {
          palette = JSON.parse(r.palette);
        } catch {
          palette = null;
        }
      }
      await put(
        envelope("packages", r.uuid, this.iso(r.updated_at) ?? "", {
          title: r.title,
          authors: parseList(r.authors),
          publishDate: r.publish_date,
          publisher: r.publisher,
          tags: parseList(r.tags),
          notes: r.notes,
          coverSha256: r.cover_sha256,
          palette,
          createdAt: this.iso(r.created_at) ?? "",
        } satisfies PackageData),
        r.cover_sha256 !== null ? [r.cover_sha256] : [],
      );
    }

    for (const r of this.db
      .prepare("SELECT * FROM package_paths ORDER BY id")
      .all() as Array<{
      uuid: string; package_id: number; l1_id: number; l2_id: number | null; l3_id: number | null; updated_at: string;
    }>) {
      await put(
        envelope("package-paths", r.uuid, this.iso(r.updated_at) ?? "", {
          packageUuid: this.pkgIdToUuid.get(r.package_id) ?? "",
          l1Uuid: catIdToUuid.get(r.l1_id) ?? "",
          l2Uuid: r.l2_id === null ? null : (catIdToUuid.get(r.l2_id) ?? null),
          l3Uuid: r.l3_id === null ? null : (catIdToUuid.get(r.l3_id) ?? null),
        } satisfies PackagePathData),
        [],
      );
    }

    for (const r of this.db
      .prepare("SELECT id, package_id, uuid, name, format, file_size, page_count, sort_order, sha256, updated_at FROM files ORDER BY package_id, sort_order, id")
      .all() as Array<Omit<FileRowFull, "file_path" | "local">>) {
      if (r.sha256 === null) continue; // 哈希未回填：暂不上云（回填后自动并入）
      await put(
        envelope("files", r.uuid, this.iso(r.updated_at) ?? "", {
          packageUuid: this.pkgIdToUuid.get(r.package_id) ?? "",
          name: r.name,
          format: r.format,
          sha256: r.sha256,
          size: r.file_size,
          pageCount: r.page_count,
          sortOrder: r.sort_order,
        } satisfies FileData),
        [r.sha256],
      );
    }

    for (const r of this.db
      .prepare(
        "SELECT p.locator, p.percent, p.updated_at, f.uuid AS file_uuid FROM reading_progress p JOIN files f ON f.id = p.file_id ORDER BY p.file_id",
      )
      .all() as Array<{ locator: string; percent: number; updated_at: string; file_uuid: string }>) {
      let locator: Record<string, unknown> = {};
      try {
        locator = JSON.parse(r.locator) as Record<string, unknown>;
      } catch {
        locator = {};
      }
      await put(
        envelope("progress", r.file_uuid, this.iso(r.updated_at) ?? "", {
          locator,
          percent: Number(r.percent),
        } satisfies ProgressData),
        [],
      );
    }

    for (const r of this.db
      .prepare("SELECT * FROM segment_configs ORDER BY id")
      .all() as Array<{
      id: number; scope: "global" | "l2" | "l3"; l2_id: number | null; l3_id: number | null;
      mode: string; params: string; updated_at: string;
    }>) {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(r.params) as Record<string, unknown>;
      } catch {
        params = {};
      }
      const scopeUuid = r.scope === "l2" && r.l2_id !== null
        ? (catIdToUuid.get(r.l2_id) ?? null)
        : r.scope === "l3" && r.l3_id !== null
          ? (catIdToUuid.get(r.l3_id) ?? null)
          : null;
      await put(
        envelope("segment-configs", segmentKey(r.scope, scopeUuid), this.iso(r.updated_at) ?? "", {
          scope: r.scope,
          scopeUuid,
          mode: r.mode,
          params,
        } satisfies SegmentConfigData),
        [],
      );
    }

    // 墓碑记忆（含本地硬删除的实体）。
    // 关键防御：本地有活实体的路径跳过——否则"删除→复活"场景（远端复活清单已应用/
    // 数据被恢复）的活清单会被残留墓碑覆盖，复活永远推不上云、甚至被再推回墓碑。
    for (const r of this.db
      .prepare("SELECT path, updated_at, blob_refs FROM sync_tombstones")
      .all() as Array<{ path: string; updated_at: string; blob_refs: string | null }>) {
      if (out.has(r.path)) continue; // 本地有活实体 → 墓碑作废
      const parsed = parseManifestPath(r.path);
      if (parsed === null) continue;
      let refs: unknown = undefined;
      if (r.blob_refs !== null) {
        try { refs = JSON.parse(r.blob_refs); } catch { refs = undefined; }
      }
      // 墓碑携带内容块引用（删除记账随墓碑上云——云端即权威 GC 账本）
      const env = envelope(parsed.kind, parsed.uuid, this.iso(r.updated_at) ?? nowIsoCompat(), { blobRefs: refs }, true);
      await put(env, []);
    }
    return out;
  }


  async readBlob(hash: string): Promise<Uint8Array | null> {
    const f = this.db
      .prepare("SELECT file_path FROM files WHERE sha256 = ? AND local = 1 LIMIT 1")
      .get(hash) as { file_path: string } | undefined;
    if (f !== undefined) {
      const abs = join(this.settings.dataDir, f.file_path);
      if (existsSync(abs)) return new Uint8Array(readFileSync(abs));
    }
    const cover = this.db
      .prepare("SELECT id FROM packages WHERE cover_sha256 = ? LIMIT 1")
      .get(hash) as { id: number } | undefined;
    if (cover !== undefined) {
      const abs = join(this.settings.artDir, "covers", `${cover.id}.png`);
      if (existsSync(abs)) return new Uint8Array(readFileSync(abs));
    }
    return null;
  }

  // ---------- applyRemote ----------

  async beginApply(): Promise<void> {
    this.loadUuidMaps();
    this.dirtyPackages.clear();
    this.db.exec("BEGIN");
    this.inTransaction = true;
  }

  async endApply(commit: boolean): Promise<void> {
    if (!this.inTransaction) return;
    for (const pid of this.dirtyPackages) {
      syncCounts(this.db, pid);
      recomputePackageStatus(this.db, pid);
    }
    this.db.exec(commit ? "COMMIT" : "ROLLBACK");
    this.inTransaction = false;
    this.dirtyPackages.clear();
  }

  async applyRemote(env: ManifestEnvelope): Promise<ApplyOutcome> {
    // 活清单到达 = 该实体在云端活着：清掉本地残留墓碑记录（删除后复活的场景，
    // 否则墓碑表与活实体并存，语义脏）
    if (!env.deleted) {
      this.db
        .prepare("DELETE FROM sync_tombstones WHERE path = ?")
        .run(manifestPath(env.kind, env.uuid));
    }
    switch (env.kind) {
      case "categories":
        return this.applyCategory(env);
      case "segment-configs":
        return this.applySegmentConfig(env);
      case "packages":
        return this.applyPackage(env);
      case "package-paths":
        return this.applyPath(env);
      case "files":
        return this.applyFile(env);
      case "progress":
        return this.applyProgress(env);
    }
  }

  private applyCategory(env: ManifestEnvelope): ApplyOutcome {
    const row = pstmt(this.db, "SELECT * FROM categories WHERE uuid = ?").get(env.uuid) as
      | { id: number; level: number; parent_id: number | null; name: string; sort_order: number; updated_at: string }
      | undefined;
    if (env.deleted) {
      if (row === undefined) return "noop";
      // 有子分类时不删（RESTRICT 语义）——子分类的墓碑稍后到达，下次同步重试本条
      const child = pstmt(this.db, "SELECT id FROM categories WHERE parent_id = ? LIMIT 1").get(row.id);
      if (child) throw new Error("分类仍有子分类，墓碑延后应用");
      // 连带：引用此分类的路径行强制删除（回退未分类语义由对端补路径行表达）
      const refs = this.db
        .prepare("SELECT * FROM package_paths WHERE l1_id = ? OR l2_id = ? OR l3_id = ?")
        .all(row.id, row.id, row.id) as Array<{ uuid: string; package_id: number }>;
      for (const ref of refs) {
        this.markDirty(ref.package_id);
        recordTombstone(this.db, "package-paths", ref.uuid);
      }
      pstmt(this.db, "DELETE FROM package_paths WHERE l1_id = ? OR l2_id = ? OR l3_id = ?").run(row.id, row.id, row.id);
      pstmt(this.db, "DELETE FROM categories WHERE id = ?").run(row.id);
      this.catUuidToId.delete(env.uuid);
      recordTombstone(this.db, "categories", env.uuid, tombstoneRefs(env));
      return "tombstone-applied";
    }
    const data = env.data as CategoryData;
    const parentId = data.parentUuid === null ? null : (this.catUuidToId.get(data.parentUuid) ?? null);
    if (data.parentUuid !== null && parentId === null) {
      throw new Error("父分类尚未落库（层级顺序异常）");
    }
    if (row === undefined) {
      const ins = this.db
        .prepare(
          "INSERT INTO categories (level, parent_id, name, sort_order, created_at, updated_at, uuid) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(data.level, parentId, data.name, data.sortOrder, this.fromIso(data.createdAt), this.fromIso(env.updatedAt), env.uuid);
      this.catUuidToId.set(env.uuid, Number(ins.lastInsertRowid));
      return "applied";
    }
    const outcome = decideApply({ updatedAt: isoFromSqlite(row.updated_at), uuid: env.uuid }, env);
    if (outcome !== "applied") return outcome;
    const parentUuid =
      row.parent_id === null
        ? null
        : ((pstmt(this.db, "SELECT uuid FROM categories WHERE id = ?").get(row.parent_id) as { uuid: string } | undefined)?.uuid ?? null);
    const mergedData = this.merged(env, isoFromSqlite(row.updated_at), {
      level: row.level,
      parentUuid,
      name: row.name,
      sortOrder: row.sort_order,
      createdAt: this.iso(
        (pstmt(this.db, "SELECT created_at FROM categories WHERE id = ?").get(row.id) as { created_at: string }).created_at,
      ) ?? "",
    }).data as unknown as CategoryData;
    this.db
      .prepare("UPDATE categories SET name = ?, sort_order = ?, parent_id = ?, updated_at = ? WHERE id = ?")
      .run(mergedData.name, mergedData.sortOrder, parentId, this.fromIso(env.updatedAt), row.id);
    return "applied";
  }

  private applySegmentConfig(env: ManifestEnvelope): ApplyOutcome {
    const data = env.data as SegmentConfigData;
    const l2Id = data.scopeUuid !== null && data.scope === "l2" ? (this.catUuidToId.get(data.scopeUuid) ?? null) : null;
    const l3Id = data.scopeUuid !== null && data.scope === "l3" ? (this.catUuidToId.get(data.scopeUuid) ?? null) : null;
    if (data.scope !== "global" && l2Id === null && l3Id === null) return "noop"; // 作用域分类不存在
    const row = this.db
      .prepare("SELECT * FROM segment_configs WHERE scope = ? AND l2_id IS ? AND l3_id IS ?")
      .get(data.scope, l2Id, l3Id) as { id: number; mode: string; params: string; updated_at: string } | undefined;
    if (env.deleted) {
      if (row === undefined) return "noop";
      pstmt(this.db, "DELETE FROM segment_configs WHERE id = ?").run(row.id);
      return "tombstone-applied";
    }
    if (row === undefined) {
      this.db
        .prepare("INSERT INTO segment_configs (scope, l2_id, l3_id, mode, params, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(data.scope, l2Id, l3Id, data.mode, JSON.stringify(data.params), this.fromIso(env.updatedAt));
      return "applied";
    }
    const outcome = decideApply({ updatedAt: isoFromSqlite(row.updated_at), uuid: env.uuid }, env);
    if (outcome !== "applied") return outcome;
    this.db
      .prepare("UPDATE segment_configs SET mode = ?, params = ?, updated_at = ? WHERE id = ?")
      .run(data.mode, JSON.stringify(data.params), this.fromIso(env.updatedAt), row.id);
    return "applied";
  }

  private applyPackage(env: ManifestEnvelope): ApplyOutcome {
    const row = this.db
      .prepare("SELECT id, title, authors, publish_date, publisher, tags, notes, cover_sha256, palette, created_at, updated_at FROM packages WHERE uuid = ?")
      .get(env.uuid) as
      | {
        id: number; title: string; authors: string; publish_date: string | null; publisher: string | null;
        tags: string; notes: string | null; cover_sha256: string | null; palette: string | null;
        created_at: string; updated_at: string;
      }
      | undefined;
    if (env.deleted) {
      if (row === undefined) return "noop";
      const outcome = decideApply({ updatedAt: isoFromSqlite(row.updated_at), uuid: env.uuid }, env);
      if (outcome !== "tombstone-applied") return "local-newer"; // 本地删除后又编辑过 → 复活
      // 本地清库（行 + 文件 + 派生资产；物理文件留给磁盘清理）
      pstmt(this.db, "DELETE FROM packages WHERE id = ?").run(row.id);
      this.pkgUuidToId.delete(env.uuid);
      recordTombstone(this.db, "packages", env.uuid, tombstoneRefs(env));
      return "tombstone-applied";
    }
    const data = env.data as PackageData;
    if (row === undefined) {
      const ins = this.db
        .prepare(
          "INSERT INTO packages (title, authors, publish_date, publisher, tags, notes, status, file_count, total_size, created_at, updated_at, uuid, cover_sha256, palette) VALUES (?, ?, ?, ?, ?, ?, '未读', 0, 0, ?, ?, ?, ?, ?)",
        )
        .run(
          data.title, JSON.stringify(data.authors), data.publishDate, data.publisher,
          JSON.stringify(data.tags), data.notes, this.fromIso(data.createdAt), this.fromIso(env.updatedAt),
          env.uuid, data.coverSha256, data.palette === null ? null : JSON.stringify(data.palette),
        );
      this.pkgUuidToId.set(env.uuid, Number(ins.lastInsertRowid));
      return "applied";
    }
    const outcome = decideApply({ updatedAt: isoFromSqlite(row.updated_at), uuid: env.uuid }, env);
    if (outcome !== "applied") return outcome;
    const localData: Record<string, unknown> = {
      title: row.title,
      authors: parseList(row.authors),
      publishDate: row.publish_date,
      publisher: row.publisher,
      tags: parseList(row.tags),
      notes: row.notes,
      coverSha256: row.cover_sha256,
      palette: row.palette === null ? null : JSON.parse(row.palette || "null"),
      createdAt: isoFromSqlite(row.created_at),
    };
    const m = this.merged(env, isoFromSqlite(row.updated_at), localData);
    const d = m.data as unknown as PackageData;
    this.db
      .prepare(
        "UPDATE packages SET title = ?, authors = ?, publish_date = ?, publisher = ?, tags = ?, notes = ?, cover_sha256 = ?, palette = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        d.title, JSON.stringify(d.authors), d.publishDate, d.publisher, JSON.stringify(d.tags),
        d.notes, d.coverSha256, d.palette === null ? null : JSON.stringify(d.palette),
        this.fromIso(env.updatedAt), row.id,
      );
    if (m.changed) {
      // 标题等变化 → 派生缓存失效：删书脊；占位封面也删（真封面文件缺失时端点会按 cover_sha256 取回）
      const spine = join(this.settings.artDir, "spines", `${row.id}.png`);
      if (existsSync(spine)) unlinkSync(spine);
      if (d.coverSha256 === null) {
        const cover = join(this.settings.artDir, "covers", `${row.id}.png`);
        if (existsSync(cover)) unlinkSync(cover);
      }
    }
    return "applied";
  }

  private applyPath(env: ManifestEnvelope): ApplyOutcome {
    const data = env.data as PackagePathData;
    const pkgId = this.pkgUuidToId.get(data.packageUuid);
    if (pkgId === undefined) return "noop"; // 包不存在（墓碑先行）
    const row = pstmt(this.db, "SELECT * FROM package_paths WHERE uuid = ?").get(env.uuid) as
      | { id: number; l1_id: number; l2_id: number | null; l3_id: number | null; updated_at: string }
      | undefined;
    if (env.deleted) {
      if (row === undefined) return "noop";
      pstmt(this.db, "DELETE FROM package_paths WHERE id = ?").run(row.id);
      this.markDirty(pkgId);
      recordTombstone(this.db, "package-paths", env.uuid, tombstoneRefs(env));
      return "tombstone-applied";
    }
    const l1 = this.catUuidToId.get(data.l1Uuid);
    if (l1 === undefined) return "noop"; // 分类未到（下次同步补）
    const l2 = data.l2Uuid === null ? null : (this.catUuidToId.get(data.l2Uuid) ?? null); // 分类已删 → 回退上级
    const l3 = data.l3Uuid === null ? null : (this.catUuidToId.get(data.l3Uuid) ?? null);
    if (row === undefined) {
      this.db
        .prepare("INSERT OR IGNORE INTO package_paths (package_id, l1_id, l2_id, l3_id, updated_at, uuid) VALUES (?, ?, ?, ?, ?, ?)")
        .run(pkgId, l1, l2, l3, this.fromIso(env.updatedAt), env.uuid);
      this.markDirty(pkgId);
      return "applied";
    }
    const outcome = decideApply({ updatedAt: isoFromSqlite(row.updated_at), uuid: env.uuid }, env);
    if (outcome !== "applied") return outcome;
    this.db
      .prepare("UPDATE package_paths SET l1_id = ?, l2_id = ?, l3_id = ?, updated_at = ? WHERE id = ?")
      .run(l1, l2, l3, this.fromIso(env.updatedAt), row.id);
    return "applied";
  }

  private applyFile(env: ManifestEnvelope): ApplyOutcome {
    const data = env.data as FileData;
    const pkgId = this.pkgUuidToId.get(data.packageUuid);
    if (pkgId === undefined) return "noop";
    const row = pstmt(this.db, "SELECT * FROM files WHERE uuid = ?").get(env.uuid) as
      | { id: number; name: string; format: string; file_size: number; page_count: number | null; sort_order: number; sha256: string | null; local: number; updated_at: string }
      | undefined;
    if (env.deleted) {
      if (row === undefined) return "noop";
      pstmt(this.db, "DELETE FROM files WHERE id = ?").run(row.id);
      this.markDirty(pkgId);
      recordTombstone(this.db, "files", env.uuid, tombstoneRefs(env));
      return "tombstone-applied";
    }
    if (row === undefined) {
      // 新机恢复：行落库、字节不在本地（local=0，读取时透明取回）
      const pkg = this.db
        .prepare("SELECT id, title, created_at FROM packages WHERE id = ?")
        .get(pkgId) as { id: number; title: string; created_at: string };
      const dirName = `${String(pkg.created_at).slice(0, 10) || "unknown"}_${pkgId}_${sanitizeDir(pkg.title)}`;
      const relPath = join("files", dirName, `pending_${env.uuid.slice(0, 8)}_${data.name}`);
      const ins = this.db
        .prepare(
          "INSERT INTO files (package_id, name, format, file_path, file_size, page_count, sort_order, sha256, local, updated_at, uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .run(pkgId, data.name, data.format, relPath, data.size, data.pageCount, data.sortOrder, data.sha256, this.fromIso(env.updatedAt), env.uuid);
      // file_path 先占位；取回时按真实 fileId 定名
      pstmt(this.db, "UPDATE files SET file_path = ? WHERE id = ?").run(
        join("files", dirName, `${Number(ins.lastInsertRowid)}_${data.name}`),
        Number(ins.lastInsertRowid),
      );
      this.markDirty(pkgId);
      return "applied";
    }
    const outcome = decideApply({ updatedAt: isoFromSqlite(row.updated_at), uuid: env.uuid }, env);
    if (outcome !== "applied") return outcome;
    const m = this.merged(env, isoFromSqlite(row.updated_at), {
      packageUuid: data.packageUuid,
      name: row.name,
      format: row.format,
      sha256: row.sha256,
      size: row.file_size,
      pageCount: row.page_count,
      sortOrder: row.sort_order,
    });
    const d = m.data as unknown as FileData;
    this.db
      .prepare("UPDATE files SET name = ?, sort_order = ?, page_count = ?, updated_at = ? WHERE id = ?")
      .run(d.name, d.sortOrder, d.pageCount, this.fromIso(env.updatedAt), row.id);
    return "applied";
  }

  private applyProgress(env: ManifestEnvelope): ApplyOutcome {
    const file = pstmt(this.db, "SELECT id, package_id, uuid FROM files WHERE uuid = ?").get(env.uuid) as
      | { id: number; package_id: number; uuid: string }
      | undefined;
    if (file === undefined) return "noop";
    const existing = this.db
      .prepare("SELECT * FROM reading_progress WHERE file_id = ?")
      .get(file.id) as { percent: number; updated_at: string } | undefined;
    if (env.deleted) {
      if (existing === undefined) return "noop";
      // 重置墓碑按 LWW：本地读得更远（updated_at 更新）则保留本地进度
      if (env.updatedAt <= isoFromSqlite(existing.updated_at)) return "local-newer";
      pstmt(this.db, "DELETE FROM reading_progress WHERE file_id = ?").run(file.id);
      this.markDirty(file.package_id);
      recordTombstone(this.db, "progress", env.uuid, tombstoneRefs(env));
      return "tombstone-applied";
    }
    const data = env.data as ProgressData;
    if (existing === undefined) {
      this.db
        .prepare("INSERT INTO reading_progress (file_id, locator, percent, updated_at) VALUES (?, ?, ?, ?)")
        .run(file.id, JSON.stringify(data.locator), data.percent, this.fromIso(env.updatedAt));
      this.markDirty(file.package_id);
      return "applied";
    }
    const remoteWin = remoteProgressWins(
      { percent: existing.percent, updatedAt: isoFromSqlite(existing.updated_at), uuid: env.uuid },
      { percent: data.percent, updatedAt: env.updatedAt, uuid: env.uuid },
    );
    if (!remoteWin) return "local-newer";
    this.db
      .prepare("UPDATE reading_progress SET locator = ?, percent = ?, updated_at = ? WHERE file_id = ?")
      .run(JSON.stringify(data.locator), data.percent, this.fromIso(env.updatedAt), file.id);
    this.markDirty(file.package_id);
    return "applied";
  }

  // ---------- 缓存 ----------

  async getManifestCache(): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    for (const r of pstmt(this.db, "SELECT path, sha256 FROM sync_manifest_cache").all() as Array<{ path: string; sha256: string }>) {
      m.set(r.path, r.sha256);
    }
    return m;
  }
  async setManifestCache(entries: Map<string, string>): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM sync_manifest_cache");
      const ins = pstmt(this.db, "INSERT INTO sync_manifest_cache (path, sha256) VALUES (?, ?)");
      for (const [path, sha] of entries) ins.run(path, sha);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  async getCollectionHashes(): Promise<Partial<Record<Collection, string>>> {
    const row = pstmt(this.db, "SELECT value FROM sync_state WHERE key = 'col_hashes'").get() as
      | { value: string }
      | undefined;
    return row === undefined ? {} : (JSON.parse(row.value) as Partial<Record<Collection, string>>);
  }
  async setCollectionHashes(hashes: Partial<Record<Collection, string>>): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('col_hashes', ?)")
      .run(JSON.stringify(hashes));
  }
  async getBlobCache(): Promise<Set<string>> {
    const s = new Set<string>();
    for (const r of pstmt(this.db, "SELECT sha256 FROM sync_blob_cache").all() as Array<{ sha256: string }>) {
      s.add(r.sha256);
    }
    return s;
  }
  async addBlobCache(hash: string): Promise<void> {
    pstmt(this.db, "INSERT OR IGNORE INTO sync_blob_cache (sha256) VALUES (?)").run(hash);
  }
  async getRevision(): Promise<number> {
    const row = pstmt(this.db, "SELECT value FROM sync_state WHERE key = 'revision'").get() as
      | { value: string }
      | undefined;
    return row === undefined ? 0 : Number(row.value);
  }
  async setRevision(revision: number): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('revision', ?)")
      .run(String(revision));
  }
  noteBaseline(path: string, env: ManifestEnvelope): void {
    this.db
      .prepare("INSERT OR REPLACE INTO sync_baselines (path, env) VALUES (?, ?)")
      .run(path, manifestText(env));
  }
}

function parseList(text: string): string[] {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function sanitizeDir(title: string): string {
  let n = title;
  for (const ch of ["\\", "/", ":", "?", "*", '"', "<", ">", "|"]) n = n.split(ch).join("_");
  n = n.replace(/[\x00-\x1f]/g, "").replace(/^[. ]+|[. ]+$/g, "");
  return n.slice(0, 40) || "file";
}

function segmentKey(scope: "global" | "l2" | "l3", scopeUuid: string | null): string {
  if (scope === "global") return "global";
  return scopeUuid === null ? scope : `${scope}-${scopeUuid}`;
}

function nowIsoCompat(): string {
  return new Date().toISOString();
}
