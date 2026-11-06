/** 同步服务：云配置（data/cloud.json，凭据只存本地）、连接探测、
 * 立即同步（哈希回填 → pull → push，单飞）、释放本地空间、透明取回、
 * 写后自动同步（防抖排队）。 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createS3Store,
  createWebDavStore,
  fullSync,
  blobPath,
  collectionIndexPath,
  COLLECTIONS,
  LIBRARY_INDEX_PATH,
  sha256Hex,
  type FullSyncReport,
  type RemoteStore,
} from "@zzlibrary/core";
import { createFsStore } from "@zzlibrary/core/node";
import type { Settings } from "./config";
import { SqliteSyncDevice } from "./sync-device";
import { nowSqlite } from "./db";

export interface CloudConfig {
  provider: "fs" | "webdav" | "s3";
  autoSync: boolean;
  fs?: { root: string };
  webdav?: { baseUrl: string; username?: string; password?: string; rootPath?: string };
  s3?: {
    endpoint: string; region: string; bucket: string;
    accessKeyId: string; secretAccessKey: string; prefix?: string;
  };
}

export interface SyncStatus {
  configured: boolean;
  autoSync: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastReport: FullSyncReport | null;
  revision: number;
  pendingHashFiles: number;
  running: boolean;
}

function sha256Node(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class SyncService {
  private running = false;
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private lastReport: FullSyncReport | null = null;
  private lastSyncAt: string | null = null;

  constructor(
    private settings: Settings,
    private db: DatabaseSync,
  ) {}

  configPath(): string {
    return join(this.settings.dataDir, "cloud.json");
  }

  loadConfig(): CloudConfig | null {
    const p = this.configPath();
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as CloudConfig;
    } catch {
      return null;
    }
  }

  saveConfig(config: CloudConfig): void {
    writeFileSync(this.configPath(), JSON.stringify(config, null, 2), "utf-8");
  }

  createStore(config: CloudConfig): RemoteStore {
    if (config.provider === "fs") {
      if (!config.fs?.root) throw new Error("fs 云需要配置 root 目录");
      return createFsStore(config.fs.root);
    }
    if (config.provider === "webdav") {
      const w = config.webdav;
      if (!w?.baseUrl) throw new Error("webdav 云需要配置 baseUrl");
      return createWebDavStore({ baseUrl: w.baseUrl, username: w.username, password: w.password, rootPath: w.rootPath });
    }
    const s = config.s3;
    if (!s?.endpoint || !s.bucket || !s.accessKeyId || !s.secretAccessKey) {
      throw new Error("s3 云需要 endpoint/bucket/accessKeyId/secretAccessKey");
    }
    return createS3Store({
      endpoint: s.endpoint, region: s.region || "auto", bucket: s.bucket,
      accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, prefix: s.prefix,
    });
  }

  /** 存量文件哈希回填（files.sha256 为空的本地文件；首次全量、其后增量）。 */
  hashPendingFiles(limit = 5000): number {
    const rows = this.db
      .prepare("SELECT id, file_path FROM files WHERE sha256 IS NULL AND local = 1 LIMIT ?")
      .all(limit) as Array<{ id: number; file_path: string }>;
    let hashed = 0;
    const upd = this.db.prepare("UPDATE files SET sha256 = ? WHERE id = ?");
    for (const r of rows) {
      const abs = join(this.settings.dataDir, r.file_path);
      if (!existsSync(abs)) continue; // 缺失文件下次再试
      upd.run(sha256Node(new Uint8Array(readFileSync(abs))), r.id);
      hashed += 1;
    }
    return hashed;
  }

  pendingHashCount(): number {
    return (this.db
      .prepare("SELECT COUNT(*) AS n FROM files WHERE sha256 IS NULL AND local = 1")
      .get() as { n: number }).n;
  }

  /** 立即同步（手动或防抖触发）。单飞：已在跑则直接返回。 */
  async runSync(): Promise<FullSyncReport> {
    const config = this.loadConfig();
    if (config === null) throw new Error("尚未配置云端");
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    try {
      this.hashPendingFiles();
      const device = new SqliteSyncDevice(this.db, this.settings);
      const remote = this.createStore(config);
      const report = await fullSync(device, remote, { now: () => nowSqlite().replace(" ", "T") });
      this.lastReport = report;
      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
      return report;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRetry(); // autoSync 开启时 60 秒后自动补一次（网络/云端恢复）
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** 写后自动同步：防抖 8 秒（配置了云且 autoSync 开启时生效）。
   * 失败自动重试：60 秒后补一次（网络恢复/云端恢复的场景）。 */
  queueLocalChange(): void {
    const config = this.loadConfig();
    if (config === null || !config.autoSync) return;
    if (this.queueTimer !== null) clearTimeout(this.queueTimer);
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this.runSync().catch((err) => {
        console.error("自动同步失败：", err instanceof Error ? err.message : err);
        this.scheduleRetry();
      });
    }, 8000);
    this.queueTimer.unref?.(); // 不阻止进程退出（测试/关机场景）
  }

  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** 失败重试（一次 60 秒后；重试再失败由下一次写操作或启动补同步兜底）。 */
  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.loadConfig()?.autoSync !== true) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.runSync().catch((err) => console.error("同步重试失败：", err instanceof Error ? err.message : err));
    }, 60000);
    this.retryTimer.unref?.();
  }

  status(): SyncStatus {
    const config = this.loadConfig();
    const state = this.db.prepare("SELECT value FROM sync_state WHERE key = 'revision'").get() as
      | { value: string }
      | undefined;
    return {
      configured: config !== null,
      autoSync: config?.autoSync ?? false,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastReport: this.lastReport,
      revision: state === undefined ? 0 : Number(state.value),
      pendingHashFiles: this.pendingHashCount(),
      running: this.running,
    };
  }

  /** 释放安全检查：云端确认有全部【本地现存】字节的副本才允许删。
   * local=0 的文件本无字节（跳过）；未配置云/哈希未算/字节未确认上云 → 拒绝（防永久丢失）。 */
  canRelease(packageId: number): { ok: boolean; reason: string | null } {
    if (this.loadConfig() === null) {
      return { ok: false, reason: "尚未配置云端：释放会永久丢失文件内容。请先在设置页配置云并完成一次同步" };
    }
    const files = this.db
      .prepare("SELECT name, sha256, local FROM files WHERE package_id = ?")
      .all(packageId) as Array<{ name: string; sha256: string | null; local: number }>;
    if (files.length === 0) return { ok: false, reason: "资料包没有文件" };
    const local = files.filter((f) => f.local === 1);
    if (local.length === 0) return { ok: true, reason: null }; // 无本地字节，无释放需求
    for (const f of local) {
      if (f.sha256 === null) {
        return { ok: false, reason: `「${f.name}」尚未完成哈希登记，请先「立即同步」一次再释放` };
      }
    }
    const cache = new Set(
      (this.db.prepare("SELECT sha256 FROM sync_blob_cache").all() as Array<{ sha256: string }>).map((r) => r.sha256),
    );
    for (const f of local) {
      if (!cache.has(f.sha256!)) {
        return { ok: false, reason: `「${f.name}」的内容尚未确认在云端，请先「立即同步」再释放` };
      }
    }
    return { ok: true, reason: null };
  }

  /** 释放包的本地文件字节（条目与清单保留；封面/书脊派生小图保留）。 */
  releasePackage(packageId: number): { releasedFiles: number; freedBytes: number } {
    const guard = this.canRelease(packageId);
    if (!guard.ok) throw new Error(guard.reason ?? "云端未确认副本，拒绝释放");
    const files = this.db
      .prepare("SELECT id, file_path, file_size, local FROM files WHERE package_id = ?")
      .all(packageId) as Array<{ id: number; file_path: string; file_size: number; local: number }>;
    let freed = 0;
    let released = 0;
    const seenDirs = new Set<string>();
    for (const f of files) {
      if (f.local === 0) continue;
      const abs = join(this.settings.dataDir, f.file_path);
      if (existsSync(abs)) {
        unlinkSync(abs);
        freed += f.file_size;
      }
      const dir = join(this.settings.dataDir, f.file_path.slice(0, f.file_path.lastIndexOf("/")));
      seenDirs.add(dir);
      released += 1;
    }
    this.db.prepare("UPDATE files SET local = 0 WHERE package_id = ?").run(packageId);
    // 目录空了就删（保持 files/ 树干净）
    for (const dir of seenDirs) {
      try {
        rmSync(dir, { recursive: false, force: true });
      } catch {
        /* 非空目录保留 */
      }
    }
    return { releasedFiles: released, freedBytes: freed };
  }

  /** 透明取回：本地没有文件字节时从云端拉 blob 并落缓存（人可读目录）。 */
  async ensureFileLocal(fileId: number): Promise<string> {
    const f = this.db
      .prepare("SELECT * FROM files WHERE id = ?")
      .get(fileId) as
      | { id: number; package_id: number; name: string; sha256: string | null; local: number; file_path: string }
      | undefined;
    if (f === undefined) throw new Error("文件不存在");
    const abs = join(this.settings.dataDir, f.file_path);
    if (f.local === 1 && existsSync(abs)) return abs;
    if (f.sha256 === null) throw new Error("该文件从未同步过，云端没有副本");
    const config = this.loadConfig();
    if (config === null) throw new Error("尚未配置云端，无法取回");
    const remote = this.createStore(config);
    const bytes = await remote.getBytes(blobPath(f.sha256));
    if (bytes === null) throw new Error("云端没有该文件的副本（可能尚未上传完成）");
    // 校验内容寻址
    if (sha256Node(bytes) !== f.sha256) throw new Error("云端副本校验失败");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    this.db.prepare("UPDATE files SET local = 1 WHERE id = ?").run(fileId);
    // 取回成功 = 云端确认有副本（释放安全依据）
    this.db.prepare("INSERT OR IGNORE INTO sync_blob_cache (sha256) VALUES (?)").run(f.sha256);
    return abs;
  }

  /** 真封面透明取回（包封面端点用）。返回本地路径或 null（无真封面）。 */
  async ensureCoverLocal(packageId: number): Promise<string | null> {
    const row = this.db
      .prepare("SELECT cover_sha256 FROM packages WHERE id = ?")
      .get(packageId) as { cover_sha256: string | null } | undefined;
    if (row === undefined || row.cover_sha256 === null) return null;
    const coverPath = join(this.settings.artDir, "covers", `${packageId}.png`);
    if (existsSync(coverPath)) return coverPath;
    const config = this.loadConfig();
    if (config === null) return null;
    const remote = this.createStore(config);
    const bytes = await remote.getBytes(blobPath(row.cover_sha256));
    if (bytes === null || sha256Node(bytes) !== row.cover_sha256) return null;
    mkdirSync(join(this.settings.artDir, "covers"), { recursive: true });
    writeFileSync(coverPath, bytes);
    return coverPath;
  }

  /** 整理云端（手动触发，不自动跑）——账本在云端墓碑里（墓碑 data 携带内容块引用，
   * 随同步传播，任何设备含新机恢复后都能执行 GC，不依赖本地表）：
   * ① 全部墓碑 blobRefs 中无引用的内容块 → 逐个从云端删除（先于墓碑清理，用掉引用信息）
   * ② 超过保留期的墓碑 → 云端清单 + 集合索引条目 + 本地三表（baselines/缓存/墓碑记忆，防回弹）。
   * 引用集合 = 本地活文件 ∪ baselines 全部活清单引用（files.sha256 + packages.coverSha256），
   * baselines 是 pull/push 维护的云端清单全集本地镜像 → 全程零云端全量扫描。 */
  async gcCloud(retentionDays = 180): Promise<GcReport> {
    const config = this.loadConfig();
    if (config === null) throw new Error("尚未配置云端");
    const remote = this.createStore(config);
    const report: GcReport = {
      tombstonesRemoved: 0, blobsRemoved: 0, blobBytesRemoved: 0,
      blobsSkippedReferenced: 0, errors: [],
    };

    // 0) 先同步：baselines 与云端现行全集对齐（孤儿判定的前提）
    await this.runSync();

    const cutoffMs = Date.now() - retentionDays * 86400_000;
    const baselineRows = this.db
      .prepare("SELECT path, env FROM sync_baselines")
      .all() as Array<{ path: string; env: string }>;

    // 1) 内容块孤儿清理（候选=全部墓碑携带的 blobRefs；先于墓碑清理执行）
    interface TombEnv {
      deleted?: boolean; updatedAt?: string; kind?: string;
      data?: { sha256?: unknown; coverSha256?: unknown; blobRefs?: unknown };
    }
    const parsed = new Array<TombEnv | null>(baselineRows.length);
    baselineRows.forEach((row, i) => {
      try {
        parsed[i] = JSON.parse(row.env) as TombEnv;
      } catch {
        parsed[i] = null;
      }
    });
    // 引用集合：本地活文件 + 活清单引用
    const refs = new Set<string>();
    for (const r of this.db
      .prepare("SELECT sha256 FROM files WHERE sha256 IS NOT NULL")
      .all() as Array<{ sha256: string }>) {
      refs.add(r.sha256);
    }
    for (const env of parsed) {
      if (env === null || env.deleted === true) continue;
      if (env.kind === "files" && typeof env.data?.sha256 === "string") refs.add(env.data.sha256);
      if (env.kind === "packages" && typeof env.data?.coverSha256 === "string") refs.add(env.data.coverSha256);
    }
    // 候选集合：墓碑 blobRefs（去重，带 size）
    const candidates = new Map<string, number>();
    for (const env of parsed) {
      if (env === null || env.deleted !== true || !Array.isArray(env.data?.blobRefs)) continue;
      for (const r of env.data.blobRefs as unknown[]) {
        const sha = (r as { sha256?: unknown })?.sha256;
        if (typeof sha === "string" && sha !== "") {
          const size = Number((r as { size?: unknown })?.size) || 0;
          candidates.set(sha, Math.max(candidates.get(sha) ?? 0, size));
        }
      }
    }
    for (const [sha256, size] of candidates) {
      if (refs.has(sha256)) {
        report.blobsSkippedReferenced += 1; // 仍被引用（共享/复活）——墓碑保留，下轮再看
        continue;
      }
      try {
        if (remote.remove !== undefined) await remote.remove(blobPath(sha256));
        this.db.prepare("DELETE FROM sync_blob_cache WHERE sha256 = ?").run(sha256);
        report.blobsRemoved += 1;
        report.blobBytesRemoved += size;
      } catch (err) {
        report.errors.push(`内容块 ${sha256.slice(0, 8)}…：${err instanceof Error ? err.message : err}`);
      }
    }

    // 2) 过期墓碑清理
    const expiredPaths: string[] = [];
    baselineRows.forEach((row, i) => {
      const env: TombEnv | null | undefined = parsed[i];
      if (env == null || env.deleted !== true) return;
      const t = String(env.updatedAt ?? "");
      const ms = Date.parse(t.endsWith("Z") ? t : t + "Z"); // 无 Z 的也是 UTC
      if (!Number.isNaN(ms) && ms < cutoffMs) expiredPaths.push(row.path);
    });
    if (expiredPaths.length > 0) {
      const libText = await remote.getText(LIBRARY_INDEX_PATH);
      if (libText === null) throw new Error("云端没有 library.json（数据异常）");
      const lib = JSON.parse(libText) as { revision?: number; collections: Record<string, string> };
      for (const kind of COLLECTIONS) {
        const paths = expiredPaths.filter((p) => p.startsWith(`db/${kind}/`));
        if (paths.length === 0) continue;
        for (const p of paths) {
          if (remote.remove !== undefined) await remote.remove(p);
        }
        const idxText = await remote.getText(collectionIndexPath(kind));
        const index: Record<string, string> = idxText === null ? {} : JSON.parse(idxText);
        for (const p of paths) delete index[p];
        const text = JSON.stringify(index);
        await remote.putText(collectionIndexPath(kind), text);
        lib.collections[kind] = await sha256Hex(text);
      }
      const revision = Math.max(lib.revision ?? 0, await this.revisionOf()) + 1;
      lib.revision = revision;
      await remote.putText(LIBRARY_INDEX_PATH, JSON.stringify(lib));
      for (const p of expiredPaths) {
        this.db.prepare("DELETE FROM sync_baselines WHERE path = ?").run(p);
        this.db.prepare("DELETE FROM sync_manifest_cache WHERE path = ?").run(p);
        this.db.prepare("DELETE FROM sync_tombstones WHERE path = ?").run(p);
      }
      this.db
        .prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('revision', ?)")
        .run(String(revision));
      report.tombstonesRemoved = expiredPaths.length;
    }
    return report;
  }

  private async revisionOf(): Promise<number> {
    const row = this.db.prepare("SELECT value FROM sync_state WHERE key = 'revision'").get() as
      | { value: string }
      | undefined;
    return row === undefined ? 0 : Number(row.value);
  }
}

export interface GcReport {
  tombstonesRemoved: number;
  blobsRemoved: number;
  blobBytesRemoved: number;
  blobsSkippedReferenced: number;
  errors: string[];
}
