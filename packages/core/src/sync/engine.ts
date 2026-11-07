/** 同步引擎：pull（云端→本地合并）/ push（本地→云端）/ fullSync。
 *
 * v2 分桶聚合：清单按 bucketOf 分进 1024 桶/集合，每桶一个云文件；
 * 集合桶索引（db/<kind>.idx.json）只列非空桶 → 云对象数与馆藏规模解耦。
 *
 * 本地侧通过 LocalDevice 适配（server=SQLite，测试=内存设备；
 * CP2 Tauri / CP3 Expo 各自实现同一接口）。
 *
 * push 顺序（防悬空引用）：内容块 → 桶文件 → 集合桶索引 → library.json（提交点）。
 * pull 判定：根索引 → 变更集合的桶索引 → 桶级 sha diff → 仅取变化桶 → 桶内实体级 diff 应用；
 * 桶条目只增不删、索引合并是并集 → 双端先后推送不会互相丢条目。 */

import {
  APPLY_ORDER,
  COLLECTIONS,
  LIBRARY_INDEX_PATH,
  MANIFEST_VERSION,
  blobPath,
  bucketOf,
  bucketPath,
  bucketText,
  collectionIndexPath,
  envelope,
  manifestPath,
  manifestText,
  parseManifestPath,
  sha256Hex,
  type BucketAggregate,
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
  /** 按逻辑键取回清单文本（增量设备的复用条目按需取回）；无则 null */
  readManifestText?(path: string): Promise<string | null>;
  /** 按逻辑键取回本地墓碑记忆（含 updatedAt 与 data.blobRefs——删除记账随墓碑上云）；无则 null */
  readTombstone?(path: string): Promise<{ updatedAt: string; data: Record<string, unknown> } | null>;
  /** 冲刷设备侧批量缓冲的缓存写（基线/块缓存）；同步收尾时引擎调用 */
  flushPendingWrites?(): Promise<void> | void;
  /** 读内容块字节（按哈希找本地文件/封面）；无则 null */
  readBlob(sha256: string): Promise<Uint8Array | null>;
  /** 内容块流式读取（大文件不整读进内存；size 供上传报告）。null=无/不支持 → 回退 readBlob */
  readBlobStream?(sha256: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null>;
  /** 应用一份远端清单（合并判断可复用 merge.ts） */
  applyRemote(env: ManifestEnvelope): Promise<ApplyOutcome>;
  /** 应用批次的事务边界（apply 全部结束后 commit=true 提交） */
  beginApply(): Promise<void>;
  endApply(commit: boolean): Promise<void>;
  // ---- 云端状态缓存（上次同步时已知） ----
  /** 逐实体逻辑键 → 云端清单 sha */
  getManifestCache(): Promise<Map<string, string>>;
  setManifestCache(entries: Map<string, string>): Promise<void>;
  /** 桶文件路径 → 云端桶 sha（pull 桶级 diff 依据） */
  getBucketShas(): Promise<Map<string, string>>;
  setBucketShas(entries: Map<string, string>): Promise<void>;
  getCollectionHashes(): Promise<Partial<Record<Collection, string>>>;
  setCollectionHashes(hashes: Partial<Record<Collection, string>>): Promise<void>;
  /** 已确认上云的内容块哈希（免重复 HEAD） */
  getBlobCache(): Promise<Set<string>>;
  addBlobCache(hash: string): Promise<void>;
  getRevision(): Promise<number>;
  setRevision(revision: number): Promise<void>;
  /** 可选：引擎告知「该实体当前云端内容」（三方合并的基线） */
  noteBaseline?(path: string, env: ManifestEnvelope): void;
}

// ---------- 云端布局守卫 ----------

/** 云端根索引的布局版本与当前协议不符 → 拒绝同步（防 v1/v2 混写）。 */
function assertLayoutVersion(lib: LibraryIndex, where: string): void {
  const v = lib.manifestVersion ?? 1;
  if (v !== MANIFEST_VERSION) {
    throw new Error(
      `云端布局为 v${v}（本端 v${MANIFEST_VERSION}，${where}）：请先清空云端 db/ 目录与 library.json 再全量重推`,
    );
  }
}

/** 解析云端桶聚合文本（字段宽松校验）。 */
function parseBucket(text: string, path: string): BucketAggregate {
  const agg = JSON.parse(text) as BucketAggregate;
  if (agg === null || typeof agg !== "object" || typeof agg.entities !== "object" || agg.entities === null) {
    throw new Error(`桶聚合格式异常：${path}`);
  }
  return agg;
}

// ---------- pull ----------

export interface PullReport {
  cloudEmpty: boolean;
  fetchedBuckets: number;
  /** 桶内实体级差分命中的条数（下载桶中与本地已知不同的实体） */
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
    cloudEmpty: false, fetchedBuckets: 0, fetched: 0, applied: 0, localNewer: 0,
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
  assertLayoutVersion(lib, "pull");

  const cachedPaths = await device.getManifestCache();
  const cachedBuckets = await device.getBucketShas();
  const colHashes = await device.getCollectionHashes();
  const newPaths = new Map(cachedPaths);
  const newBuckets = new Map(cachedBuckets);
  const envs: ManifestEnvelope[] = [];
  const failedKinds = new Set<Collection>();

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
        report.errors.push(`集合桶索引解析失败：${kind}`);
        failedKinds.add(kind);
        continue;
      }
    }
    // 桶级 diff：仅取 sha 变化的桶
    const toFetch: Array<{ bucket: string; path: string; sha: string }> = [];
    for (const [bucket, sha] of Object.entries(index)) {
      if (cachedBuckets.get(bucketPath(kind, bucket)) === sha) continue;
      toFetch.push({ bucket, path: bucketPath(kind, bucket), sha });
    }
    const membership = new Map<string, Map<string, string>>(); // 桶 → (uuid → 实体 sha)
    let kindFailed = false;
    await pooled(toFetch, 6, async (t) => {
      const text = await remote.getText(t.path);
      if (text === null) {
        report.errors.push(`桶缺失：${t.path}`);
        kindFailed = true;
        return;
      }
      let agg: BucketAggregate;
      try {
        agg = parseBucket(text, t.path);
      } catch (err) {
        report.errors.push(`桶解析失败：${t.path}：${err instanceof Error ? err.message : String(err)}`);
        kindFailed = true;
        return;
      }
      const members = new Map<string, string>();
      for (const [uuid, envRaw] of Object.entries(agg.entities)) {
        const env = envRaw as ManifestEnvelope;
        const key = manifestPath(kind, uuid);
        const sha = await sha256Hex(manifestText(env));
        members.set(uuid, sha);
        if (cachedPaths.get(key) === sha) continue; // 实体未变
        envs.push(env);
        report.fetched += 1;
      }
      membership.set(t.bucket, members);
      report.fetchedBuckets += 1;
    });
    // 实体级缓存修剪：桶索引即成员权威——不在索引桶里的/已_fetch 桶中缺席的实体键清除
    for (const key of newPaths.keys()) {
      if (!key.startsWith(`db/${kind}/`)) continue;
      const parsed = parseManifestPath(key);
      if (parsed === null) continue;
      const bucket = bucketOf(parsed.uuid);
      if (!(bucket in index)) {
        newPaths.delete(key);
        continue;
      }
      const members = membership.get(bucket);
      if (members !== undefined && !members.has(parsed.uuid)) newPaths.delete(key);
    }
    for (const [bucket, members] of membership) {
      for (const [uuid, sha] of members) newPaths.set(manifestPath(kind, uuid), sha);
    }
    // 桶缓存认领（失败桶不认领 → 下次重取）
    for (const [bucket] of newBuckets) {
      if (bucket.startsWith(`db/${kind}/`) && !(bucket in index)) newBuckets.delete(bucket);
    }
    for (const [bucket, sha] of Object.entries(index)) {
      if (membership.has(bucket)) newBuckets.set(bucketPath(kind, bucket), sha);
      else if (cachedBuckets.get(bucketPath(kind, bucket)) === sha) {
        newBuckets.set(bucketPath(kind, bucket), sha);
      }
    }
    if (kindFailed) failedKinds.add(kind);
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

  const failedPaths = new Set<string>();
  await device.beginApply();
  try {
    for (const env of envs) {
      try {
        const outcome = await device.applyRemote(env);
        if (outcome === "applied") report.applied += 1;
        else if (outcome === "local-newer") report.localNewer += 1;
        else if (outcome === "tombstone-applied") report.tombstones += 1;
        else report.noop += 1;
        // 处理成功后记录基线（云端该实体现行内容；合并发生在更新之前）
        device.noteBaseline?.(manifestPath(env.kind, env.uuid), env);
      } catch (err) {
        // 单条失败不中止（应用幂等可重入）；缓存不认领该实体，下次 pull 重试
        failedPaths.add(manifestPath(env.kind, env.uuid));
        failedKinds.add(env.kind);
        report.errors.push(`${manifestPath(env.kind, env.uuid)}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await device.endApply(true);
  }

  for (const p of failedPaths) newPaths.delete(p);
  await device.setManifestCache(newPaths);
  await device.setBucketShas(newBuckets);
  // 有失败桶/失败实体的集合不落哈希——否则下次 pull 因「集合未变」跳过整个集合，失败内容永不重试
  const hashesToSave: Partial<Record<Collection, string>> = { ...lib.collections };
  for (const k of failedKinds) delete hashesToSave[k];
  await device.setCollectionHashes(hashesToSave);
  await device.setRevision(lib.revision ?? 0);
  return report;
}

// ---------- push ----------

export interface PushReport {
  uploadedManifests: number;
  uploadedBuckets: number;
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

/** 有界并发执行（大馆藏首拉/大批量变更不再逐条串行 RTT）；fn 自行 try/catch，抛错立即冒泡。 */
async function pooled<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (i < items.length) {
      const item = items[i]!;
      i += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function push(
  device: LocalDevice,
  remote: RemoteStore,
  opts: SyncOptions = {},
): Promise<PushReport> {
  const now = opts.now ?? (() => new Date().toISOString());
  const report: PushReport = {
    uploadedManifests: 0, uploadedBuckets: 0, tombstoned: 0,
    uploadedBlobs: 0, uploadedBlobBytes: 0, skippedNoBlob: 0, revision: 0, errors: [],
  };

  // 云端根索引（提交点基准；顺带做布局版本守卫）
  const cloudText = await remote.getText(LIBRARY_INDEX_PATH);
  let lib: LibraryIndex = { manifestVersion: MANIFEST_VERSION, revision: 0, collections: {} };
  if (cloudText !== null) {
    try {
      lib = JSON.parse(cloudText) as LibraryIndex;
    } catch {
      throw new Error("云端 library.json 解析失败，已中止推送");
    }
    assertLayoutVersion(lib, "push");
  }

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
  // 云端有而本地无 → 墓碑（删除传播；实体留在桶里防复活）。
  // 兜底网：设备正常情况下由 buildManifests 携带墓碑（含原 updatedAt，幂等）；
  // 走到这里说明设备丢失了墓碑记忆——优先用本地墓碑记忆（readTombstone），
  // 真没有才在装配桶时对照云端桶（已删则采纳云端版本保住 updatedAt）或造无记账的新墓碑。
  const missingPaths = new Map<string, { kind: Collection; uuid: string }>();
  for (const path of cachedPaths.keys()) {
    if (local.has(path)) continue;
    const parsed = parseManifestPath(path);
    if (parsed === null) continue;
    missingPaths.set(path, parsed);
  }
  const synthesizedTombstones = new Map<string, ManifestEnvelope>();
  for (const [path, parsed] of missingPaths) {
    const t = (await device.readTombstone?.(path)) ?? null;
    if (t !== null) {
      synthesizedTombstones.set(path, envelope(parsed.kind, parsed.uuid, t.updatedAt, t.data, true));
    }
    // 无本地记忆的：装配阶段对照云端桶后决定（cloudAdopt 或 now() 新墓碑）
  }

  // 零改动零缺失 → 不写云（连 library.json 都不动，revision 不涨；与 v1 语义一致）
  if (uploads.size === 0 && missingPaths.size === 0) {
    report.revision = await device.getRevision();
    return report;
  }

  // ---- 确定被触碰的桶（改动实体 ∪ 缺失实体所在桶）----
  const bucketJobs = new Map<string, { kind: Collection; bucket: string }>();
  const bucketKeyOf = (kind: Collection, uuid: string) => `${kind}/${bucketOf(uuid)}`;
  for (const [path, m] of local) {
    if (cachedPaths.get(path) === m.sha && !uploads.has(path)) continue;
    const parsed = parseManifestPath(path);
    if (parsed === null) continue;
    bucketJobs.set(bucketKeyOf(parsed.kind, parsed.uuid), { kind: parsed.kind, bucket: bucketOf(parsed.uuid) });
  }
  for (const [, parsed] of missingPaths) {
    bucketJobs.set(bucketKeyOf(parsed.kind, parsed.uuid), { kind: parsed.kind, bucket: bucketOf(parsed.uuid) });
  }

  // ---- 内容块先行（防悬空引用；失败块的实体不进桶）----
  const blobFailed = new Set<string>();
  const blobCache = await device.getBlobCache();
  const needBlobs = new Map<string, number>(); // sha → 字节计数
  for (const up of uploads.values()) {
    for (const h of up.blobs) {
      if (blobCache.has(h)) continue;
      needBlobs.set(h, (needBlobs.get(h) ?? 0) + up.blobs.length);
    }
  }
  const blobItems = [...needBlobs.keys()].filter((h) => !!h); // 假值防御（历史清单可能出现 null 字段引用）
  await pooled(blobItems, 4, async (h) => {
    if (blobCache.has(h)) return;
    const head = await remote.head(blobPath(h)).catch(() => false);
    if (head) {
      device.addBlobCache(h);
      return;
    }
    // 流式优先：大 blob 逐段上传不整读进内存（S3=multipart，fs=写流）
    if (remote.putStream !== undefined && device.readBlobStream !== undefined) {
      const s = await device.readBlobStream(h);
      if (s !== null) {
        try {
          await remote.putStream(blobPath(h), s.stream);
        } catch (err) {
          report.errors.push(`流式上传失败：${h.slice(0, 8)}…：${err instanceof Error ? err.message : String(err)}`);
          blobFailed.add(h);
          return;
        }
        device.addBlobCache(h);
        report.uploadedBlobs += 1;
        report.uploadedBlobBytes += s.size;
        return;
      }
    }
    const bytes = await device.readBlob(h);
    if (bytes === null) {
      blobFailed.add(h);
      return;
    }
    await remote.putBytes(blobPath(h), bytes);
    device.addBlobCache(h);
    report.uploadedBlobs += 1;
    report.uploadedBlobBytes += bytes.length;
  });

  // ---- 装配并上传桶 ----
  // 本地全量按桶分组（一次性 O(n)；装配只发生在被触碰的桶）
  const localByBucket = new Map<string, Array<[string, LocalManifest]>>();
  for (const [path, m] of local) {
    const parsed = parseManifestPath(path);
    if (parsed === null) continue;
    const bk = bucketKeyOf(parsed.kind, parsed.uuid);
    let arr = localByBucket.get(bk);
    if (arr === undefined) {
      arr = [];
      localByBucket.set(bk, arr);
    }
    arr.push([path, m]);
  }
  const missingByBucket = new Map<string, Array<[string, { kind: Collection; uuid: string }]>>();
  for (const [path, parsed] of missingPaths) {
    const bk = bucketKeyOf(parsed.kind, parsed.uuid);
    let arr = missingByBucket.get(bk);
    if (arr === undefined) {
      arr = [];
      missingByBucket.set(bk, arr);
    }
    arr.push([path, parsed]);
  }

  const cachedBuckets = await device.getBucketShas();
  const newPaths = new Map(cachedPaths);
  const newBuckets = new Map(cachedBuckets);
  const touchedKinds = new Set<Collection>();
  const uploadedBuckets = new Map<string, string>(); // bucketPath → sha（云端内容已确认为此 sha）
  /** 装配一个桶：本地全体实体 + 缺失实体（云端采纳/新墓碑）。null = 桶失败（不上传，云端保持旧内容）。 */
  const assembleBucket = async (
    kind: Collection,
    bucket: string,
  ): Promise<Array<{ key: string; env: ManifestEnvelope; sha: string }> | null> => {
    const out: Array<{ key: string; env: ManifestEnvelope; sha: string }> = [];
    // 1) 本桶本地实体（改动条目直接用；复用条目经 readManifestText 水化）
    for (const [path, m] of localByBucket.get(`${kind}/${bucket}`) ?? []) {
      const up = uploads.get(path);
      if (up !== undefined) {
        // 内容块缺失 → 整桶放弃上传（桶是成员权威，缺员上传 = 云端丢实体；云端保持旧桶，下次重试）
        if (up.blobs.some((h) => blobFailed.has(h))) {
          report.skippedNoBlob += 1;
          report.errors.push(`本地内容块缺失，跳过桶：${bucketPath(kind, bucket)}（含 ${path}）`);
          return null;
        }
        out.push({ key: path, env: up.env, sha: up.sha });
        continue;
      }
      if (m.env !== null && m.text !== null) {
        out.push({ key: path, env: m.env, sha: m.sha });
        continue;
      }
      const cached = (await device.readManifestText?.(path)) ?? null;
      if (cached === null) {
        report.errors.push(`桶装配失败（复用条目不可得）：${path}`);
        return null;
      }
      try {
        out.push({ key: path, env: JSON.parse(cached) as ManifestEnvelope, sha: m.sha });
      } catch {
        report.errors.push(`桶装配失败（复用条目解析）：${path}`);
        return null;
      }
    }
    // 2) 缺失实体：对照云端桶（已删→采纳保 updatedAt；云端无/仍在→新墓碑）
    const missings = missingByBucket.get(`${kind}/${bucket}`) ?? [];
    if (missings.length > 0) {
      const cloudBucketText = await remote.getText(bucketPath(kind, bucket));
      let cloudEntities: Record<string, ManifestEnvelope> = {};
      if (cloudBucketText !== null) {
        try {
          cloudEntities = parseBucket(cloudBucketText, bucketPath(kind, bucket)).entities;
        } catch {
          /* 云端桶损坏按无该实体处理 → 造新墓碑 */
        }
      }
      for (const [path, parsed] of missings) {
        const known = synthesizedTombstones.get(path);
        if (known !== undefined) {
          const sha = await sha256Hex(manifestText(known));
          out.push({ key: path, env: known, sha });
          continue;
        }
        const cloudEnv = cloudEntities[parsed.uuid];
        if (cloudEnv !== undefined && cloudEnv.deleted) {
          // 云端已是墓碑 → 采纳（幂等；不重置 GC 保留期时钟）
          const sha = await sha256Hex(manifestText(cloudEnv));
          out.push({ key: path, env: cloudEnv, sha });
          continue;
        }
        const fresh = envelope(parsed.kind, parsed.uuid, now(), {}, true);
        const sha = await sha256Hex(manifestText(fresh));
        out.push({ key: path, env: fresh, sha });
      }
    }
    return out;
  };

  const jobList = [...bucketJobs.values()];
  await pooled(jobList, 6, async (job) => {
    const entities = await assembleBucket(job.kind, job.bucket);
    if (entities === null) return; // 桶失败：不认领、不动 idx
    if (entities.length === 0) return; // 空桶不写（成员权威只认非空）
    const text = bucketText(job.kind, job.bucket, entities.map((e) => e.env));
    const sha = await sha256Hex(text);
    const bPath = bucketPath(job.kind, job.bucket);
    if (cachedBuckets.get(bPath) === sha) {
      // 内容与云端一致（如全部缺失实体云端已是墓碑）——免传，直接认领
      uploadedBuckets.set(bPath, sha);
      for (const e of entities) newPaths.set(e.key, e.sha);
      return;
    }
    try {
      await remote.putText(bPath, text);
    } catch (err) {
      report.errors.push(`桶上传失败：${bPath}：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    uploadedBuckets.set(bPath, sha);
    report.uploadedBuckets += 1;
    touchedKinds.add(job.kind);
    let changed = 0;
    let tombstoned = 0;
    for (const e of entities) {
      device.noteBaseline?.(e.key, e.env);
      newPaths.set(e.key, e.sha);
      if (uploads.has(e.key) || missingPaths.has(e.key)) {
        changed += 1;
        if (e.env.deleted) tombstoned += 1;
      }
    }
    report.uploadedManifests += changed;
    report.tombstoned += tombstoned;
  });

  // ---- 集合桶索引重建（云端现行 ∪ 本次成功上传）→ library.json 提交点 ----
  const newColHashes: Partial<Record<Collection, string>> = { ...lib.collections };
  for (const kind of touchedKinds) {
    const idxText = await remote.getText(collectionIndexPath(kind));
    let index: CollectionIndex = {};
    if (idxText !== null) {
      try {
        index = JSON.parse(idxText) as CollectionIndex;
      } catch {
        report.errors.push(`云端集合桶索引解析失败：${kind}，按空重建`);
      }
    }
    for (const [bPath, sha] of uploadedBuckets) {
      if (!bPath.startsWith(`db/${kind}/`)) continue;
      index[bPath.slice(`db/${kind}/`.length, -".json".length)] = sha;
    }
    const text = JSON.stringify(index);
    await remote.putText(collectionIndexPath(kind), text);
    newColHashes[kind] = await sha256Hex(text);
    // 实体级缓存修剪：桶索引是成员权威——不在任何索引桶里的实体键清除
    for (const key of newPaths.keys()) {
      if (!key.startsWith(`db/${kind}/`)) continue;
      const parsed = parseManifestPath(key);
      if (parsed === null) continue;
      if (!(bucketOf(parsed.uuid) in index)) newPaths.delete(key);
    }
    // 桶缓存同步（索引里消失的桶清除；索引断言的桶认领）
    for (const [bPath] of newBuckets) {
      if (bPath.startsWith(`db/${kind}/`)) {
        const bucket = bPath.slice(`db/${kind}/`.length, -".json".length);
        if (!(bucket in index)) newBuckets.delete(bPath);
      }
    }
    for (const [bucket, sha] of Object.entries(index)) {
      const bPath = bucketPath(kind, bucket);
      if (uploadedBuckets.get(bPath) === sha || cachedBuckets.get(bPath) === sha) {
        newBuckets.set(bPath, sha);
      }
    }
  }

  // ---- 提交点：library.json 最后写（读端只认它）----
  const revision = Math.max(lib.revision ?? 0, await device.getRevision()) + 1;
  const newLib: LibraryIndex = { manifestVersion: MANIFEST_VERSION, revision, collections: newColHashes };
  await remote.putText(LIBRARY_INDEX_PATH, JSON.stringify(newLib));

  await device.setManifestCache(newPaths);
  await device.setBucketShas(newBuckets);
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
  await device.flushPendingWrites?.(); // 批量缓冲的基线/块缓存写在此收尾落盘
  return { pull: pullReport, push: pushReport };
}
