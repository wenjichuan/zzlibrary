/** 同步端到端：双实例（两个独立数据目录=两台设备）共用一个云，
 * 走完整 API 链路验证 准备云端→新机恢复→编辑收敛→释放/透明取回→删除传播→WebDAV 传输。
 * 云协议用 fs（本地目录）+ WebDAV（自建迷你服务，真实 HTTP 全动词）。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { COLLECTIONS } from "@zzlibrary/core";
import type { Env } from "./env";

let cloudDir = "";
let dirA = "";
let dirB = "";
let appA: Hono<Env>;
let appB: Hono<Env>;
let cookieA = "";
let cookieB = "";
let webDavServer: { close: () => Promise<void>; url: string } | null = null;

async function makeApp(dataDir: string): Promise<Hono<Env>> {
  process.env.ZZLIB_DATA_DIR = dataDir;
  const { Settings } = await import("./config");
  const { createApp } = await import("./http");
  return createApp(new Settings());
}

async function call(app: Hono<Env>, cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { cookie };
  let reqBody: FormData | string | undefined;
  if (body instanceof FormData) {
    reqBody = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await app.request(path, { method, headers, body: reqBody });
  const sc = res.headers.get("set-cookie");
  if (sc) {
    if (app === appA) cookieA = sc.split(";")[0]!;
    else cookieB = sc.split(";")[0]!;
  }
  const ct = res.headers.get("content-type") ?? "";
  const json = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, json, headers: res.headers };
}

async function login(app: Hono<Env>): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "zzlibrary" }),
  });
  const sc = res.headers.get("set-cookie")!;
  return sc.split(";")[0]!;
}

/** 自建迷你 WebDAV 服务（PUT/GET/HEAD/DELETE/MKCOL——同步客户端所需的全部动词）。 */
async function startMiniWebDav(root: string) {
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const app = new Hono();
  const abs = (path: string) => join(root, decodeURIComponent(path.replace(/^\/+/, "")));
  app.on("MKCOL", "*", (c) => {
    mkdirSync(abs(c.req.path), { recursive: true });
    return c.body(null, 201);
  });
  app.on("PUT", "*", async (c) => {
    const target = abs(c.req.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await c.req.arrayBuffer()));
    return c.body(null, 201);
  });
  app.on("GET", "*", (c) => {
    const target = abs(c.req.path);
    if (!existsSync(target)) return c.body(null, 404);
    const buf = readFileSync(target);
    return c.body(new Uint8Array(buf).buffer as ArrayBuffer, 200);
  });
  app.on("HEAD", "*", (c) => (existsSync(abs(c.req.path)) ? c.body(null, 200) : c.body(null, 404)));
  app.on("DELETE", "*", (c) => {
    try {
      unlinkSync(abs(c.req.path));
    } catch {
      /* 404 也算成功 */
    }
    return c.body(null, 204);
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeAll(async () => {
  cloudDir = mkdtempSync(join(tmpdir(), "zzlib-cloud-"));
  dirA = mkdtempSync(join(tmpdir(), "zzlib-devA-"));
  dirB = mkdtempSync(join(tmpdir(), "zzlib-devB-"));
  appA = await makeApp(dirA);
  appB = await makeApp(dirB);
  cookieA = await login(appA);
  cookieB = await login(appB);
});

afterAll(async () => {
  await webDavServer?.close();
  for (const d of [cloudDir, dirA, dirB]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* Windows 句柄未释放 */
    }
  }
});

describe("同步：fs 云（本地目录）", () => {
  it("A 配置云 + 探测 + 入库两包（含进度）", async () => {
    const cfg = await call(appA, cookieA, "PUT", "/api/sync/config", {
      provider: "fs", autoSync: false, fs: { root: cloudDir },
    });
    expect(cfg.status).toBe(200);
    expect((await call(appA, cookieA, "POST", "/api/sync/test")).json.ok).toBe(true);

    await call(appA, cookieA, "POST", "/api/categories", { name: "历史" });
    const tree = (await call(appA, cookieA, "GET", "/api/categories")).json;
    const l1 = tree[0].id;
    await call(appA, cookieA, "POST", "/api/categories", { name: "古代文明", parent_id: l1 });

    const form = new FormData();
    form.append("file", new Blob(["同步测试内容 ABC\n".repeat(20)]), "sync-a.txt");
    const st = await call(appA, cookieA, "POST", "/api/packages/stage", form);
    const commit = await call(appA, cookieA, "POST", "/api/packages", {
      stage_ids: [st.json.stage_id],
      meta: { title: "同步包甲", classifications: [{ l1_id: l1 }], publish_date: "前221" },
    });
    expect(commit.status).toBe(201);
    await call(appA, cookieA, "PUT", `/api/progress/${commit.json.files[0].id}`, { locator: { offset: 12 }, percent: 40 });
  });

  it("A 立即同步（准备云端）：清单+blob 全上云", async () => {
    const r = await call(appA, cookieA, "POST", "/api/sync/now");
    expect(r.status).toBe(200);
    const rep = r.json.report;
    expect(rep.push.uploadedManifests).toBeGreaterThanOrEqual(5); // 分类2+包1+路径1+文件1+进度1
    expect(rep.push.uploadedBlobs).toBe(1);
    expect(existsSync(join(cloudDir, "library.json"))).toBe(true);
    expect(existsSync(join(cloudDir, "db", "packages"))).toBe(true);
    expect(existsSync(join(cloudDir, "blobs"))).toBe(true);
    // v2 分桶布局：桶索引 .idx.json + 桶文件；云对象数 ≤ 实体数 + 每集合一个 idx（小库=每桶 1~2 实体）
    const lib = JSON.parse(readFileSync(join(cloudDir, "library.json"), "utf-8")) as { manifestVersion: number };
    expect(lib.manifestVersion).toBe(2);
    expect(existsSync(join(cloudDir, "db", "packages.idx.json"))).toBe(true);
    const dbObjs = readdirSync(join(cloudDir, "db"), { recursive: true }).filter((p) => String(p).endsWith(".json")).length;
    expect(dbObjs).toBeLessThanOrEqual(rep.push.uploadedManifests + COLLECTIONS.length);
  });

  it("B 新机恢复：只拉清单即浏览；打开文件才取回字节", async () => {
    await call(appB, cookieB, "PUT", "/api/sync/config", { provider: "fs", autoSync: false, fs: { root: cloudDir } });
    const r = await call(appB, cookieB, "POST", "/api/sync/now");
    expect(r.json.report.pull.applied).toBeGreaterThanOrEqual(5);

    const list = await call(appB, cookieB, "GET", "/api/packages?q=同步包甲");
    expect(list.json.total).toBe(1);
    const pkg = list.json.items[0];
    expect(pkg.publish_date).toBe("-0221-01-01");
    expect(pkg.classifications[0].l1.name).toBe("历史");

    const detail = await call(appB, cookieB, "GET", `/api/packages/${pkg.id}`);
    expect(detail.json.files).toHaveLength(1);
    expect(detail.json.files[0].local).toBe(false); // 字节不在本地
    expect(detail.json.files[0].progress.percent).toBe(40); // 进度已同步

    // 透明取回：直接读文件 → 200 + 内容一致
    const fileRes = await appB.request(`/api/files/${detail.json.files[0].id}/file`, { headers: { cookie: cookieB } });
    expect(fileRes.status).toBe(200);
    const text = await fileRes.text();
    expect(text).toContain("同步测试内容 ABC");
    // 取回后 local=true
    const detail2 = await call(appB, cookieB, "GET", `/api/packages/${pkg.id}`);
    expect(detail2.json.files[0].local).toBe(true);
  });

  it("A 改名 → B 增量同步收敛", async () => {
    const listA = await call(appA, cookieA, "GET", "/api/packages?q=同步包甲");
    await call(appA, cookieA, "PATCH", `/api/packages/${listA.json.items[0].id}`, { title: "同步包甲·改名" });
    await call(appA, cookieA, "POST", "/api/sync/now");
    await call(appB, cookieB, "POST", "/api/sync/now");
    const listB = await call(appB, cookieB, "GET", "/api/packages?q=同步包甲");
    expect(listB.json.items[0].title).toBe("同步包甲·改名");
  });

  it("B 释放本地空间 → 条目还在 → 再读自动取回", async () => {
    const list = await call(appB, cookieB, "GET", "/api/packages?q=同步包甲");
    const pid = list.json.items[0].id;
    const rel = await call(appB, cookieB, "POST", `/api/sync/release/${pid}`);
    expect(rel.status).toBe(200);
    expect(rel.json.releasedFiles).toBe(1);
    const detail = await call(appB, cookieB, "GET", `/api/packages/${pid}`);
    expect(detail.json.files[0].local).toBe(false);
    expect((await call(appB, cookieB, "GET", "/api/packages")).json.total).toBeGreaterThanOrEqual(1); // 馆藏完好
    const fileRes = await appB.request(`/api/files/${detail.json.files[0].id}/file`, { headers: { cookie: cookieB } });
    expect(fileRes.status).toBe(200);
    expect((await fileRes.text())).toContain("同步测试内容 ABC");
  });

  it("A 删包（墓碑）→ B 同步后消失", async () => {
    const list = await call(appA, cookieA, "GET", "/api/packages?q=同步包甲");
    const pid = list.json.items[0].id;
    expect((await call(appA, cookieA, "DELETE", `/api/packages/${pid}`)).json.ok).toBe(true);
    await call(appA, cookieA, "POST", "/api/sync/now");
    const r = await call(appB, cookieB, "POST", "/api/sync/now");
    expect(r.json.report.pull.tombstones).toBeGreaterThanOrEqual(1);
    expect((await call(appB, cookieB, "GET", "/api/packages?q=同步包甲")).json.total).toBe(0);
    // 幂等：再同步无上传
    const again = await call(appB, cookieB, "POST", "/api/sync/now");
    expect(again.json.report.push.uploadedManifests).toBe(0);
  });

  it("释放守卫：字节未确认上云 → 422 拒绝；同步后 → 放行", async () => {
    // B 新入库一个包（已配置云但尚未同步 → 字节没上云）
    const form = new FormData();
    form.append("file", new Blob(["守卫测试内容\n".repeat(5)]), "guard.txt");
    const st = await call(appB, cookieB, "POST", "/api/packages/stage", form);
    const commit = await call(appB, cookieB, "POST", "/api/packages", {
      stage_ids: [st.json.stage_id],
      meta: { title: "释放守卫包", classifications: [{ l1_id: 1 }] },
    });
    const pid = commit.json.id;
    const before = await call(appB, cookieB, "GET", `/api/packages/${pid}`);
    expect(before.json.can_release).toBe(false);
    const denied = await call(appB, cookieB, "POST", `/api/sync/release/${pid}`);
    expect(denied.status).toBe(422);
    expect(denied.json.detail).toContain("尚未确认在云端");
    const stillLocal = await call(appB, cookieB, "GET", `/api/packages/${pid}`);
    expect(stillLocal.json.files[0].local).toBe(true);
    await call(appB, cookieB, "POST", "/api/sync/now");
    const afterSync = await call(appB, cookieB, "GET", `/api/packages/${pid}`);
    expect(afterSync.json.can_release).toBe(true);
    const rel = await call(appB, cookieB, "POST", `/api/sync/release/${pid}`);
    expect(rel.status).toBe(200);
    expect(rel.json.releasedFiles).toBe(1);
    await call(appB, cookieB, "DELETE", `/api/packages/${pid}`);
    await call(appB, cookieB, "POST", "/api/sync/now");
  });

  it("整理云端：删包记账 → GC 清掉云端字节与过期墓碑，且清理后不会回弹", async () => {
    const { createHash } = await import("node:crypto");
    const content = "GC 测试内容\n".repeat(10);
    const sha = createHash("sha256").update(Buffer.from(content)).digest("hex");
    // B 入库一个包并上云
    const form = new FormData();
    form.append("file", new Blob([content]), "gc.txt");
    const st = await call(appB, cookieB, "POST", "/api/packages/stage", form);
    const commit = await call(appB, cookieB, "POST", "/api/packages", {
      stage_ids: [st.json.stage_id],
      meta: { title: "GC 清理包", classifications: [{ l1_id: 1 }] },
    });
    const pid = commit.json.id;
    await call(appB, cookieB, "POST", "/api/sync/now");
    expect(existsSync(join(cloudDir, "blobs", sha.slice(0, 2), sha))).toBe(true);
    // 删除 → 同步（墓碑应携带内容块引用上云——云端即 GC 账本）
    await call(appB, cookieB, "DELETE", `/api/packages/${pid}`);
    await call(appB, cookieB, "POST", "/api/sync/now");
    {
      const { readdirSync: rd, readFileSync: rf } = await import("node:fs");
      const dir = join(cloudDir, "db", "files");
      // v2：桶文件直接在 db/files/ 下（db/files/<桶号>.json），聚合内含实体/墓碑
      let found = false;
      for (const f of rd(dir)) {
        const text = rf(join(dir, f), "utf-8");
        if (text.includes(sha.slice(0, 16))) found = true;
      }
      expect(found).toBe(true); // 文件墓碑 data.blobRefs 含该内容块
    }
    // GC（retention_days=0 → 墓碑全过期；refs 为空 → 记账 blob 全部判孤儿）
    const gc = await call(appB, cookieB, "POST", "/api/sync/gc", { retention_days: 0 });
    expect(gc.status).toBe(200);
    expect(gc.json.report.tombstonesRemoved).toBeGreaterThanOrEqual(3); // 包+文件+进度
    expect(gc.json.report.blobsRemoved).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(cloudDir, "blobs", sha.slice(0, 2), sha))).toBe(false);
    // 关键回归：GC 清掉的墓碑不会被下次同步推回（复活循环 bug 的对偶面）
    const again = await call(appB, cookieB, "POST", "/api/sync/now");
    expect(again.json.report.push.uploadedManifests).toBe(0);
    expect(existsSync(join(cloudDir, "blobs", sha.slice(0, 2), sha))).toBe(false);
    // 幂等：再 GC 无可清
    const gc2 = await call(appB, cookieB, "POST", "/api/sync/gc", { retention_days: 0 });
    expect(gc2.json.report.tombstonesRemoved).toBe(0);
    expect(gc2.json.report.blobsRemoved).toBe(0);
  });
});

describe("同步：WebDAV 云（迷你服务，真实 HTTP）", () => {
  it("A（WebDAV）入库 + 同步 → B（WebDAV）恢复 + 读取", async () => {
    webDavServer = await startMiniWebDav(mkdtempSync(join(tmpdir(), "zzlib-webdav-")));
    const cfg = {
      provider: "webdav", autoSync: false,
      webdav: { baseUrl: `${webDavServer.url}/dav`, username: "u", password: "p", rootPath: "zzlib" },
    } as const;
    expect((await call(appA, cookieA, "PUT", "/api/sync/config", cfg)).status).toBe(200);
    expect((await call(appA, cookieA, "POST", "/api/sync/test")).json.ok).toBe(true);

    const form = new FormData();
    form.append("file", new Blob(["webdav 传输内容\n".repeat(10)]), "wd.txt");
    const st = await call(appA, cookieA, "POST", "/api/packages/stage", form);
    const commit = await call(appA, cookieA, "POST", "/api/packages", {
      stage_ids: [st.json.stage_id],
      meta: { title: "WebDAV 包", classifications: [{ l1_id: 1 }] },
    });
    expect(commit.status).toBe(201);
    const syncA = await call(appA, cookieA, "POST", "/api/sync/now");
    expect(syncA.json.report.push.uploadedManifests).toBeGreaterThanOrEqual(3);
    expect(syncA.json.report.push.uploadedBlobs).toBe(1);

    await call(appB, cookieB, "PUT", "/api/sync/config", cfg);
    const syncB = await call(appB, cookieB, "POST", "/api/sync/now");
    expect(syncB.json.report.pull.applied).toBeGreaterThanOrEqual(3);
    const list = await call(appB, cookieB, "GET", "/api/packages?q=WebDAV");
    expect(list.json.total).toBe(1);
    const detail = await call(appB, cookieB, "GET", `/api/packages/${list.json.items[0].id}`);
    const fileRes = await appB.request(`/api/files/${detail.json.files[0].id}/file`, { headers: { cookie: cookieB } });
    expect(await fileRes.text()).toContain("webdav 传输内容");
  });
});
