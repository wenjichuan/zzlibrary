/** 前缀增长式流式伺服 e2e：大文件（阈值调小模拟）释放后 Range 请求 → 前缀落盘/增长/追满上位。
 * 覆盖：206 首段落 .zzpart；拖回前缀内零云端（删云验证）；跳前缘外纯代理不落盘；追满后哈希上位 local=1。 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Env } from "./env";

let cloudDir = "";
let dirA = "";
let app: Hono<Env> | null = null;
let cookie = "";

async function makeApp(dataDir: string) {
  process.env.ZZLIB_DATA_DIR = dataDir;
  process.env.ZZLIB_SMALL_FETCH = "1024"; // 测试阈值：>1KB 即走流式代理
  process.env.ZZLIB_GROW_TOL = "1024"; // 测试容差：>1KB 的前缘跳按纯代理
  const { Settings } = await import("./config");
  const { createApp } = await import("./http");
  return createApp(new Settings()) as unknown as Hono<Env>;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { cookie };
  let reqBody: FormData | string | undefined;
  if (body instanceof FormData) {
    reqBody = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await app!.request(path, { method, headers, body: reqBody });
  const ct = res.headers.get("content-type") ?? "";
  const json = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, json };
}

let fileId = 0;
let realPath = "";
let partPath = "";
const CONTENT = Buffer.alloc(50 * 1024);
for (let i = 0; i < CONTENT.length; i++) CONTENT[i] = (i * 7 + 13) & 0xff;

function findBlob(): string {
  const blobsRoot = join(cloudDir, "blobs");
  for (const d of readdirSync(blobsRoot)) {
    const sub = join(blobsRoot, d);
    for (const f of readdirSync(sub)) return join(sub, f);
  }
  throw new Error("云上找不到 blob");
}

beforeAll(async () => {
  cloudDir = mkdtempSync(join(tmpdir(), "zzlib-str-cloud-"));
  dirA = mkdtempSync(join(tmpdir(), "zzlib-str-dev-"));
  app = await makeApp(dirA);
  const loginRes = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "zzlibrary" }),
  });
  cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  for (const d of [cloudDir, dirA]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* Windows 句柄 */
    }
  }
});

describe("流式代理：前缀增长取回", () => {
  it("入库大文件 + 上云 + 释放", async () => {
    await call("PUT", "/api/sync/config", { provider: "fs", autoSync: false, fs: { root: cloudDir } });
    await call("POST", "/api/categories", { name: "媒体" });
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(CONTENT)]), "streaming-test.mp4");
    const st = await call("POST", "/api/packages/stage", form);
    expect(st.status).toBe(200);
    const commit = await call("POST", "/api/packages", {
      stage_ids: [st.json.stage_id],
      meta: { title: "流式测试包" },
    });
    expect(commit.status).toBe(201);
    fileId = commit.json.files[0].id;
    // file_path 不在 API 出参里——直接查库（测试专属）
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dirA, "library.db"), { readOnly: true });
    const row = db.prepare("SELECT file_path FROM files WHERE id = ?").get(fileId) as { file_path: string };
    realPath = join(dirA, ...row.file_path.split(/[\\/]/));
    partPath = `${realPath}.zzpart`;
    await call("POST", "/api/sync/now");
    const rel = await call("POST", `/api/sync/release/${commit.json.id}`);
    expect(rel.status).toBe(200);
    expect(rel.json.releasedFiles).toBe(1);
  });

  it("释放后 Range 首段 → 206 + 前缀落 .zzpart", async () => {
    const res = await app!.request(`/api/files/${fileId}/file`, {
      headers: { cookie, range: "bytes=0-4095" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-4095/${CONTENT.length}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(4096);
    expect(Buffer.from(buf).equals(CONTENT.subarray(0, 4096))).toBe(true);
    expect(existsSync(partPath)).toBe(true);
    expect(statSync(partPath).size).toBe(4096);
  });

  it("拖回前缀内 → 读盘即答（云端已删仍 206）", async () => {
    const blobFile = findBlob();
    unlinkSync(blobFile); // 云端副本删除——前缀内请求必须不碰云
    const res = await app!.request(`/api/files/${fileId}/file`, {
      headers: { cookie, range: "bytes=100-199" },
    });
    expect(res.status).toBe(206);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(buf).equals(CONTENT.subarray(100, 200))).toBe(true);
    writeFileSync(blobFile, CONTENT); // 恢复云端
  });

  it("越前缘大跳（>容差）→ 纯代理不落盘", async () => {
    const res = await app!.request(`/api/files/${fileId}/file`, {
      headers: { cookie, range: `bytes=${CONTENT.length - 256}-${CONTENT.length - 1}` },
    });
    expect(res.status).toBe(206);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(buf).equals(CONTENT.subarray(CONTENT.length - 256))).toBe(true);
    expect(statSync(partPath).size).toBe(4096); // 前缀未增长（纯代理）
  });

  it("接续前缘拉满 → 哈希上位 local=1（观看即取回）", async () => {
    const res = await app!.request(`/api/files/${fileId}/file`, {
      headers: { cookie, range: `bytes=4096-${CONTENT.length - 1}` },
    });
    expect(res.status).toBe(206);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(CONTENT.length - 4096);
    // 后台上位（setImmediate + 流式哈希）
    await new Promise((r) => setTimeout(r, 800));
    expect(existsSync(realPath)).toBe(true); // .zzpart 已改名上位
    expect(existsSync(partPath)).toBe(false);
    expect(readFileSync(realPath).length).toBe(CONTENT.length);
    // 上位后本地直读（云端再删也能全量 200）
    unlinkSync(findBlob());
    const full = await app!.request(`/api/files/${fileId}/file`, { headers: { cookie } });
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer()).length).toBe(CONTENT.length);
  });
});
