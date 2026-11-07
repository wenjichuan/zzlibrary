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
  sanitizeName,
} from "@zzlibrary/core";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "./config";
import { isoFromSqlite, newUuid, nowSqlite } from "./db";
import { parseJsonArray, recomputePackageStatus, syncCounts } from "./repo";
import { inTransaction, pstmt } from "./db";
import { sha256Sync } from "./hashing";

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

  // ---------- buildManifests（增量构建） ----------
  // 变更戳 = 信封 updatedAt（iso 归一）。未变化实体复用 sync_manifest_build 里的 sha/text（text 不进内存，
  // 引擎需要时经 readManifestText 取回）——万包规模下每次同步不再全量 stringify+哈希+驻留文本。

  private stampOf(sqliteText: string | null | undefined): string {
    return this.iso(sqliteText ?? "") ?? "";
  }

  async buildManifests(): Promise<Map<string, LocalManifest>> {
    const out = new Map<string, LocalManifest>();

    // 1) 轻量全扫：id↔uuid 映射 + 各集合变更戳（只取 uuid/updated_at，零 JSON/哈希）
    const catLight = pstmt(this.db, "SELECT id, uuid, parent_id, updated_at FROM categories ORDER BY id").all() as Array<{
      id: number; uuid: string; parent_id: number | null; updated_at: string;
    }>;
    const catIdToUuid = new Map(catLight.map((r) => [r.id, r.uuid]));
    const pkgLight = pstmt(this.db, "SELECT id, uuid, updated_at FROM packages ORDER BY id").all() as Array<{
      id: number; uuid: string; updated_at: string;
    }>;
    for (const r of pkgLight) {
      this.pkgUuidToId.set(r.uuid, r.id);
      this.pkgIdToUuid.set(r.id, r.uuid);
    }

    const stamps = new Map<string, string>(); // path → 变更戳（活实体；墓碑见下）
    for (const r of catLight) stamps.set(manifestPath("categories", r.uuid), this.stampOf(r.updated_at));
    for (const r of pkgLight) stamps.set(manifestPath("packages", r.uuid), this.stampOf(r.updated_at));
    for (const r of pstmt(this.db, "SELECT uuid, updated_at FROM package_paths").all() as Array<{ uuid: string; updated_at: string }>) {
      stamps.set(manifestPath("package-paths", r.uuid), this.stampOf(r.updated_at));
    }
    for (const r of pstmt(this.db, "SELECT uuid, updated_at FROM files WHERE sha256 IS NOT NULL").all() as Array<{ uuid: string; updated_at: string }>) {
      stamps.set(manifestPath("files", r.uuid), this.stampOf(r.updated_at));
    }
    for (const r of pstmt(this.db, "SELECT f.uuid AS uuid, p.updated_at AS updated_at FROM reading_progress p JOIN files f ON f.id = p.file_id").all() as Array<{ uuid: string; updated_at: string }>) {
      stamps.set(manifestPath("progress", r.uuid), this.stampOf(r.updated_at));
    }
    const segKeyToId = new Map<string, number>();
    for (const r of pstmt(this.db, "SELECT id, scope, l2_id, l3_id, updated_at FROM segment_configs").all() as Array<{
      id: number; scope: "global" | "l2" | "l3"; l2_id: number | null; l3_id: number | null; updated_at: string;
    }>) {
      const scopeUuid = r.scope === "l2" && r.l2_id !== null
        ? (catIdToUuid.get(r.l2_id) ?? null)
        : r.scope === "l3" && r.l3_id !== null
          ? (catIdToUuid.get(r.l3_id) ?? null)
          : null;
      const key = segmentKey(r.scope, scopeUuid);
      segKeyToId.set(key, r.id);
      stamps.set(manifestPath("segment-configs", key), this.stampOf(r.updated_at));
    }
    // 墓碑记忆。关键防御：本地有活实体的路径跳过——"删除→复活"场景的活清单不被残留墓碑覆盖。
    for (const r of pstmt(this.db, "SELECT path, updated_at FROM sync_tombstones").all() as Array<{ path: string; updated_at: string }>) {
      if (stamps.has(r.path)) continue; // 本地有活实体 → 墓碑作废
      stamps.set(r.path, this.stampOf(r.updated_at));
    }

    // 2) 增量缓存比对：未变化复用 sha；变化/缺失标记重建；缓存里已消失的实体标记清除
    const cache = new Map(
      (pstmt(this.db, "SELECT path, sha, stamp FROM sync_manifest_build").all() as Array<{
        path: string; sha: string; stamp: string;
      }>).map((r) => [r.path, r]),
    );
    const dirty = new Set<string>();
    for (const [path, stamp] of stamps) {
      const c = cache.get(path);
      if (c !== undefined && c.stamp === stamp) {
        out.set(path, { env: null, text: null, sha: c.sha, blobSha256s: [] });
      } else {
        dirty.add(path);
      }
    }
    const stale = [...cache.keys()].filter((p) => !stamps.has(p));

    // 3) 重建变化实体（同步构建 + 分批落缓存；每 2000 条让出事件循环）
    const pending: Array<[string, string, string, string]> = []; // path, sha, text, stamp
    const flush = () => {
      if (pending.length === 0) return;
      inTransaction(this.db, () => {
        const ins = pstmt(this.db, "INSERT OR REPLACE INTO sync_manifest_build (path, sha, text, stamp) VALUES (?, ?, ?, ?)");
        for (const row of pending) ins.run(...row);
      });
      pending.length = 0;
    };
    const encoder = new TextEncoder();
    const rebuild = (env: ManifestEnvelope, blobs: string[]) => {
      const path = manifestPath(env.kind, env.uuid);
      const text = manifestText(env);
      out.set(path, { env, text, sha: sha256Sync(encoder.encode(text)), blobSha256s: blobs });
      pending.push([path, out.get(path)!.sha, text, env.updatedAt]);
    };

    const dirtyByKind = new Map<string, string[]>();
    for (const path of dirty) {
      const parsed = parseManifestPath(path);
      if (parsed === null) continue;
      const arr = dirtyByKind.get(parsed.kind) ?? [];
      arr.push(parsed.uuid);
      dirtyByKind.set(parsed.kind, arr);
    }
    const chunks = <T,>(xs: T[], n = 500): T[][] => {
      const outC: T[][] = [];
      for (let i = 0; i < xs.length; i += n) outC.push(xs.slice(i, i + n));
      return outC;
    };
    let processed = 0;
    const maybeYield = async () => {
      processed += 1;
      if (processed % 2000 === 0) {
        flush();
        await new Promise<void>((r) => setImmediate(r));
      }
    };

    const dirtyCats = new Set(dirtyByKind.get("categories") ?? []);
    if (dirtyCats.size > 0) {
      for (const chunk of chunks([...dirtyCats])) {
        const ph = chunk.map(() => "?").join(",");
        const rows = pstmt(this.db, `SELECT * FROM categories WHERE uuid IN (${ph}) ORDER BY id`).all(...chunk) as Array<{
          id: number; uuid: string; level: number; parent_id: number | null; name: string;
          sort_order: number; created_at: string; updated_at: string;
        }>;
        for (const r of rows) {
          rebuild(
            envelope("categories", r.uuid, this.stampOf(r.updated_at), {
              level: r.level,
              parentUuid: r.parent_id === null ? null : (catIdToUuid.get(r.parent_id) ?? null),
              name: r.name,
              sortOrder: r.sort_order,
              createdAt: this.iso(r.created_at) ?? "",
            } satisfies CategoryData),
            [],
          );
          await maybeYield();
        }
      }
      flush();
    }

    const dirtyPkgs = new Set(dirtyByKind.get("packages") ?? []);
    if (dirtyPkgs.size > 0) {
      for (const chunk of chunks([...dirtyPkgs])) {
        const ph = chunk.map(() => "?").join(",");
        const rows = pstmt(this.db, "SELECT id, uuid, title, authors, publish_date, publisher, tags, notes, cover_sha256, palette, created_at, updated_at FROM packages WHERE uuid IN (" + ph + ") ORDER BY id").all(...chunk) as Array<{
          id: number; uuid: string; title: string; authors: string; publish_date: string | null;
          publisher: string | null; tags: string; notes: string | null; cover_sha256: string | null;
          palette: string | null; created_at: string; updated_at: string;
        }>;
        for (const r of rows) {
          let palette: PackageData["palette"] = null;
          if (r.palette) {
            try { palette = JSON.parse(r.palette); } catch { palette = null; }
          }
          rebuild(
            envelope("packages", r.uuid, this.stampOf(r.updated_at), {
              title: r.title,
              authors: parseJsonArray(r.authors),
              publishDate: r.publish_date,
              publisher: r.publisher,
              tags: parseJsonArray(r.tags),
              notes: r.notes,
              coverSha256: r.cover_sha256,
              palette,
              createdAt: this.iso(r.created_at) ?? "",
            } satisfies PackageData),
            r.cover_sha256 !== null ? [r.cover_sha256] : [],
          );
          await maybeYield();
        }
      }
      flush();
    }

    const dirtyPaths = new Set(dirtyByKind.get("package-paths") ?? []);
    if (dirtyPaths.size > 0) {
      for (const chunk of chunks([...dirtyPaths])) {
        const ph = chunk.map(() => "?").join(",");
        const rows = pstmt(this.db, `SELECT * FROM package_paths WHERE uuid IN (${ph}) ORDER BY id`).all(...chunk) as Array<{
          uuid: string; package_id: number; l1_id: number; l2_id: number | null; l3_id: number | null; updated_at: string;
        }>;
        for (const r of rows) {
          rebuild(
            envelope("package-paths", r.uuid, this.stampOf(r.updated_at), {
              packageUuid: this.pkgIdToUuid.get(r.package_id) ?? "",
              l1Uuid: catIdToUuid.get(r.l1_id) ?? "",
              l2Uuid: r.l2_id === null ? null : (catIdToUuid.get(r.l2_id) ?? null),
              l3Uuid: r.l3_id === null ? null : (catIdToUuid.get(r.l3_id) ?? null),
            } satisfies PackagePathData),
            [],
          );
          await maybeYield();
        }
      }
      flush();
    }

    const dirtyFiles = new Set(dirtyByKind.get("files") ?? []);
    if (dirtyFiles.size > 0) {
      for (const chunk of chunks([...dirtyFiles])) {
        const ph = chunk.map(() => "?").join(",");
        const rows = pstmt(this.db, "SELECT id, package_id, uuid, name, format, file_size, page_count, sort_order, sha256, updated_at FROM files WHERE sha256 IS NOT NULL AND uuid IN (" + ph + ") ORDER BY package_id, sort_order, id").all(...chunk) as Array<Omit<FileRowFull, "file_path" | "local">>;
        for (const r of rows) {
          const sha = r.sha256 as string; // WHERE sha256 IS NOT NULL 已过滤
          rebuild(
            envelope("files", r.uuid, this.stampOf(r.updated_at), {
              packageUuid: this.pkgIdToUuid.get(r.package_id) ?? "",
              name: r.name,
              format: r.format,
              sha256: sha,
              size: r.file_size,
              pageCount: r.page_count,
              sortOrder: r.sort_order,
            } satisfies FileData),
            [sha],
          );
          await maybeYield();
        }
      }
      flush();
    }

    const dirtyProgress = new Set(dirtyByKind.get("progress") ?? []);
    if (dirtyProgress.size > 0) {
      for (const chunk of chunks([...dirtyProgress])) {
        const ph = chunk.map(() => "?").join(",");
        const rows = pstmt(this.db, "SELECT p.locator, p.percent, p.updated_at, f.uuid AS file_uuid FROM reading_progress p JOIN files f ON f.id = p.file_id WHERE f.uuid IN (" + ph + ") ORDER BY p.file_id").all(...chunk) as Array<{ locator: string; percent: number; updated_at: string; file_uuid: string }>;
        for (const r of rows) {
          let locator: Record<string, unknown> = {};
          try { locator = JSON.parse(r.locator) as Record<string, unknown>; } catch { locator = {}; }
          rebuild(
            envelope("progress", r.file_uuid, this.stampOf(r.updated_at), {
              locator,
              percent: Number(r.percent),
            } satisfies ProgressData),
            [],
          );
          await maybeYield();
        }
      }
      flush();
    }

    const dirtySegs = new Set(dirtyByKind.get("segment-configs") ?? []);
    if (dirtySegs.size > 0) {
      const ids = [...dirtySegs].map((k) => segKeyToId.get(k)).filter((v): v is number => v !== undefined);
      for (const chunk of chunks(ids)) {
        const ph = chunk.map(() => "?").join(",");
        const rows = pstmt(this.db, `SELECT * FROM segment_configs WHERE id IN (${ph}) ORDER BY id`).all(...chunk) as Array<{
          id: number; scope: "global" | "l2" | "l3"; l2_id: number | null; l3_id: number | null;
          mode: string; params: string; updated_at: string;
        }>;
        for (const r of rows) {
          let params: Record<string, unknown> = {};
          try { params = JSON.parse(r.params) as Record<string, unknown>; } catch { params = {}; }
          const scopeUuid = r.scope === "l2" && r.l2_id !== null
            ? (catIdToUuid.get(r.l2_id) ?? null)
            : r.scope === "l3" && r.l3_id !== null
              ? (catIdToUuid.get(r.l3_id) ?? null)
              : null;
          rebuild(
            envelope("segment-configs", segmentKey(r.scope, scopeUuid), this.stampOf(r.updated_at), {
              scope: r.scope,
              scopeUuid,
              mode: r.mode,
              params,
            } satisfies SegmentConfigData),
            [],
          );
          await maybeYield();
        }
      }
      flush();
    }

    // 墓碑重建（仅变化的；未变化的已在缓存比对步复用）。携带内容块引用——云端即权威 GC 账本。
    for (const r of pstmt(this.db, "SELECT path, updated_at, blob_refs FROM sync_tombstones").all() as Array<{ path: string; updated_at: string; blob_refs: string | null }>) {
      if (out.has(r.path)) continue; // 本地有活实体 → 墓碑作废
      if (!dirty.has(r.path)) continue; // 未变化 → 已复用缓存
      const parsed = parseManifestPath(r.path);
      if (parsed === null) continue;
      let refs: unknown = undefined;
      if (r.blob_refs !== null) {
        try { refs = JSON.parse(r.blob_refs); } catch { refs = undefined; }
      }
      const env = envelope(parsed.kind, parsed.uuid, this.stampOf(r.updated_at) || nowIsoCompat(), { blobRefs: refs }, true);
      rebuild(env, []);
      await maybeYield();
    }
    flush();

    // 4) 清掉缓存里已消失实体的行
    if (stale.length > 0) {
      inTransaction(this.db, () => {
        const del = pstmt(this.db, "DELETE FROM sync_manifest_build WHERE path = ?");
        for (const p of stale) del.run(p);
      });
    }
    return out;
  }

  async readManifestText(path: string): Promise<string | null> {
    const row = pstmt(this.db, "SELECT text FROM sync_manifest_build WHERE path = ?").get(path) as
      | { text: string }
      | undefined;
    return row?.text ?? null;
  }

  async readTombstone(path: string): Promise<{ updatedAt: string; data: Record<string, unknown> } | null> {
    const row = pstmt(this.db, "SELECT updated_at, blob_refs FROM sync_tombstones WHERE path = ?").get(path) as
      | { updated_at: string; blob_refs: string | null }
      | undefined;
    if (row === undefined) return null;
    let refs: unknown = undefined;
    if (row.blob_refs !== null) {
      try {
        refs = JSON.parse(row.blob_refs);
      } catch {
        refs = undefined;
      }
    }
    return { updatedAt: this.stampOf(row.updated_at), data: { blobRefs: refs } };
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
      authors: parseJsonArray(row.authors),
      publishDate: row.publish_date,
      publisher: row.publisher,
      tags: parseJsonArray(row.tags),
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
      const dirName = `${String(pkg.created_at).slice(0, 10) || "unknown"}_${pkgId}_${sanitizeName(pkg.title, 40, "file")}`;
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
    // 增量写：只动变化的行（旧「全删+全插」在万包规模=每次同步重写数十万行 WAL）
    inTransaction(this.db, () => {
      const existing = new Map(
        (pstmt(this.db, "SELECT path, sha256 FROM sync_manifest_cache").all() as Array<{ path: string; sha256: string }>).map(
          (r) => [r.path, r.sha256],
        ),
      );
      const ins = pstmt(this.db, "INSERT OR REPLACE INTO sync_manifest_cache (path, sha256) VALUES (?, ?)");
      const del = pstmt(this.db, "DELETE FROM sync_manifest_cache WHERE path = ?");
      for (const [path, sha] of entries) {
        if (existing.get(path) === sha) continue;
        ins.run(path, sha);
      }
      for (const path of existing.keys()) {
        if (!entries.has(path)) del.run(path);
      }
    });
  }
  async getBucketShas(): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    for (const r of pstmt(this.db, "SELECT path, sha256 FROM sync_bucket_cache").all() as Array<{ path: string; sha256: string }>) {
      m.set(r.path, r.sha256);
    }
    return m;
  }
  async setBucketShas(entries: Map<string, string>): Promise<void> {
    // 增量写（同 setManifestCache；桶数封顶 6×1024，但保持同一模式）
    inTransaction(this.db, () => {
      const existing = new Map(
        (pstmt(this.db, "SELECT path, sha256 FROM sync_bucket_cache").all() as Array<{ path: string; sha256: string }>).map(
          (r) => [r.path, r.sha256],
        ),
      );
      const ins = pstmt(this.db, "INSERT OR REPLACE INTO sync_bucket_cache (path, sha256) VALUES (?, ?)");
      const del = pstmt(this.db, "DELETE FROM sync_bucket_cache WHERE path = ?");
      for (const [path, sha] of entries) {
        if (existing.get(path) === sha) continue;
        ins.run(path, sha);
      }
      for (const path of existing.keys()) {
        if (!entries.has(path)) del.run(path);
      }
    });
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
    this.blobCacheBuf.push(hash);
    if (this.blobCacheBuf.length >= 500) this.flushPendingWrites();
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
  /** 基线/块缓存写缓冲：万包首推不再每条一个 fsync 小事务；满 500 或同步结束时批量落盘。 */
  private baselineBuf: Array<[string, string]> = [];
  private blobCacheBuf: string[] = [];
  noteBaseline(path: string, env: ManifestEnvelope): void {
    this.baselineBuf.push([path, manifestText(env)]);
    if (this.baselineBuf.length >= 500) this.flushPendingWrites();
  }
  /** 冲刷缓冲的基线/块缓存写（单事务）。引擎在同步收尾调用；未冲掉的部分是缓存，进程崩溃可自愈（下次 pull 重建）。 */
  flushPendingWrites(): void {
    inTransaction(this.db, () => {
      const insB = pstmt(this.db, "INSERT OR REPLACE INTO sync_baselines (path, env) VALUES (?, ?)");
      for (const [p, e] of this.baselineBuf) insB.run(p, e);
      const insC = pstmt(this.db, "INSERT OR IGNORE INTO sync_blob_cache (sha256) VALUES (?)");
      for (const h of this.blobCacheBuf) insC.run(h);
    });
    this.baselineBuf = [];
    this.blobCacheBuf = [];
  }
}

function segmentKey(scope: "global" | "l2" | "l3", scopeUuid: string | null): string {
  if (scope === "global") return "global";
  return scopeUuid === null ? scope : `${scope}-${scopeUuid}`;
}

function nowIsoCompat(): string {
  return new Date().toISOString();
}
