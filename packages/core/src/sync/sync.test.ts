/** 同步引擎单测：内存设备 × 内存云端，跑双端编辑矩阵。
 * 引擎职责在测：快照差分、两级索引维护、墓碑生成/传播、blob 先行、
 * 双端收敛一致性（A、B、云三方相等）。 */
import { describe, expect, it } from "vitest";
import {
  LIBRARY_INDEX_PATH,
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
  type Collection,
  type ManifestEnvelope,
  type PackageData,
  type ProgressData,
  type FileData,
} from "./contract";
import { decideApply, merge3, jsonEq, remoteProgressWins, type ApplyOutcome } from "./merge";
import { fullSync, pull, type LocalDevice, type LocalManifest } from "./engine";
import type { RemoteStore } from "../remote/store";

class MemoryRemote implements RemoteStore {
  files = new Map<string, Uint8Array | string>();
  async probe() {}
  async getText(path: string) {
    const v = this.files.get(path);
    return typeof v === "string" ? v : null;
  }
  async putText(path: string, text: string) {
    this.files.set(path, text);
  }
  async getBytes(path: string) {
    const v = this.files.get(path);
    return v instanceof Uint8Array ? v : null;
  }
  async putBytes(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
  }
  async head(path: string) {
    return this.files.has(path);
  }
}

/** 内存设备：实体以清单形态保存，合并判断复用 core 规则（与 server 的
 * SQLite 实现同一语义）。 */
class MemoryDevice implements LocalDevice {
  entities = new Map<string, ManifestEnvelope>();
  /** 墓碑记忆：path → 删除时刻（服务端实体的 deleted 标记等价物） */
  tombstones = new Map<string, string>();
  /** 上次同步基线：path → 云端当时内容（三方合并用） */
  baselines = new Map<string, ManifestEnvelope>();
  noteBaseline(path: string, env: ManifestEnvelope) {
    this.baselines.set(path, env);
  }
  blobs = new Map<string, Uint8Array>();
  manifestCache = new Map<string, string>();
  bucketShas = new Map<string, string>();
  colHashes: Partial<Record<Collection, string>> = {};
  blobCache = new Set<string>();
  revision = 0;
  clock = 1_700_000_000_000;
  constructor(public deviceId: string) {}

  /** 本地写：单调时间戳（设备内不回退）。 */
  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  put(env: ManifestEnvelope) {
    this.entities.set(manifestPath(env.kind, env.uuid), env);
  }
  /** 本地硬删除（行没了；墓碑由引擎在推送时生成）。 */
  hardDelete(kind: Collection, uuid: string) {
    const path = manifestPath(kind, uuid);
    this.entities.delete(path);
    this.tombstones.set(path, this.tick());
  }
  get(kind: Collection, uuid: string): ManifestEnvelope | undefined {
    return this.entities.get(manifestPath(kind, uuid));
  }

  async buildManifests(): Promise<Map<string, LocalManifest>> {
    const out = new Map<string, LocalManifest>();
    for (const [path, updatedAt] of this.tombstones) {
      if (this.entities.has(path)) continue;
      const parsed = parseManifestPath(path);
      if (!parsed) continue;
      const env = envelope(parsed.kind, parsed.uuid, updatedAt, {}, true);
      const text = manifestText(env);
      out.set(path, { env, text, sha: await sha256Hex(text), blobSha256s: [] });
    }
    for (const env of this.entities.values()) {
      const text = manifestText(env);
      out.set(manifestPath(env.kind, env.uuid), {
        env,
        text,
        sha: await sha256Hex(text),
        blobSha256s: blobsOf(env),
      });
    }
    return out;
  }
  async readBlob(hash: string) {
    return this.blobs.get(hash) ?? null;
  }
  async applyRemote(remote: ManifestEnvelope): Promise<ApplyOutcome> {
    const local = this.entities.get(manifestPath(remote.kind, remote.uuid));
    if (remote.kind === "progress") {
      const ppath = manifestPath(remote.kind, remote.uuid);
      if (remote.deleted) {
        if (!local) return "noop";
        if (decideApply({ updatedAt: local.updatedAt, uuid: local.uuid }, remote) === "tombstone-applied") {
          this.entities.delete(ppath);
          this.tombstones.set(ppath, remote.updatedAt);
          return "tombstone-applied";
        }
        return "local-newer";
      }
      if (!local || local.deleted) {
        this.put(remote);
        this.tombstones.delete(ppath);
        return "applied";
      }
      const wins = remoteProgressWins(
        { percent: (local.data as ProgressData).percent, updatedAt: local.updatedAt, uuid: local.uuid },
        { percent: (remote.data as ProgressData).percent, updatedAt: remote.updatedAt, uuid: remote.uuid },
      );
      if (wins) this.put(remote);
      return wins ? "applied" : "local-newer";
    }
    const outcome = decideApply(
      local && !local.deleted ? { updatedAt: local.updatedAt, uuid: local.uuid } : null,
      remote,
    );
    if (outcome === "local-newer" && local !== undefined && !local.deleted && !remote.deleted) {
      // 远端较旧但可能带本地没见过的第三方字段变更：吸收进本地（时间戳保持本地新值）。
      // 墓碑不做字段吸收——墓碑 data={} 是「无数据」不是「逐字段删除」（与服务端语义一致）。
      const path = manifestPath(remote.kind, remote.uuid);
      const baseline = this.baselines.get(path);
      if (baseline !== undefined && !baseline.deleted && !jsonEq(remote.data, baseline.data)) {
        const merged = merge3(
          baseline.data as Record<string, unknown>,
          local.data as Record<string, unknown>,
          remote.data as Record<string, unknown>,
          "local",
        );
        if (!jsonEq(merged, local.data)) {
          this.put(envelope(remote.kind, remote.uuid, local.updatedAt, merged));
          return "applied";
        }
      }
      return "local-newer";
    }
    if (outcome === "applied") {
      const path = manifestPath(remote.kind, remote.uuid);
      const baseline = this.baselines.get(path);
      if (baseline !== undefined && !baseline.deleted && local !== undefined && !local.deleted) {
        const merged = merge3(
          baseline.data as Record<string, unknown>,
          local.data as Record<string, unknown>,
          remote.data as Record<string, unknown>,
        );
        if (!jsonEq(merged, remote.data)) {
          // 双端并发改了同一实体的不同字段：合并态存本地（时间戳用远端）→ 下次推送传播
          this.put(envelope(remote.kind, remote.uuid, remote.updatedAt, merged));
          this.tombstones.delete(path);
          return "applied";
        }
      }
      this.put(remote);
      this.tombstones.delete(path);
    } else if (outcome === "tombstone-applied") {
      const path = manifestPath(remote.kind, remote.uuid);
      this.entities.delete(path);
      this.tombstones.set(path, remote.updatedAt);
    }
    return outcome;
  }
  async beginApply() {}
  async endApply() {}
  async getManifestCache() {
    return this.manifestCache;
  }
  async setManifestCache(entries: Map<string, string>) {
    this.manifestCache = entries;
  }
  async getBucketShas() {
    return this.bucketShas;
  }
  async setBucketShas(entries: Map<string, string>) {
    this.bucketShas = entries;
  }
  async getCollectionHashes() {
    return this.colHashes;
  }
  async setCollectionHashes(h: Partial<Record<Collection, string>>) {
    this.colHashes = h;
  }
  async getBlobCache() {
    return this.blobCache;
  }
  async addBlobCache(hash: string) {
    this.blobCache.add(hash);
  }
  async getRevision() {
    return this.revision;
  }
  async setRevision(rev: number) {
    this.revision = rev;
  }
}

function blobsOf(env: ManifestEnvelope): string[] {
  if (env.deleted) return [];
  if (env.kind === "files") return [(env.data as FileData).sha256];
  if (env.kind === "packages") {
    const cover = (env.data as PackageData).coverSha256;
    return cover !== null ? [cover] : [];
  }
  return [];
}

// ---------- 造数据 ----------

function seedDevice(dev: MemoryDevice) {
  const cat1 = envelope("categories", "a1".padEnd(32, "0"), dev.tick(), {
    level: 1, parentUuid: null, name: "历史", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z",
  });
  dev.put(cat1);
  const pkg = envelope("packages", "b1".padEnd(32, "0"), dev.tick(), {
    title: "原始包名",
    authors: ["张三"],
    publishDate: "-0221-01-01",
    publisher: null,
    tags: [],
    notes: null,
    coverSha256: null,
    palette: null,
    createdAt: "2026-01-02T00:00:00.000Z",
  } satisfies PackageData);
  dev.put(pkg);
  const file1 = envelope("files", "c1".padEnd(32, "0"), dev.tick(), {
    packageUuid: "b1".padEnd(32, "0"),
    name: "book.txt",
    format: "txt",
    sha256: "aa".padEnd(64, "a"),
    size: 11,
    pageCount: 1,
    sortOrder: 0,
  } satisfies FileData);
  dev.put(file1);
  dev.blobs.set("aa".padEnd(64, "a"), new TextEncoder().encode("hello world"));
  dev.put(envelope("package-paths", "d1".padEnd(32, "0"), dev.tick(), {
    packageUuid: "b1".padEnd(32, "0"),
    l1Uuid: "a1".padEnd(32, "0"),
    l2Uuid: null,
    l3Uuid: null,
  }));
  dev.put(envelope("progress", "c1".padEnd(32, "0"), dev.tick(), {
    locator: { offset: 5 }, percent: 40,
  } satisfies ProgressData));
}

function entityData(dev: MemoryDevice, kind: Collection, uuid: string): unknown {
  return dev.get(kind, uuid)?.data ?? null;
}

describe("同步引擎", () => {
  it("确定性序列化：同清单两次构造 → 同哈希", async () => {
    const a = envelope("packages", "x".padEnd(32, "0"), "2026-01-01T00:00:00.000Z", { title: "t" });
    const b = envelope("packages", "x".padEnd(32, "0"), "2026-01-01T00:00:00.000Z", { title: "t" });
    expect(await sha256Hex(manifestText(a))).toBe(await sha256Hex(manifestText(b)));
  });

  it("首次推送 → 新机只拉清单即恢复（blob 不下载）", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    const push1 = await fullSync(a, cloud);
    expect(push1.push.uploadedManifests).toBe(5);
    expect(push1.push.uploadedBlobs).toBe(1);
    expect(JSON.parse((cloud.files.get(LIBRARY_INDEX_PATH) as string)).revision).toBe(1);

    const b = new MemoryDevice("B");
    const restored = await fullSync(b, cloud);
    expect(restored.pull.applied).toBe(5);
    expect(b.get("packages", "b1".padEnd(32, "0"))?.data).toEqual(a.get("packages", "b1".padEnd(32, "0"))?.data);
    // 懒取回：B 没有任何 blob 字节，云端有
    expect(b.blobs.size).toBe(0);
    expect(cloud.files.has(blobPath("aa".padEnd(64, "a")))).toBe(true);
    // B 推送无变化（幂等，revision 不涨）
    expect(restored.push.uploadedManifests).toBe(0);
  });

  it("增量：改一处只传一份清单", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const pkg = a.get("packages", "b1".padEnd(32, "0"))!;
    a.put(envelope("packages", pkg.uuid, a.tick(), { ...(pkg.data as PackageData), title: "新名" }));
    const r = await fullSync(a, cloud);
    expect(r.push.uploadedManifests).toBe(1);
    expect(r.push.uploadedBlobs).toBe(0);
    expect(JSON.parse((cloud.files.get(LIBRARY_INDEX_PATH) as string)).revision).toBe(2);
  });

  it("双端并发编辑收敛：字段级 LWW + 整实体并集", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const b = new MemoryDevice("B");
    await fullSync(b, cloud);
    b.clock = a.clock + 500; // 设备墙钟不早于已见数据（且错开毫秒，避免同实体同秒并列）

    const t2 = a.tick();
    a.put(envelope("packages", "b1".padEnd(32, "0"), t2, {
      ...(a.get("packages", "b1".padEnd(32, "0"))!.data as PackageData),
      title: "A 改的名",
    }));
    const t3 = b.tick();
    b.put(envelope("packages", "b1".padEnd(32, "0"), t3, {
      ...(b.get("packages", "b1".padEnd(32, "0"))!.data as PackageData),
      notes: "B 加的备注",
    }));

    await fullSync(a, cloud);
    await fullSync(b, cloud); // B 拉 A 的 title，推自己的 notes
    await fullSync(a, cloud); // A 拉 B 的 notes

    const da = a.get("packages", "b1".padEnd(32, "0"))!.data as PackageData;
    const db = b.get("packages", "b1".padEnd(32, "0"))!.data as PackageData;
    expect(da.title).toBe("A 改的名");
    expect(da.notes).toBe("B 加的备注");
    expect(db).toEqual(da); // 收敛一致
  });

  it("双端各加文件 → 并集保留", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const b = new MemoryDevice("B");
    await fullSync(b, cloud);

    const fA = envelope("files", "ea".padEnd(32, "0"), a.tick(), {
      packageUuid: "b1".padEnd(32, "0"), name: "a.pdf", format: "pdf",
      sha256: "bb".padEnd(64, "b"), size: 2, pageCount: 1, sortOrder: 1,
    } satisfies FileData);
    a.put(fA);
    a.blobs.set("bb".padEnd(64, "b"), new Uint8Array([1, 2]));
    const fB = envelope("files", "eb".padEnd(32, "0"), b.tick(), {
      packageUuid: "b1".padEnd(32, "0"), name: "b.epub", format: "epub",
      sha256: "cc".padEnd(64, "c"), size: 3, pageCount: null, sortOrder: 2,
    } satisfies FileData);
    b.put(fB);
    b.blobs.set("cc".padEnd(64, "c"), new Uint8Array([3, 4, 5]));

    await fullSync(a, cloud);
    await fullSync(b, cloud);
    await fullSync(a, cloud);

    for (const dev of [a, b]) {
      expect(dev.get("files", "ea".padEnd(32, "0"))).toBeTruthy();
      expect(dev.get("files", "eb".padEnd(32, "0"))).toBeTruthy();
    }
    // 云端三个 blob 全在（文件字节内容寻址）
    expect(cloud.files.has(blobPath("aa".padEnd(64, "a")))).toBe(true);
    expect(cloud.files.has(blobPath("bb".padEnd(64, "b")))).toBe(true);
    expect(cloud.files.has(blobPath("cc".padEnd(64, "c")))).toBe(true);
  });

  it("进度合并：读得最远的赢，locator 跟随", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const b = new MemoryDevice("B");
    await fullSync(b, cloud);

    a.put(envelope("progress", "c1".padEnd(32, "0"), a.tick(), {
      locator: { offset: 4 }, percent: 40,
    } satisfies ProgressData));
    b.put(envelope("progress", "c1".padEnd(32, "0"), b.tick(), {
      locator: { offset: 9 }, percent: 90,
    } satisfies ProgressData));

    await fullSync(a, cloud);
    await fullSync(b, cloud);
    await fullSync(a, cloud);

    expect((a.get("progress", "c1".padEnd(32, "0"))!.data as ProgressData).percent).toBe(90);
    expect((a.get("progress", "c1".padEnd(32, "0"))!.data as ProgressData).locator).toEqual({ offset: 9 });
    expect(b.get("progress", "c1".padEnd(32, "0"))!.data).toEqual(a.get("progress", "c1".padEnd(32, "0"))!.data);
  });

  it("删除传播：墓碑写云 → 对端应用；对端不重复造墓碑", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const b = new MemoryDevice("B");
    await fullSync(b, cloud);

    a.hardDelete("files", "c1".padEnd(32, "0"));
    const r1 = await fullSync(a, cloud);
    expect(r1.push.tombstoned).toBe(1);
    // v2：墓碑在桶文件内
    const fileBucket = JSON.parse(
      cloud.files.get(bucketPath("files", bucketOf("c1".padEnd(32, "0")))) as string,
    ) as { entities: Record<string, ManifestEnvelope> };
    expect(fileBucket.entities["c1".padEnd(32, "0")]?.deleted).toBe(true);

    const r2 = await fullSync(b, cloud);
    expect(r2.pull.tombstones).toBe(1);
    expect(b.get("files", "c1".padEnd(32, "0"))).toBeUndefined();
    // B 的清单缓存已认领墓碑 → 再推不重复
    const r3 = await fullSync(b, cloud);
    expect(r3.push.uploadedManifests).toBe(0);
  });

  it("墓碑后本地又编辑 → 本地新者胜（复活）", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const b = new MemoryDevice("B");
    await fullSync(b, cloud);

    a.hardDelete("packages", "b1".padEnd(32, "0")); // A 删
    await fullSync(a, cloud);
    // B 在收到墓碑前又改了这个包（updatedAt 更新）
    b.put(envelope("packages", "b1".padEnd(32, "0"), "2999-01-01T00:00:00.000Z", {
      ...(b.get("packages", "b1".padEnd(32, "0"))!.data as PackageData),
      title: "复活后的名",
    }));
    await fullSync(b, cloud); // B 拉墓碑（本地新→保留），推复活清单
    expect(b.get("packages", "b1".padEnd(32, "0"))?.deleted ?? false).toBe(false);
    await fullSync(a, cloud); // A 拉复活清单 → 回来
    expect((a.get("packages", "b1".padEnd(32, "0"))!.data as PackageData).title).toBe("复活后的名");
  });

  it("进度重置：墓碑传播 → 对端进度消失", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const b = new MemoryDevice("B");
    await fullSync(b, cloud);

    a.hardDelete("progress", "c1".padEnd(32, "0"));
    await fullSync(a, cloud);
    const r = await fullSync(b, cloud);
    expect(r.pull.tombstones).toBe(1);
    expect(b.get("progress", "c1".padEnd(32, "0"))).toBeUndefined();
  });

  it("防误清空守卫：本地空 + 云端非空 → 拒绝推送", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const fresh = new MemoryDevice("C"); // 有缓存却空库的异常态模拟
    fresh.manifestCache = new Map(a.manifestCache);
    await expect(fullSync(fresh, cloud)).rejects.toThrow(/防误清空/);
  });

  it("pull 对空云端：cloudEmpty 且无副作用", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    const r = await pull(a, cloud);
    expect(r.cloudEmpty).toBe(true);
    expect(r.applied).toBe(0);
  });

  it("blob 缺失本地 → 所在桶整体跳过不悬空，其他桶照常", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    // 模拟：文件字节丢了但清单在（如释放后磁盘被清）
    a.blobs.delete("aa".padEnd(64, "a"));
    // 首推前 blobCache 为空 → head 云端无 → readBlob null → 跳过
    const r = await fullSync(a, cloud);
    expect(r.push.skippedNoBlob).toBe(1);
    // v2：桶是成员权威——文件实体缺块 → 整桶放弃（桶文件不出现，云端不会丢员）
    expect(cloud.files.has(bucketPath("files", bucketOf("c1".padEnd(32, "0"))))).toBe(false);
    // 但包/分类等其他桶照常上传
    const pkgBucket = JSON.parse(
      cloud.files.get(bucketPath("packages", bucketOf("b1".padEnd(32, "0")))) as string,
    ) as { entities: Record<string, ManifestEnvelope> };
    expect(pkgBucket.entities["b1".padEnd(32, "0")]).toBeTruthy();
  });

  it("双端先后推送 → 索引并集不丢条目", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const b = new MemoryDevice("B");
    await fullSync(b, cloud);

    // 各自加一个互不知晓的实体后先后推
    a.put(envelope("categories", "f1".padEnd(32, "0"), a.tick(), {
      level: 1, parentUuid: null, name: "A 的新分类", sortOrder: 1, createdAt: "2026-01-03T00:00:00.000Z",
    }));
    b.put(envelope("categories", "f2".padEnd(32, "0"), b.tick(), {
      level: 1, parentUuid: null, name: "B 的新分类", sortOrder: 2, createdAt: "2026-01-04T00:00:00.000Z",
    }));
    await fullSync(a, cloud);
    await fullSync(b, cloud);
    await fullSync(a, cloud);
    await fullSync(b, cloud);

    for (const dev of [a, b]) {
      expect(dev.get("categories", "f1".padEnd(32, "0"))).toBeTruthy();
      expect(dev.get("categories", "f2".padEnd(32, "0"))).toBeTruthy();
    }
    // v2：桶索引列出全部非空桶；桶内实体总数 = 双方实体总数（不丢）
    const idx = JSON.parse(cloud.files.get(collectionIndexPath("categories")) as string) as Record<string, string>;
    const total = Object.keys(idx).reduce(
      (n, b) =>
        n + Object.keys((JSON.parse(cloud.files.get(bucketPath("categories", b)) as string) as { entities: Record<string, unknown> }).entities).length,
      0,
    );
    expect(total).toBe(3);
  });

  // ---------- v2 分桶专项 ----------

  it("桶序列化：确定性 + 传入顺序无关（uuid 字典序）", async () => {
    const envs = [
      envelope("packages", "ff".padEnd(32, "f"), "2026-01-01T00:00:00.000Z", { title: "1" }),
      envelope("packages", "0f".padEnd(32, "f"), "2026-01-02T00:00:00.000Z", { title: "2" }),
    ];
    const t1 = bucketText("packages", "0007", envs);
    const t2 = bucketText("packages", "0007", [envs[1]!, envs[0]!]); // 乱序传入
    expect(t2).toBe(t1);
    expect(t1.indexOf('"0fff')).toBeLessThan(t1.indexOf('"ffff')); // 键有序
  });

  it("桶分布：连续 uuid 全桶覆盖均匀；非 hex 键确定性", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 10240; i++) {
      // 前 8 位 = 补零的 i → parseInt = i → i % 1024 轮转全覆盖（每桶恰 10 个）
      const uuid = i.toString(16).padStart(8, "0").padEnd(32, "0");
      const b = bucketOf(uuid);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    expect(counts.size).toBe(1024);
    for (const n of counts.values()) expect(n).toBe(10);
    expect(bucketOf("global")).toBe(bucketOf("global"));
    expect(Number(bucketOf("l2-abc"))).toBeLessThan(1024);
  });

  it("布局版本守卫：云端 v1 library.json → 拒绝同步", async () => {
    const cloud = new MemoryRemote();
    cloud.files.set(LIBRARY_INDEX_PATH, JSON.stringify({ manifestVersion: 1, revision: 3, collections: {} }));
    const a = new MemoryDevice("A");
    seedDevice(a);
    await expect(fullSync(a, cloud)).rejects.toThrow(/v1/);
  });

  it("v1→v2 迁移：云态缓存清空后按新布局全量重推，B 仍可恢复", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    // 模拟迁移：云端清单层清空（blobs 保留）+ 设备侧云态缓存清空（db 迁移 layout_v2 做的事）
    for (const k of [...cloud.files.keys()]) {
      if (k.startsWith("db/") || k === LIBRARY_INDEX_PATH) cloud.files.delete(k);
    }
    a.manifestCache = new Map();
    a.bucketShas = new Map();
    a.colHashes = {};
    const r = await fullSync(a, cloud);
    expect(r.push.uploadedManifests).toBe(5);
    const lib = JSON.parse(cloud.files.get(LIBRARY_INDEX_PATH) as string) as { manifestVersion: number };
    expect(lib.manifestVersion).toBe(2);
    expect(cloud.files.has(collectionIndexPath("packages"))).toBe(true);
    const b = new MemoryDevice("B");
    const rb = await fullSync(b, cloud);
    expect(rb.pull.applied).toBe(5);
  });

  it("丢失墓碑记忆 → 对照云端桶采纳既有墓碑（不重造、不重置时钟）", async () => {
    const cloud = new MemoryRemote();
    const a = new MemoryDevice("A");
    seedDevice(a);
    await fullSync(a, cloud);
    const b = new MemoryDevice("B");
    await fullSync(b, cloud);
    a.hardDelete("files", "c1".padEnd(32, "0"));
    await fullSync(a, cloud);
    await fullSync(b, cloud); // B 应用墓碑
    // B 丢失墓碑记忆（实体与记忆都没了，缓存仍认领）→ 兜底网走云端对照
    b.tombstones.delete(manifestPath("files", "c1".padEnd(32, "0")));
    const bPath = bucketPath("files", bucketOf("c1".padEnd(32, "0")));
    const before = cloud.files.get(bPath);
    const r = await fullSync(b, cloud);
    expect(r.push.uploadedManifests).toBe(0); // 云端已是墓碑 → 采纳 → 桶字节不变
    expect(cloud.files.get(bPath)).toBe(before);
  });
});
