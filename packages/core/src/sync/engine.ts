/** 同步引擎：pull（云端→本地合并）/ push（本地→云端）/ fullSync。
 *
 * 本地侧通过 LocalDevice 适配（server=SQLite，测试=内存设备；
 * CP2 Tauri / CP3 Expo 各自实现同一接口）。
 *
 * push 顺序（防悬空引用）：内容块 → 清单 → 集合索引 → library.json（提交点）。
 * pull 判定：一次根索引请求 + 变更集合索引 + 变更清单；清单条目只增不删，
 * 索引合并是并集 → 双端先后推送不会互相丢条目。 */

import {
  APPLY_ORDER,
  COLLECTIONS,
  LIBRARY_INDEX_PATH,
  MANIFEST_VERSION,
  blobPath,
  collectionIndexPath,
  envelope,
  manifestPath,
  manifestText,
  parseManifestPath,
  sha256Hex,
  type Collection,
  type CollectionIndex,
  type LibraryIndex,
  type ManifestEnvelope,
  type CategoryData,
} from "./contract";
import type { ApplyOutcome } from "./merge";
import type { RemoteStore } from "../remote/store";

// ---------- 本地设备接口 ----------

export interface LocalManifest {
  /** null = 自上次构建未变化的复用条目（增量构建设备）；仅在 sha 变化需上传时才要求非空 */
  env: ManifestEnvelope | null;
  /** 规范 JSON 文本（哈希与上传的字节）；null = 未变化（引擎按需经 readManifestText 取回） */
  text: string | null;
  /** 清单文本的 sha256（差分依据） */
  sha: string;
  /** 本清单引用、需确保已上云的内容块（文件字节/封面图）；复用条目为 []（不会触发上传） */
  blobSha256s: string[];
}

export interface LocalDevice {
  deviceId: string;
  /** 全量本地实体 → 清单（设备可增量构建：未变化条目以 sha-only 复用表示） */
  buildManifests(): Promise<Map<string, LocalManifest>>;
  /** 按路径取回清单文本（增量设备的复用条目按需取回）；无则 null */
  readManifestText?(path: string): Promise<string | null>;
  /** 读内容块字节（按哈希找本地文件/封面）；无则 null */
  readBlob(sha256: string): Promise<Uint8Array | null>;
  /** 应用一份远端清单（合并判断可复用 merge.ts） */
  applyRemote(env: ManifestEnvelope): Promise<ApplyOutcome>;
  /** 应用批次的事务边界（apply 全部结束后 commit=true 提交） */
  beginApply(): Promise<void>;
  endApply(commit: boolean): Promise<void>;
  // ---- 云端状态缓存（上次同步时已知） ----
  getManifestCache(): Promise<Map<string, string>>;
  setManifestCache(entries: Map<string, string>): Promise<void>;
  getCollectionHashes(): Promise<Partial<Record<Collection, string>>>;
  setCollectionHashes(hashes: Partial<Record<Collection, string>>): Promise<void>;
  /** 已确认上云的内容块哈希（免重复 HEAD） */
  getBlobCache(): Promise<Set<string>>;
  addBlobCache(hash: string): Promise<void>;
  getRevision(): Promise<number>;
  setRevision(revision: number): Promise<void>;
  /** 可选：引擎告知「该路径当前云端内容」（三方合并的基线） */
  noteBaseline?(path: string, env: ManifestEnvelope): void;
}

// ---------- pull ----------

export interface PullReport {
  cloudEmpty: boolean;
  fetched: number;
  applied: number;
  localNewer: number;
  tombstones: number;
  noop: number;
  errors: string[];
  revision: number;
}

export async function pull(device: LocalDevice, remote: RemoteStore): Promise<PullReport> {
  const report: PullReport = {
    cloudEmpty: false, fetched: 0, applied: 0, localNewer: 0,
    tombstones: 0, noop: 0, errors: [], revision: 0,
  };
  const libText = await remote.getText(LIBRARY_INDEX_PATH);
  if (libText === null) {
    report.cloudEmpty = true;
    return report;
  }
  let lib: LibraryIndex;
  try {
    lib = JSON.parse(libText) as LibraryIndex;
  } catch {
    throw new Error("library.json 解析失败（云端数据异常？）");
  }
  report.revision = lib.revision ?? 0;

  const cachedPaths = await device.getManifestCache();
  const colHashes = await device.getCollectionHashes();
  const newPaths = new Map(cachedPaths);
  const envs: ManifestEnvelope[] = [];
  const failedPaths = new Set<string>();

  for (const kind of COLLECTIONS) {
    const cloudHash = lib.collections[kind];
    if (cloudHash === undefined) continue;
    if (colHashes[kind] === cloudHash) continue; // 集合未变
    const idxText = await remote.getText(collectionIndexPath(kind));
    let index: CollectionIndex = {};
    if (idxText !== null) {
      try {
        index = JSON.parse(idxText) as CollectionIndex;
      } catch {
        report.errors.push(`集合索引解析失败：${kind}`);
        continue;
      }
    }
    for (const [path, sha] of Object.entries(index)) {
      if (cachedPaths.get(path) === sha) continue; // 已知且未变
      const text = await remote.getText(path);
      if (text === null) {
        report.errors.push(`清单缺失：${path}`);
        failedPaths.add(path);
        continue;
      }
      try {
        envs.push(JSON.parse(text) as ManifestEnvelope);
        report.fetched += 1;
      } catch {
        report.errors.push(`清单解析失败：${path}`);
        failedPaths.add(path);
      }
    }
    // 该集合在本设备视角的云端终态
    for (const key of newPaths.keys()) {
      if (key.startsWith(`db/${kind}/`) && !(key in index)) newPaths.delete(key);
    }
    for (const [path, sha] of Object.entries(index)) newPaths.set(path, sha);
  }

  // 应用顺序：categories 按层级升序在前（父先于子），其余按 APPLY_ORDER
  const rank = new Map<Collection, number>(APPLY_ORDER.map((k, i) => [k, i]));
  envs.sort((a, b) => {
    const ra = rank.get(a.kind) ?? 99;
    const rb = rank.get(b.kind) ?? 99;
    if (ra !== rb) return ra - rb;
    const la = a.kind === "categories" ? (a.data as CategoryData).level ?? 0 : 0;
    const lb = b.kind === "categories" ? (b.data as CategoryData).level ?? 0 : 0;
    return la - lb;
  });

  await device.beginApply();
  try {
    for (const env of envs) {
      try {
        const outcome = await device.applyRemote(env);
        if (outcome === "applied") report.applied += 1;
        else if (outcome === "local-newer") report.localNewer += 1;
        else if (outcome === "tombstone-applied") report.tombstones += 1;
        else report.noop += 1;
        // 处理成功后记录基线（云端该路径现行内容；合并发生在更新之前）
        device.noteBaseline?.(manifestPath(env.kind, env.uuid), env);
      } catch (err) {
        // 单条失败不中止（应用幂等可重入）；缓存不认领该路径，下次 pull 重试
        failedPaths.add(manifestPath(env.kind, env.uuid));
        report.errors.push(`${manifestPath(env.kind, env.uuid)}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await device.endApply(true);
  }

  for (const p of failedPaths) newPaths.delete(p);
  await device.setManifestCache(newPaths);
  await device.setCollectionHashes(lib.collections);
  await device.setRevision(lib.revision ?? 0);
  return report;
}

// ---------- push ----------

export interface PushReport {
  uploadedManifests: number;
  tombstoned: number;
  uploadedBlobs: number;
  uploadedBlobBytes: number;
  skippedNoBlob: number;
  revision: number;
  errors: string[];
}

export interface SyncOptions {
  /** 墓碑时间戳来源（默认当前 ISO 时刻） */
  now?: () => string;
}

export async function push(
  device: LocalDevice,
  remote: RemoteStore,
  opts: SyncOptions = {},
): Promise<PushReport> {
  const now = opts.now ?? (() => new Date().toISOString());
  const report: PushReport = {
    uploadedManifests: 0, tombstoned: 0, uploadedBlobs: 0,
    uploadedBlobBytes: 0, skippedNoBlob: 0, revision: 0, errors: [],
  };

  const local = await device.buildManifests();
  const cachedPaths = await device.getManifestCache();
  if (cachedPaths.size > 0 && local.size === 0) {
    throw new Error(`本地库为空而云端有 ${cachedPaths.size} 个实体，已阻止推送（防误清空；请先拉取）`);
  }

  interface Upload {
    path: string;
    env: ManifestEnvelope;
    text: string;
    sha: string;
    blobs: string[];
    tombstone: boolean;
  }
  const uploads = new Map<string, Upload>();
  for (const [path, m] of local) {
    if (cachedPaths.get(path) === m.sha) continue;
    // 增量设备的复用条目（sha 变化但本地未变：云端被他端推进而 pull 未及看到）——按需取回文本
    let env = m.env;
    let text = m.text;
    let blobs = m.blobSha256s;
    if (env === null || text === null) {
      const cached = (await device.readManifestText?.(path)) ?? null;
      if (cached === null) {
        report.errors.push(`清单不可得（增量缓存缺失）：${path}`);
        continue;
      }
      try {
        env = JSON.parse(cached) as ManifestEnvelope;
        text = cached;
      } catch {
        report.errors.push(`清单缓存解析失败：${path}`);
        continue;
      }
      // 复用条目的 blobs 为空——从 env 重新派生（files=内容块，packages=真封面）
      if (blobs.length === 0 && !env.deleted) {
        if (env.kind === "files") {
          const s = (env.data as { sha256?: unknown }).sha256;
          if (typeof s === "string" && s) blobs = [s];
        } else if (env.kind === "packages") {
          const s = (env.data as { coverSha256?: unknown }).coverSha256;
          if (typeof s === "string" && s) blobs = [s];
        }
      }
    }
    uploads.set(path, { path, env, text, sha: m.sha, blobs, tombstone: env.deleted });
  }
  // 云端有而本地无 → 墓碑（删除传播；条目留在索引里防复活）。
  // 兜底网：设备正常情况下由 buildManifests 携带墓碑（含原 updatedAt，幂等）；
  // 走到这里说明设备丢失了墓碑记忆——先查云端是否已是墓碑，是则认领缓存即可，避免每次同步重造。
  for (const path of cachedPaths.keys()) {
    if (local.has(path)) continue;
    const parsed = parseManifestPath(path);
    if (!parsed) continue;
    const remoteText = await remote.getText(path);
    if (remoteText !== null) {
      try {
        const existing = JSON.parse(remoteText) as ManifestEnvelope;
        if (existing.deleted) continue; // 云端已是墓碑，无需重造
      } catch {
        /* 解析失败按缺失处理 */
      }
    }
    const env = envelope(parsed.kind, parsed.uuid, now(), {}, true);
    const text = manifestText(env);
    uploads.set(path, { path, env, text, sha: await sha256Hex(text), blobs: [], tombstone: true });
  }

  if (uploads.size === 0) {
    report.revision = await device.getRevision();
    return report;
  }

  // 1) 内容块先行（内容寻址，重复上传无害；已上云的跳过）
  const blobCache = await device.getBlobCache();
  const blobFailed = new Set<string>();
  for (const up of uploads.values()) {
    for (const h of up.blobs) {
      if (!h || blobFailed.has(h) || blobCache.has(h)) continue;
      if (await remote.head(blobPath(h))) {
        await device.addBlobCache(h);
        continue;
      }
      const bytes = await device.readBlob(h);
      if (bytes === null) {
        blobFailed.add(h);
        continue;
      }
      await remote.putBytes(blobPath(h), bytes);
      await device.addBlobCache(h);
      report.uploadedBlobs += 1;
      report.uploadedBlobBytes += bytes.length;
    }
  }

  // 2) 上传清单（内容块缺失的跳过，防指向不存在的块）
  const touched = new Set<Collection>();
  const uploaded = new Map<string, Upload>();
  for (const up of uploads.values()) {
    if (up.blobs.some((h) => blobFailed.has(h))) {
      report.skippedNoBlob += 1;
      report.errors.push(`本地内容块缺失，跳过清单：${up.path}`);
      continue;
    }
    await remote.putText(up.path, up.text);
    device.noteBaseline?.(up.path, up.env);
    uploaded.set(up.path, up);
    report.uploadedManifests += 1;
    if (up.tombstone) report.tombstoned += 1;
    const parsed = parseManifestPath(up.path);
    if (parsed) touched.add(parsed.kind);
  }

  // 3) 受影响集合的索引 = 云端现行索引 ∪ 本次成功上传（条目只增 → 并集安全）
  const cloudText = await remote.getText(LIBRARY_INDEX_PATH);
  let lib: LibraryIndex = { manifestVersion: MANIFEST_VERSION, revision: 0, collections: {} };
  if (cloudText !== null) {
    try {
      lib = JSON.parse(cloudText) as LibraryIndex;
    } catch {
      throw new Error("云端 library.json 解析失败，已中止推送");
    }
  }
  const newPaths = new Map(cachedPaths);
  const newColHashes: Partial<Record<Collection, string>> = { ...lib.collections };
  for (const kind of touched) {
    const idxText = await remote.getText(collectionIndexPath(kind));
    let index: CollectionIndex = {};
    if (idxText !== null) {
      try {
        index = JSON.parse(idxText) as CollectionIndex;
      } catch {
        report.errors.push(`云端集合索引解析失败：${kind}，按空重建`);
      }
    }
    for (const [path, up] of uploaded) {
      if (parseManifestPath(path)?.kind !== kind) continue;
      index[path] = up.sha;
    }
    const text = JSON.stringify(index);
    await remote.putText(collectionIndexPath(kind), text);
    newColHashes[kind] = await sha256Hex(text);
    for (const key of newPaths.keys()) {
      if (key.startsWith(`db/${kind}/`) && !(key in index)) newPaths.delete(key);
    }
    for (const [p, sha] of Object.entries(index)) newPaths.set(p, sha);
  }

  // 4) 提交点：library.json 最后写（读端只认它）
  const revision = Math.max(lib.revision ?? 0, await device.getRevision()) + 1;
  const newLib: LibraryIndex = { manifestVersion: MANIFEST_VERSION, revision, collections: newColHashes };
  await remote.putText(LIBRARY_INDEX_PATH, JSON.stringify(newLib));

  await device.setManifestCache(newPaths);
  await device.setCollectionHashes(newColHashes);
  await device.setRevision(revision);
  report.revision = revision;
  return report;
}

export interface FullSyncReport {
  pull: PullReport;
  push: PushReport;
}

/** 拉取合并后再推送（推送的是合并后的全量差异，双端最终一致）。 */
export async function fullSync(
  device: LocalDevice,
  remote: RemoteStore,
  opts: SyncOptions = {},
): Promise<FullSyncReport> {
  const pullReport = await pull(device, remote);
  const pushReport = await push(device, remote, opts);
  return { pull: pullReport, push: pushReport };
}
