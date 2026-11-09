/** server 端到端测试：临时库上跑认证/入库两步/编辑/进度/分段/删除全链。
 * 通过 app.request() 直连 Hono 应用（无需起端口）。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Env } from "./env";

let app: Hono<Env>;
let cookie = "";
let dataDir = "";

interface Res {
  status: number;
  json: any;
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  let reqBody: FormData | string | undefined;
  if (body instanceof FormData) {
    reqBody = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await app.request(path, { method, headers, body: reqBody });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0]!;
  const ct = res.headers.get("content-type") ?? "";
  const json = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, json, headers: res.headers };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "zzlib-server-test-"));
  process.env.ZZLIB_DATA_DIR = dataDir;
  // Settings 在构造时读 env，因此先设环境再动态加载
  const { Settings } = await import("./config");
  const { createApp } = await import("./http");
  app = createApp(new Settings());
});

afterAll(() => {
  // Windows：DB 句柄未关时 WAL 文件会挡住删除——尽力清理即可（tmpdir 里的测试残留）
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* 句柄未释放，留给系统临时目录清理 */
  }
});

describe("认证", () => {
  it("未登录 401 + detail 格式", async () => {
    const saved = cookie;
    cookie = "";
    const r = await call("GET", "/api/categories");
    expect(r.status).toBe(401);
    expect(r.json.detail).toBe("未登录或会话已过期");
    cookie = saved;
  });

  it("错误密码 401", async () => {
    const r = await call("POST", "/api/auth/login", { username: "admin", password: "wrong" });
    expect(r.status).toBe(401);
    expect(r.json.detail).toBe("用户名或密码错误");
  });

  it("Accept-Language: en → 英文消息（缺省 zh）", async () => {
    const en = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-US,en;q=0.9" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(en.status).toBe(401);
    expect(await en.json()).toMatchObject({ detail: "Wrong username or password" });
    // 键式深层抛出（repo 的 err.pkgNotFound）也按请求语言翻译
    const cookie0 = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "zzlibrary" }),
    });
    const sc = cookie0.headers.get("set-cookie")!.split(";")[0];
    const nf = await app.request("/api/packages/999999", { headers: { cookie: sc, "accept-language": "en" } });
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ detail: "Package not found" });
    const nfZh = await app.request("/api/packages/999999", { headers: { cookie: sc } });
    expect(((await nfZh.json()) as { detail: string }).detail).toBe("资料包不存在");
  });

  it("登录成功并建立会话", async () => {
    const r = await call("POST", "/api/auth/login", { username: "admin", password: "zzlibrary" });
    expect(r.status).toBe(200);
    expect(r.json.username).toBe("admin");
    expect(await call("GET", "/api/auth/me")).toMatchObject({ status: 200 });
  });
});

describe("分类", () => {
  it("建三级分类树", async () => {
    const l1 = await call("POST", "/api/categories", { name: "历史" });
    expect(l1.status).toBe(201);
    expect(l1.json.level).toBe(1);
    const l2 = await call("POST", "/api/categories", { name: "古代文明", parent_id: l1.json.id });
    expect(l2.json.level).toBe(2);
    const l3 = await call("POST", "/api/categories", { name: "中国", parent_id: l2.json.id });
    expect(l3.json.level).toBe(3);
    const tree = await call("GET", "/api/categories");
    expect(tree.json[0].children[0].children[0].name).toBe("中国");
  });

  it("层级超限 422", async () => {
    const tree = await call("GET", "/api/categories");
    const l3 = tree.json[0].children[0].children[0];
    const r = await call("POST", "/api/categories", { name: "四级", parent_id: l3.id });
    expect(r.status).toBe(422);
  });
});

describe("入库两步", () => {
  let sid1: string;
  let sid2: string;

  it("stage txt：首行标题 + 页数估算", async () => {
    const form = new FormData();
    form.append("file", new Blob(["测试资料包首行标题\n第二行\n".repeat(3)]), "cp0_test.txt");
    const r = await call("POST", "/api/packages/stage", form);
    expect(r.status).toBe(200);
    expect(r.json.format).toBe("txt");
    expect(r.json.meta.title).toBe("测试资料包首行标题");
    expect(r.json.meta.page_count).toBe(1);
    sid1 = r.json.stage_id;
  });

  it("stage md：# 标题抽取", async () => {
    const form = new FormData();
    form.append("file", new Blob(["# 马克笔记标题\n正文"]), "note.md");
    const r = await call("POST", "/api/packages/stage", form);
    expect(r.json.meta.title).toBe("马克笔记标题");
    sid2 = r.json.stage_id;
  });

  it("stage 未知扩展名原样登记", async () => {
    const form = new FormData();
    form.append("file", new Blob(["xx"]), "data.unknownx");
    const r = await call("POST", "/api/packages/stage", form);
    expect(r.json.format).toBe("unknownx");
  });

  it("commit：公元前 + 清洗 + 多文件 + 分类路径", async () => {
    const tree = await call("GET", "/api/categories");
    const l1 = tree.json[0];
    const l2 = l1.children[0];
    const r = await call("POST", "/api/packages", {
      stage_ids: [sid1, sid2],
      meta: {
        title: "CP0 测试包",
        authors: ["张三 ", ""],
        classifications: [{ l1_id: l1.id, l2_id: l2.id }],
        publish_date: "前221",
        tags: ["测试 ", ""],
      },
    });
    expect(r.status).toBe(201);
    expect(r.json.publish_date).toBe("-0221-01-01");
    expect(r.json.authors).toEqual(["张三"]);
    expect(r.json.tags).toEqual(["测试"]);
    expect(r.json.classifications[0].l2.name).toBe("古代文明");
    expect(r.json.file_count).toBe(2);
    expect(r.json.status).toBe("unread");
  });

  it("无公元 0 年 → 422", async () => {
    const form = new FormData();
    form.append("file", new Blob(["x"]), "d.txt");
    const st = await call("POST", "/api/packages/stage", form);
    const r = await call("POST", "/api/packages", {
      stage_ids: [st.json.stage_id],
      meta: { title: "x", classifications: [{ l1_id: 1 }], publish_date: "0" },
    });
    expect(r.status).toBe(422);
    expect(r.json.detail).toContain("公元 0 年");
  });
});

describe("列表与书架", () => {
  it("列表筛选与排序", async () => {
    const r = await call("GET", "/api/packages?page_size=50");
    expect(r.json.total).toBeGreaterThanOrEqual(1);
    expect(r.json.items[0].title).toBeTruthy();
  });

  it("书架概览计数 + 进架包体（overview/rack 两级载荷）", async () => {
    const tree = await call("GET", "/api/categories");
    const l1 = tree.json[0];
    // 概览：轻计数（零包体），含真实段带网格
    const ov = await call("GET", `/api/shelves/${l1.id}/overview`);
    expect(ov.json.total).toBeGreaterThanOrEqual(1);
    expect(ov.json.groups[0].shelves[0].segments).toBeDefined();
    // 进架：拉该二级组的包体
    const group = ov.json.groups.find((g: any) => g.l2 !== null) ?? ov.json.groups[0];
    const l2Key = group.l2 === null ? "none" : String(group.l2.id);
    const rack = await call("GET", `/api/shelves/${l1.id}/rack?l2=${l2Key}`);
    expect(rack.json.total).toBeGreaterThanOrEqual(1);
    const shelf = rack.json.groups[0].shelves.find((s: any) => s.l3?.name === "中国") ?? rack.json.groups[0].shelves[0];
    expect(shelf.total).toBeGreaterThanOrEqual(1);
    expect((shelf.packages ?? []).some((p: any) => p.package.publish_date === "-0221-01-01")).toBe(true);
  });
});

describe("进度与状态机", () => {
  it("写进度 → 包状态重算", async () => {
    const list = await call("GET", "/api/packages?page_size=1");
    const pid = list.json.items[0].id;
    const detail = await call("GET", `/api/packages/${pid}`);
    const fid = detail.json.files[0].id;
    await call("PUT", `/api/progress/${fid}`, { locator: { offset: 10 }, percent: 40 });
    expect((await call("GET", `/api/packages/${pid}`)).json.status).toBe("reading");
    await call("PUT", `/api/progress/${fid}`, { locator: { offset: 20 }, percent: 100 });
    // 另一文件未读 → 包整体回 unread（一已读+一未读 = 未读）
    expect((await call("GET", `/api/packages/${pid}`)).json.status).toBe("unread");
  });
});

describe("分段配置", () => {
  it("custom 区间 + 别名 → 书架段带", async () => {
    const r = await call("PUT", "/api/segment-config", {
      mode: "custom",
      params: { ranges: [{ start: "581", end: "907", alias: "隋唐" }] },
    });
    expect(r.json.mode).toBe("custom");
    const tree = await call("GET", "/api/categories");
    const l1 = tree.json[0];
    // 概览轻载荷即含段带网格（SQL 日期范围 + computeGrid）
    const ov = await call("GET", `/api/shelves/${l1.id}/overview`);
    const segs = ov.json.groups[0].shelves[0].segments;
    expect(segs.some((s: any) => s.alias === "隋唐" && s.label === "581–907")).toBe(true);
    expect(segs.some((s: any) => s.key === "other")).toBe(true);
    await call("PUT", "/api/segment-config", { mode: "year", params: {} });
  });
});

describe("资产与文件流", () => {
  it("封面/书脊/文件流（含 Range）", async () => {
    const list = await call("GET", "/api/packages?page_size=1");
    const pid = list.json.items[0].id;
    expect((await call("GET", `/api/packages/${pid}/cover`)).status).toBe(200);
    expect((await call("GET", `/api/packages/${pid}/spine`)).status).toBe(200);
    const detail = await call("GET", `/api/packages/${pid}`);
    const fid = detail.json.files[0].id;
    const full = await call("GET", `/api/files/${fid}/file`);
    expect(full.status).toBe(200);
    // Range：取前 10 字节（fetch 层组装 Range 头走 app.request）
    const res = await app.request(`/api/files/${fid}/file`, {
      headers: { cookie, range: "bytes=0-9" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-9\//);
  });
});

describe("删除清理", () => {
  it("删包 → 404", async () => {
    const list = await call("GET", "/api/packages?page_size=1");
    const pid = list.json.items[0].id;
    expect((await call("DELETE", `/api/packages/${pid}`)).json.ok).toBe(true);
    expect((await call("GET", `/api/packages/${pid}`)).status).toBe(404);
  });
});

describe("流式入库", () => {
  it("5MB 随机文件 stage→commit，哈希/字节一致，cover 字段可用", async () => {
    const { createHash } = await import("node:crypto");
    const size = 5 * 1024 * 1024;
    const content = Buffer.alloc(size);
    for (let i = 0; i < size; i++) content[i] = (i * 13 + 5) & 0xff;
    const sha = createHash("sha256").update(content).digest("hex");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(content)]), "big-stream.bin");
    // 真 1×1 PNG（sharp 才认；cover 字段会进封面归一管线）
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    form.append("cover", new Blob([new Uint8Array(png)]), "cover.png");
    const st = await call("POST", "/api/packages/stage", form);
    expect(st.status).toBe(200);
    expect(st.json.size).toBe(size);
    expect(st.json.has_cover).toBe(true);
    const commit = await call("POST", "/api/packages", {
      stage_ids: [st.json.stage_id],
      meta: { title: "流式入库测试" },
    });
    expect(commit.status).toBe(201);
    expect(commit.json.files[0].has_cover).toBe(true);
    // sha256 不在 API 出参——直查库（stage 流式增量哈希 → commit 零重读登记）
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dataDir, "library.db"), { readOnly: true });
    const row = db.prepare("SELECT sha256, local FROM files WHERE id = ?").get(commit.json.files[0].id) as { sha256: string; local: number };
    db.close();
    expect(row.sha256).toBe(sha);
    expect(row.local).toBe(1);
    // 取回字节逐一致（流式写盘无损坏）
    const res = await app.request(`/api/files/${commit.json.files[0].id}/file`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(content)).toBe(true);
  });
});

describe("本机备份", () => {
  let backupDir = "";

  it("备份整库 → 快照完整性 + files/art 拷贝 + 字节一致", async () => {
    backupDir = mkdtempSync(join(tmpdir(), "zzlib-backup-"));
    const r = await call("POST", "/api/backup/run", { dest: backupDir });
    expect(r.status).toBe(200);
    expect(r.json.files).toBeGreaterThanOrEqual(1);
    expect(r.json.bytes).toBeGreaterThan(0);
    // 快照完整性 + 行数与 API 一致
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(backupDir, "library.db"), { readOnly: true });
    const ic = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(ic.integrity_check).toBe("ok");
    const n = db.prepare("SELECT COUNT(*) AS n FROM packages").get() as { n: number };
    db.close();
    const list = await call("GET", "/api/packages?page_size=1");
    expect(n.n).toBe(list.json.total);
    // files 拷贝存在（入库用例已落盘文件）
    const filesCopied = readdirSync(join(backupDir, "files"), { recursive: true });
    expect(filesCopied.length).toBeGreaterThan(0);
  });

  it("重复备份同一目录 → 覆盖旧快照成功", async () => {
    const r = await call("POST", "/api/backup/run", { dest: backupDir });
    expect(r.status).toBe(200);
  });

  it("目标在数据目录内部 → 422 防套娃", async () => {
    const r = await call("POST", "/api/backup/run", { dest: dataDir });
    expect(r.status).toBe(422);
  });

  afterAll(() => {
    if (backupDir) {
      try {
        rmSync(backupDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* Windows 句柄未释放 */
      }
    }
  });
});
