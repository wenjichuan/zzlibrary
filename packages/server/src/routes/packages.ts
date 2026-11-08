/** 资料包：暂存入库（stage→commit）、列表检索、详情/编辑/删除、
 * 包内文件管理、封面/书脊/文件流服务。 */
import { createReadStream, createWriteStream } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { detectFormat, displayDate, mediaTypeOf, parsePartialDate, sanitizeName, stemTitle } from "@zzlibrary/core";
import type { Env } from "../env";
import { resolvePaths } from "../deps";
import { streamMultipart } from "../multipart";
import {
  getPackageFull,
  getPackageOr404,
  loadFiles,
  loadManyFull,
  packageOut,
  progressOut,
  getProgress,
  recomputePackageStatus,
  syncCounts,
  type FileRow,
  type PackageFull,
  type PackageRow,
} from "../repo";
import { inTransaction, nowSqlite, pstmt } from "../db";
import { sha256FileSync, sha256Sync } from "../hashing";
import { extractMeta } from "../extract";
import { makePlaceholderCover, normalizeCover, paletteFromCover, regeneratePackageArt } from "../art";

export const packagesRouter = new Hono<Env>();

/** 包目录名：{入库日期}_{包id}_{包名快照}——资源管理器离库可读；id 保证唯一。 */
function packageDirName(pkgId: number, title: string, createdAt: string): string {
  const datePart = createdAt ? createdAt.slice(0, 10) : "unknown";
  return `${datePart}_${pkgId}_${sanitizeName(title, 40, "file")}`;
}

function packageDir(settings: Env["Variables"]["settings"], pkg: PackageFull): string {
  const dirPath = join(settings.filesDir, packageDirName(pkg.row.id, pkg.row.title, pkg.row.created_at));
  if (!existsSync(dirPath) && pkg.files.length > 0) {
    // 快照名与库内路径不一致（历史目录/改名前入库）→ 以库内记录为准
    const recorded = join(settings.dataDir, pkg.files[0]!.file_path);
    const recordedDir = recorded.slice(0, recorded.lastIndexOf("\\") >= 0 ? recorded.lastIndexOf("\\") : recorded.lastIndexOf("/"));
    if (existsSync(recordedDir)) return recordedDir;
  }
  return dirPath;
}

function fileCoverPath(settings: Env["Variables"]["settings"], f: FileRow): string {
  return join(settings.artDir, "filecovers", `${f.id}.png`);
}

function packageDetail(
  settings: Env["Variables"]["settings"],
  db: Env["Variables"]["db"],
  pkg: PackageFull,
) {
  const base = packageOut(db, pkg, new Map());
  // 封面存在性探测：一次 readdir 代替每文件 existsSync
  const coverNames = new Set(safeReaddir(join(settings.artDir, "filecovers")));
  return {
    ...base,
    has_real_cover: pkg.row.cover_sha256 !== null,
    files: pkg.files.map((f) => ({
      id: f.id,
      name: f.name,
      format: f.format,
      file_size: f.file_size,
      page_count: f.page_count,
      sort_order: f.sort_order,
      has_cover: coverNames.has(`${f.id}.png`),
      progress: progressOut(getProgress(db, f.id)),
    })),
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------- 入库两步：stage -> commit ----------

interface StageResult {
  stageId: string;
  filename: string;
  size: number;
  format: string;
  meta: ReturnType<typeof extractMeta>;
  hasCover: boolean;
}

/** 元数据抽取的文件大小上限：超过则跳过抽取（文件名兜底）——
 * GB 级视频/压缩包本就无元数据可抽，避免「巨型 epub」把整文件读回内存。 */
const EXTRACT_LIMIT = 16 * 1024 * 1024;

/** stage 后置段：文件已流式落盘（含增量 sha256）——抽取元数据、写封面与 meta.json。 */
function finishStage(
  settings: Env["Variables"]["settings"],
  stagingDir: string,
  target: string,
  stageId: string,
  filename: string,
  size: number,
  sha256: string,
  coverBytes: Uint8Array | undefined,
): StageResult {
  const fmt = detectFormat(filename); // 不限格式：未知扩展名原样登记
  const meta =
    size <= EXTRACT_LIMIT
      ? extractMeta(target, readFileSync(target), filename, fmt) // 小文件读回一次供抽取（封面/页数/标题）
      : { title: null, authors: [] as string[], publish_date: null, publisher: null, page_count: null, cover: null };
  const hasCover = meta.cover !== null || coverBytes !== undefined;
  if (meta.cover !== null) {
    writeFileSync(join(stagingDir, "cover.png"), meta.cover);
  } else if (coverBytes !== undefined) {
    // 客户端渲染的封面（PDF 首页）——服务端零原生依赖的全端通用方案
    writeFileSync(join(stagingDir, "cover.png"), coverBytes);
  }
  writeFileSync(
    join(stagingDir, "meta.json"),
    JSON.stringify({
      filename: sanitizeName(filename, 120, "file"),
      format: fmt,
      size,
      page_count: meta.page_count,
      sha256, // stage 流式写盘时已增量算好——commit 免第三次整读
    }),
  );
  return { stageId, filename, size, format: fmt, meta, hasCover };
}

packagesRouter.post("/api/packages/stage", async (c) => {
  const settings = c.get("settings");
  const contentType = c.req.header("content-type") ?? "";
  const rawBody = c.req.raw.body;
  if (rawBody === null || !contentType.includes("multipart/form-data")) {
    throw new HTTPException(422, { message: "缺少上传内容（multipart）" });
  }
  // 流式接收：file 字段直接写盘 + 增量哈希（GB 级文件不整读进内存）；
  // cover（客户端渲染的 PDF 首页，小）与其他小字段缓冲（封顶防滥用）。
  const stageId = randomUUID().replaceAll("-", "");
  const stagingDir = join(settings.stagingDir, stageId);
  mkdirSync(stagingDir, { recursive: true });
  const target = join(stagingDir, "file");
  const hash = createHash("sha256");
  let filename: string | null = null;
  let size = 0;
  let coverBytes: Uint8Array | undefined;
  let ws: WriteStream | null = null;
  let field: { name: string; chunks: Buffer[]; len: number } | null = null;

  await streamMultipart(rawBody, contentType, {
    async onPartHeader({ name, filename: fn }) {
      if (name === "file" && fn !== undefined && fn !== "") {
        filename = fn;
        ws = createWriteStream(target);
        return;
      }
      field = { name, chunks: [], len: 0 };
    },
    async onChunk(bytes) {
      if (ws !== null) {
        hash.update(bytes);
        size += bytes.length;
        if (!ws.write(bytes)) {
          await new Promise<void>((resolve, reject) => {
            ws!.once("drain", resolve);
            ws!.once("error", reject);
          });
        }
        return;
      }
      if (field !== null && field.len < 16 * 1024 * 1024) {
        field.chunks.push(Buffer.from(bytes));
        field.len += bytes.length;
      }
    },
    async onPartEnd() {
      if (ws !== null) {
        const w = ws;
        ws = null;
        await new Promise<void>((resolve, reject) => {
          w.once("error", reject);
          w.end(resolve);
        });
        return;
      }
      if (field !== null) {
        if (field.name === "cover") coverBytes = new Uint8Array(Buffer.concat(field.chunks));
        field = null;
      }
    },
  });

  if (filename === null) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new HTTPException(422, { message: "缺少文件名" });
  }
  const result = finishStage(settings, stagingDir, target, stageId, filename, size, hash.digest("hex"), coverBytes);
  return c.json({
    stage_id: result.stageId,
    filename: result.filename,
    size: result.size,
    format: result.format,
    meta: {
      title: result.meta.title ?? stemTitle(result.filename),
      authors: result.meta.authors,
      publish_date: displayDate(result.meta.publish_date),
      publisher: result.meta.publisher,
      page_count: result.meta.page_count,
    },
    has_cover: result.hasCover,
  });
});

packagesRouter.post("/api/packages/stage/discard", async (c) => {
  const settings = c.get("settings");
  const payload = await c.req.json<{ stage_ids?: string[] }>().catch(() => ({}) as never);
  let removed = 0;
  for (const sid of payload.stage_ids ?? []) {
    if (!/^[0-9a-f]{32}$/.test(sid)) continue; // 非法 id 静默跳过（防路径注入）
    const d = join(settings.stagingDir, sid);
    if (existsSync(d)) {
      rmSync(d, { recursive: true, force: true });
      removed += 1;
    }
  }
  return c.json({ ok: true, removed });
});

packagesRouter.get("/api/packages/stage/:stageId/cover", (c) => {
  const settings = c.get("settings");
  const path = join(settings.stagingDir, c.req.param("stageId"), "cover.png");
  if (!existsSync(path)) throw new HTTPException(404, { message: "该文件没有可预览的封面" });
  return serveFile(c, path, "image/png");
});

interface CommitPayload {
  stage_ids?: string[];
  meta?: {
    title?: string;
    authors?: string[];
    classifications?: Array<{ l1_id?: number | null; l2_id?: number | null; l3_id?: number | null }>;
    publish_date?: string | null;
    publisher?: string | null;
    tags?: string[];
    notes?: string | null;
  };
}

packagesRouter.post("/api/packages", async (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const payload = await c.req.json<CommitPayload>().catch(() => ({}) as never);
  const stageIds = payload.stage_ids ?? [];
  if (stageIds.length === 0) throw new HTTPException(422, { message: "stage_ids 不能为空" });
  const meta = payload.meta ?? {};
  const title = (meta.title ?? "").trim();
  if (!title || title.length > 500) throw new HTTPException(422, { message: "包名长度需在 1~500" });

  interface StagedInfo {
    dir: string;
    info: { filename: string; format: string; size: number; page_count: number | null; sha256?: string };
  }
  const staged: StagedInfo[] = [];
  for (const stageId of stageIds) {
    const stagingDir = join(settings.stagingDir, stageId);
    if (!existsSync(join(stagingDir, "file"))) {
      throw new HTTPException(404, { message: `暂存文件已过期（${stageId.slice(0, 8)}…），请重新上传` });
    }
    staged.push({
      dir: stagingDir,
      info: JSON.parse(readFileSync(join(stagingDir, "meta.json"), "utf-8")),
    });
  }

  const resolvedPaths = resolvePaths(db, meta.classifications);
  const publishDate = parseDateField(meta.publish_date);

  const { pkgId, packageCover } = inTransaction(db, () => {
    const ins = db
      .prepare(
        "INSERT INTO packages (title, authors, publish_date, publisher, tags, notes, status, file_count, total_size, created_at, updated_at, uuid) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)",
      )
      .run(
        title,
        JSON.stringify(cleanList(meta.authors)),
        publishDate,
        (meta.publisher ?? "").trim() || null,
        JSON.stringify(cleanList(meta.tags)),
        meta.notes ?? null,
        "未读",
        nowSqlite(),
        nowSqlite(),
        randomUUID().replaceAll("-", ""),
      );
    const pkgId = Number(ins.lastInsertRowid);
    const insertPath = db.prepare(
      "INSERT INTO package_paths (package_id, l1_id, l2_id, l3_id, updated_at, uuid) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const [l1, l2, l3] of resolvedPaths) {
      insertPath.run(pkgId, l1, l2, l3, nowSqlite(), randomUUID().replaceAll("-", ""));
    }

    let packageCover: Buffer | null = null;
    const pkg = getPackageFull(db, pkgId)!;
    const pkgDir = packageDir(settings, pkg);
    mkdirSync(pkgDir, { recursive: true });
    let order = 0;
    for (const { dir, info } of staged) {
      // sha 优先用 stage 流式写盘时算好的；旧暂存（升级前遗留）兜底流式哈希——均不整读进内存
      const sha = info.sha256 ?? sha256FileSync(join(dir, "file"));
      const f = db
        .prepare(
          "INSERT INTO files (package_id, name, format, file_path, file_size, page_count, sort_order, sha256, local, updated_at, uuid) VALUES (?, ?, ?, '', ?, ?, ?, ?, 1, ?, ?)",
        )
        .run(pkgId, info.filename, info.format, info.size, info.page_count ?? null, order, sha, nowSqlite(), randomUUID().replaceAll("-", ""));
      const fileId = Number(f.lastInsertRowid);
      const dest = join(pkgDir, `${fileId}_${info.filename}`);
      renameSync(join(dir, "file"), dest);
      db.prepare("UPDATE files SET file_path = ? WHERE id = ?").run(
        join("files", ...dest.slice(settings.filesDir.length + 1).split(/[\\/]/)), fileId,
      );
      const coverSrc = join(dir, "cover.png");
      if (existsSync(coverSrc)) {
        const coverImg = readFileSync(coverSrc);
        mkdirSync(join(settings.artDir, "filecovers"), { recursive: true });
        writeFileSync(join(settings.artDir, "filecovers", `${fileId}.png`), coverImg);
        if (packageCover === null) packageCover = coverImg;
      }
      order += 1;
    }

    syncCounts(db, pkgId);
    recomputePackageStatus(db, pkgId); // 入库即对齐：纯不可读格式包为中性 ""
    return { pkgId, packageCover };
  });
  await regeneratePackageArt(settings.artDir, pkgId, title, packageCover);
  const palette = await paletteFromCover(packageCover, title);
  db.prepare("UPDATE packages SET palette = ?, cover_sha256 = ? WHERE id = ?").run(
    JSON.stringify(palette),
    packageCover === null ? null : sha256Sync(new Uint8Array(packageCover)),
    pkgId,
  );
  for (const { dir } of staged) rmSync(dir, { recursive: true, force: true });
  return c.json(packageDetail(settings, db, getPackageOr404(db, pkgId)), 201);
});

function cleanList(list: string[] | undefined): string[] {
  return (list ?? []).map((s) => s?.trim() ?? "").filter(Boolean);
}

function parseDateField(value: string | null | undefined): string | null {
  try {
    return parsePartialDate(value ?? null);
  } catch (err) {
    throw new HTTPException(422, { message: err instanceof Error ? err.message : "日期无效" });
  }
}

// ---------- 列表 / 详情 / 编辑 / 删除 ----------

packagesRouter.get("/api/packages", (c) => {
  const db = c.get("db");
  const conds: string[] = [];
  const params: Array<string | number> = [];

  const [cid1, none1] = parseIdFilterNullable(c.req.query("l1"));
  if (none1) {
    // "none" = 没有任何分类路径（未分类）
    conds.push("NOT EXISTS (SELECT 1 FROM package_paths pp WHERE pp.package_id = packages.id)");
  } else if (cid1 !== null) {
    // 同一路径上的前缀匹配：l1=X（可选再限定 l2/l3）
    let sub = "SELECT 1 FROM package_paths pp WHERE pp.package_id = packages.id AND pp.l1_id = ?";
    params.push(cid1);
    const [cid2] = parseIdFilterNullable(c.req.query("l2"));
    const [cid3] = parseIdFilterNullable(c.req.query("l3"));
    if (cid2 !== null) {
      sub += " AND pp.l2_id = ?";
      params.push(cid2);
    }
    if (cid3 !== null) {
      sub += " AND pp.l3_id = ?";
      params.push(cid3);
    }
    conds.push(`EXISTS (${sub})`);
  }
  const fmt = c.req.query("format");
  if (fmt) {
    conds.push("EXISTS (SELECT 1 FROM files fl WHERE fl.package_id = packages.id AND fl.format = ?)");
    params.push(fmt);
  }
  const statusFilter = c.req.query("status");
  if (statusFilter) {
    if (!["未读", "在读", "已读"].includes(statusFilter)) {
      throw new HTTPException(422, { message: "状态筛选无效" });
    }
    conds.push("packages.status = ?");
    params.push(statusFilter);
  }
  if (["1", "true"].includes(c.req.query("undated") ?? "")) {
    conds.push("packages.publish_date IS NULL");
  }
  const q = c.req.query("q");
  if (q) {
    if (q.length > 200) throw new HTTPException(422, { message: "q 最长 200" });
    const needle = q.trim();
    if (needle.length >= 3) {
      // ≥3 字走 trigram FTS（倒排索引，子串语义与 LIKE 等价且支持中文分词）
      const match = `"${needle.replaceAll('"', '""')}"`;
      conds.push("packages.id IN (SELECT rowid FROM packages_fts WHERE packages_fts MATCH ?)");
      params.push(match);
    } else {
      const like = `%${needle}%`;
      conds.push("(packages.title LIKE ? OR packages.authors LIKE ? OR packages.publisher LIKE ? OR packages.notes LIKE ? OR packages.tags LIKE ?)");
      params.push(like, like, like, like, like);
    }
  }

  const orderMap: Record<string, string> = {
    newest: "packages.created_at DESC",
    oldest: "packages.created_at ASC",
    title: "packages.title ASC",
    date_asc: "packages.publish_date ASC NULLS LAST",
    date_desc: "packages.publish_date DESC NULLS LAST",
  };
  const sort = c.req.query("sort") ?? "newest";
  const order = orderMap[sort];
  if (!order) throw new HTTPException(422, { message: "排序参数无效" });

  const page = Number(c.req.query("page") ?? 1);
  const pageSize = Number(c.req.query("page_size") ?? 20);
  if (!Number.isInteger(page) || page < 1) throw new HTTPException(422, { message: "page 无效" });
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new HTTPException(422, { message: "page_size 需在 1~100" });
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM packages ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM packages ${where} ORDER BY ${order}, packages.id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as PackageRow[];

  const catCache = new Map();
  // 批量装载本页包的文件与路径：每包 3 条查询的 N+1 → 两条 IN 查询
  const items = loadManyFull(db, rows).map((p) => packageOut(db, p, catCache));
  return c.json({ total, page, page_size: pageSize, items });
});

/** 存量 PDF 封面补齐的工作清单（设置页）：无真封面且含 pdf 的包 + 首个 pdf 文件 id——轻查询，替代客户端「逐包拉完整详情」的 N+1。 */
packagesRouter.get("/api/packages/needs-cover", (c) => {
  const db = c.get("db");
  const rows = db
    .prepare(
      "SELECT p.id AS pkg_id, p.title AS title, f.id AS file_id FROM packages p" +
        " JOIN files f ON f.package_id = p.id AND f.format = 'pdf'" +
        " WHERE p.cover_sha256 IS NULL ORDER BY p.id, f.sort_order, f.id",
    )
    .all() as Array<{ pkg_id: number; title: string; file_id: number }>;
  const items: Array<{ pkg_id: number; title: string; file_id: number }> = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.pkg_id)) continue; // 一个包多个 pdf 只取第一个
    seen.add(r.pkg_id);
    items.push(r);
  }
  return c.json({ items });
});

function parseIdFilterNullable(raw: string | null | undefined): [number | null, boolean] {
  if (raw === null || raw === undefined || raw === "") return [null, false];
  if (raw === "none") return [null, true];
  const n = Number(raw);
  if (Number.isInteger(n) && String(n) === raw.trim()) return [n, false];
  throw new HTTPException(422, { message: `分类参数无效：${raw}` });
}

packagesRouter.get("/api/packages/:id", (c) => {
  const pkg = getPackageOr404(c.get("db"), Number(c.req.param("id")));
  return c.json(packageDetail(c.get("settings"), c.get("db"), pkg));
});

packagesRouter.patch("/api/packages/:id", async (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const pkgId = Number(c.req.param("id"));
  getPackageOr404(db, pkgId);
  const payload = await c.req.json<CommitPayload["meta"] & { sort_order?: number }>().catch(() => ({}) as never);
  const meta = payload ?? {};

  if (meta.classifications !== undefined && meta.classifications !== null) {
    // 整体替换所有分类路径
    const resolved = resolvePaths(db, meta.classifications);
    db.prepare("DELETE FROM package_paths WHERE package_id = ?").run(pkgId);
    const insertPath = db.prepare(
      "INSERT INTO package_paths (package_id, l1_id, l2_id, l3_id, updated_at, uuid) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const [l1, l2, l3] of resolved) {
      insertPath.run(pkgId, l1, l2, l3, nowSqlite(), randomUUID().replaceAll("-", ""));
    }
  }

  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | null> = [nowSqlite()];

  if (meta.title !== undefined && meta.title !== null) {
    const t = meta.title.trim();
    if (!t || t.length > 500) throw new HTTPException(422, { message: "包名长度需在 1~500" });
    sets.push("title = ?");
    params.push(t);
  }
  if (meta.authors !== undefined && meta.authors !== null) {
    sets.push("authors = ?");
    params.push(JSON.stringify(cleanList(meta.authors)));
  }
  if (meta.publish_date !== undefined) {
    sets.push("publish_date = ?");
    params.push(parseDateField(meta.publish_date));
  }
  if (meta.publisher !== undefined) {
    sets.push("publisher = ?");
    params.push((meta.publisher ?? "").trim() || null);
  }
  if (meta.tags !== undefined && meta.tags !== null) {
    sets.push("tags = ?");
    params.push(JSON.stringify(cleanList(meta.tags)));
  }
  if (meta.notes !== undefined) {
    sets.push("notes = ?");
    params.push(meta.notes ?? null);
  }
  params.push(pkgId);
  db.prepare(`UPDATE packages SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  if (meta.title !== undefined && meta.title !== null) {
    const coverPath = join(settings.artDir, "covers", `${pkgId}.png`);
    const coverImg = existsSync(coverPath) ? readFileSync(coverPath) : null;
    await regeneratePackageArt(settings.artDir, pkgId, meta.title.trim(), coverImg);
    const palette = await paletteFromCover(coverImg, meta.title.trim());
    db.prepare("UPDATE packages SET palette = ? WHERE id = ?").run(JSON.stringify(palette), pkgId);
  }
  return c.json(packageDetail(settings, db, getPackageOr404(db, pkgId)));
});

packagesRouter.delete("/api/packages/:id", (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const pkg = getPackageOr404(db, Number(c.req.param("id")));
  rmSync(packageDir(settings, pkg), { recursive: true, force: true });
  rmSync(join(settings.filesDir, String(pkg.row.id)), { recursive: true, force: true }); // 兼容旧目录名残留
  const coverPath = join(settings.artDir, "covers", `${pkg.row.id}.png`);
  if (existsSync(coverPath)) unlinkSync(coverPath);
  const spinePath = join(settings.artDir, "spines", `${pkg.row.id}.png`);
  if (existsSync(spinePath)) unlinkSync(spinePath);
  for (const f of pkg.files) {
    const fc = fileCoverPath(settings, f);
    if (existsSync(fc)) unlinkSync(fc);
  }
  db.prepare("DELETE FROM packages WHERE id = ?").run(pkg.row.id);
  return c.json({ ok: true });
});

// ---------- 包内文件管理 ----------

packagesRouter.post("/api/packages/:id/files", async (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const pkgId = Number(c.req.param("id"));
  const pkg = getPackageOr404(db, pkgId);
  const payload = await c.req.json<{ stage_id?: string }>().catch(() => ({}) as never);
  const stagingDir = join(settings.stagingDir, payload.stage_id ?? "");
  if (!existsSync(join(stagingDir, "file"))) {
    throw new HTTPException(404, { message: "暂存文件已过期，请重新上传" });
  }
  const info = JSON.parse(readFileSync(join(stagingDir, "meta.json"), "utf-8")) as {
    filename: string;
    format: string;
    size: number;
    page_count: number | null;
    sha256?: string;
  };

  const maxOrder = pkg.files.reduce((m, f) => Math.max(m, f.sort_order), -1);
  const stagedSha = info.sha256 ?? sha256FileSync(join(stagingDir, "file"));
  const { fileId, coverImg } = inTransaction(db, () => {
    const ins = db
      .prepare(
        "INSERT INTO files (package_id, name, format, file_path, file_size, page_count, sort_order, sha256, local, updated_at, uuid) VALUES (?, ?, ?, '', ?, ?, ?, ?, 1, ?, ?)",
      )
      .run(pkgId, info.filename, info.format, info.size, info.page_count ?? null, maxOrder + 1, stagedSha, nowSqlite(), randomUUID().replaceAll("-", ""));
    const fileId = Number(ins.lastInsertRowid);
    const dir = packageDir(settings, pkg);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${fileId}_${info.filename}`);
    renameSync(join(stagingDir, "file"), dest);
    db.prepare("UPDATE files SET file_path = ? WHERE id = ?").run(
      join("files", ...dest.slice(settings.filesDir.length + 1).split(/[\\/]/)),
      fileId,
    );

    let coverImg: Buffer | null = null;
    const coverSrc = join(stagingDir, "cover.png");
    if (existsSync(coverSrc)) {
      coverImg = readFileSync(coverSrc);
      mkdirSync(join(settings.artDir, "filecovers"), { recursive: true });
      writeFileSync(join(settings.artDir, "filecovers", `${fileId}.png`), coverImg);
    }

    syncCounts(db, pkgId);
    recomputePackageStatus(db, pkgId); // 增文件改变"全部读完"口径
    return { fileId, coverImg };
  });
  // 包封面缺失时用新文件封面补上
  if (coverImg !== null && !existsSync(join(settings.artDir, "covers", `${pkgId}.png`))) {
    await regeneratePackageArt(settings.artDir, pkgId, pkg.row.title, coverImg);
    const palette = await paletteFromCover(coverImg, pkg.row.title);
    db.prepare("UPDATE packages SET palette = ?, cover_sha256 = ? WHERE id = ?").run(
      JSON.stringify(palette), sha256Sync(new Uint8Array(coverImg)), pkgId,
    );
  }
  rmSync(stagingDir, { recursive: true, force: true });
  return c.json(
    {
      id: fileId,
      name: info.filename,
      format: info.format,
      file_size: info.size,
      page_count: info.page_count ?? null,
      sort_order: maxOrder + 1,
      has_cover: coverImg !== null,
      progress: null,
    },
    201,
  );
});

/** 批量文件编辑（编辑弹窗保存）：一次请求完成全部移除+新增——替代逐文件串行 N 次往返与「部分生效」中间态。 */
packagesRouter.post("/api/packages/:id/files/batch", async (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const pkgId = Number(c.req.param("id"));
  const pkg = getPackageOr404(db, pkgId);
  const payload = await c.req
    .json<{ remove_ids?: number[]; add_stage_ids?: string[] }>()
    .catch(() => ({}) as never);
  const removeIds = (payload.remove_ids ?? []).filter((n) => Number.isInteger(n));
  const addStageIds = (payload.add_stage_ids ?? []).filter((s) => typeof s === "string" && s !== "");
  if (removeIds.length + addStageIds.length === 0) {
    throw new HTTPException(422, { message: "没有任何变更" });
  }
  // 校验移除目标属于本包；清空守卫与单删一致（移除至空包=删整包，走 DELETE 端点）
  const removeSet = new Set(removeIds);
  for (const id of removeIds) {
    if (!pkg.files.some((f) => f.id === id)) throw new HTTPException(404, { message: `文件 ${id} 不在该包内` });
  }
  if (pkg.files.length - removeSet.size + addStageIds.length === 0) {
    throw new HTTPException(422, { message: "不能移除全部文件（保存将删除整个资料包请走整包删除）" });
  }
  // 预读暂存信息（缺失/过期直接 404，不动库）
  const staged: Array<{ dir: string; filename: string; format: string; size: number; pageCount: number | null; sha?: string }> = [];
  for (const sid of addStageIds) {
    const dir = join(settings.stagingDir, sid);
    if (!existsSync(join(dir, "file"))) {
      throw new HTTPException(404, { message: `暂存文件已过期（${sid.slice(0, 8)}…），请重新上传` });
    }
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")) as {
      filename: string; format: string; size: number; page_count: number | null; sha256?: string;
    };
    staged.push({ dir, filename: meta.filename, format: meta.format, size: meta.size, pageCount: meta.page_count, sha: meta.sha256 });
  }

  const dir = packageDir(settings, pkg);
  mkdirSync(dir, { recursive: true });
  const result = inTransaction(db, () => {
    // 移除（含封面缓存清理）
    const delFile = pstmt(db, "DELETE FROM files WHERE id = ?");
    for (const f of pkg.files) {
      if (!removeSet.has(f.id)) continue;
      delFile.run(f.id);
      const fc = fileCoverPath(settings, f);
      if (existsSync(fc)) unlinkSync(fc);
    }
    // 新增（sha/落位/文件封面与单加一致）
    let order = pkg.files.reduce((m, f) => Math.max(m, f.sort_order), -1);
    let firstCover: Buffer | null = null;
    for (const s of staged) {
      order += 1;
      const sha = s.sha ?? sha256FileSync(join(s.dir, "file"));
      const ins = pstmt(db, "INSERT INTO files (package_id, name, format, file_path, file_size, page_count, sort_order, sha256, local, updated_at, uuid) VALUES (?, ?, ?, '', ?, ?, ?, ?, 1, ?, ?)").run(
        pkgId, s.filename, s.format, s.size, s.pageCount, order, sha, nowSqlite(), randomUUID().replaceAll("-", ""),
      );
      const fileId = Number(ins.lastInsertRowid);
      const dest = join(dir, `${fileId}_${s.filename}`);
      renameSync(join(s.dir, "file"), dest);
      pstmt(db, "UPDATE files SET file_path = ? WHERE id = ?").run(
        join("files", ...dest.slice(settings.filesDir.length + 1).split(/[\\/]/)), fileId,
      );
      const coverSrc = join(s.dir, "cover.png");
      if (existsSync(coverSrc)) {
        const img = readFileSync(coverSrc);
        mkdirSync(join(settings.artDir, "filecovers"), { recursive: true });
        writeFileSync(join(settings.artDir, "filecovers", `${fileId}.png`), img);
        if (firstCover === null) firstCover = img;
      }
    }
    syncCounts(db, pkgId);
    recomputePackageStatus(db, pkgId);
    return { firstCover };
  });
  // 包封面缺失时用新文件封面补上（与单加一致）
  if (result.firstCover !== null && !existsSync(join(settings.artDir, "covers", `${pkgId}.png`))) {
    await regeneratePackageArt(settings.artDir, pkgId, pkg.row.title, result.firstCover);
    const palette = await paletteFromCover(result.firstCover, pkg.row.title);
    db.prepare("UPDATE packages SET palette = ?, cover_sha256 = ? WHERE id = ?").run(
      JSON.stringify(palette), sha256Sync(new Uint8Array(result.firstCover)), pkgId,
    );
  }
  for (const s of staged) rmSync(s.dir, { recursive: true, force: true });
  return c.json(packageDetail(settings, db, getPackageOr404(db, pkgId)));
});

packagesRouter.patch("/api/packages/:id/files/:fileId", async (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const pkgId = Number(c.req.param("id"));
  const fileId = Number(c.req.param("fileId"));
  const pkg = getPackageOr404(db, pkgId);
  const f = pkg.files.find((x) => x.id === fileId);
  if (!f) throw new HTTPException(404, { message: "包内文件不存在" });
  const payload = await c.req.json<{ name?: string; sort_order?: number }>().catch(() => ({}) as never);
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (payload.name !== undefined && payload.name !== null) {
    sets.push("name = ?");
    params.push(sanitizeName(payload.name, 120, "file"));
  }
  if (payload.sort_order !== undefined && payload.sort_order !== null) {
    sets.push("sort_order = ?");
    params.push(payload.sort_order);
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    params.push(nowSqlite());
    params.push(fileId);
    db.prepare(`UPDATE files SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    }
  const updated = loadFiles(db, pkgId).find((x) => x.id === fileId)!;
  return c.json({
    id: updated.id,
    name: updated.name,
    format: updated.format,
    file_size: updated.file_size,
    page_count: updated.page_count,
    sort_order: updated.sort_order,
    has_cover: existsSync(fileCoverPath(settings, updated)),
    progress: progressOut(getProgress(db, fileId)),
  });
});

packagesRouter.delete("/api/packages/:id/files/:fileId", (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const pkgId = Number(c.req.param("id"));
  const fileId = Number(c.req.param("fileId"));
  const pkg = getPackageOr404(db, pkgId);
  const f = pkg.files.find((x) => x.id === fileId);
  if (!f) throw new HTTPException(404, { message: "包内文件不存在" });
  if (pkg.files.length === 1) {
    throw new HTTPException(422, {
      message: "不能移除包内唯一的文件：请删除整个资料包，或先添加新文件再移除",
    });
  }
  const filePath = join(settings.dataDir, f.file_path);
  if (existsSync(filePath)) unlinkSync(filePath);
  const fc = fileCoverPath(settings, f);
  if (existsSync(fc)) unlinkSync(fc);
  db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  syncCounts(db, pkgId);
  recomputePackageStatus(db, pkgId); // 删文件同理（如移除最后一个未读文件→已读）
  return c.json({ ok: true });
});

// ---------- 资产端点：封面 / 书脊 / 文件流 ----------

function serveFile(c: Context<Env>, path: string, mediaType: string) {
  const size = statSync(path).size;
  c.header("Cache-Control", "private, max-age=86400");
  return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, {
    "Content-Type": mediaType,
    "Content-Length": String(size),
  });
}

packagesRouter.get("/api/packages/:id/cover", async (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const pkg = getPackageOr404(db, Number(c.req.param("id")));
  const path = join(settings.artDir, "covers", `${pkg.row.id}.png`);
  if (!existsSync(path)) {
    // 没有真封面 → 本地确定性占位（palette 优先用列内缓存，保证封面颜色稳定）
    mkdirSync(join(settings.artDir, "covers"), { recursive: true });
    const paletteRow = db.prepare("SELECT palette FROM packages WHERE id = ?").get(pkg.row.id) as { palette: string | null } | undefined;
    let palette: Awaited<ReturnType<typeof paletteFromCover>> | null = null;
    if (paletteRow?.palette) {
      try {
        palette = JSON.parse(paletteRow.palette);
      } catch {
        palette = null;
      }
    }
    writeFileSync(path, await makePlaceholderCover(pkg.row.title, palette ?? (await paletteFromCover(null, pkg.row.title))));
  }
  return serveFile(c, path, "image/png");
});

/** 客户端渲染封面上传（PDF 首页补齐）：规范化入库并更新 cover_sha256/palette。 */
packagesRouter.put("/api/packages/:id/cover", async (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const pkgId = Number(c.req.param("id"));
  const pkg = getPackageOr404(db, pkgId);
  const body = await c.req.parseBody();
  const upload = body.cover;
  if (!(upload instanceof File)) throw new HTTPException(422, { message: "缺少 cover 文件" });
  const raw = Buffer.from(await upload.arrayBuffer());
  const normalized = await normalizeCover(raw, pkg.row.title);
  mkdirSync(join(settings.artDir, "covers"), { recursive: true });
  writeFileSync(join(settings.artDir, "covers", `${pkgId}.png`), normalized);
  const spinePath = join(settings.artDir, "spines", `${pkgId}.png`);
  if (existsSync(spinePath)) unlinkSync(spinePath); // 书脊按新封面重生成
  const palette = await paletteFromCover(normalized, pkg.row.title);
  db.prepare("UPDATE packages SET cover_sha256 = ?, palette = ? WHERE id = ?").run(
    sha256Sync(new Uint8Array(normalized)),
    JSON.stringify(palette),
    pkgId,
  );
  return c.json({ ok: true, real: true });
});

packagesRouter.get("/api/packages/:id/spine", async (c) => {
  const db = c.get("db");
  const settings = c.get("settings");
  const pkg = getPackageOr404(db, Number(c.req.param("id")));
  const path = join(settings.artDir, "spines", `${pkg.row.id}.png`);
  if (!existsSync(path)) {
    const coverPath = join(settings.artDir, "covers", `${pkg.row.id}.png`);
    const coverImg = existsSync(coverPath) ? readFileSync(coverPath) : null;
    await regeneratePackageArt(settings.artDir, pkg.row.id, pkg.row.title, coverImg);
  }
  return serveFile(c, path, "image/png");
});

packagesRouter.get("/api/files/:fileId/cover", (c) => {
  const settings = c.get("settings");
  const fileId = Number(c.req.param("fileId"));
  const f = c.get("db").prepare("SELECT id FROM files WHERE id = ?").get(fileId);
  if (!f) throw new HTTPException(404, { message: "文件不存在" });
  const row = { id: fileId } as FileRow;
  const path = fileCoverPath(settings, row);
  if (!existsSync(path)) throw new HTTPException(404, { message: "该文件没有封面" });
  return serveFile(c, path, "image/png");
});

packagesRouter.get("/api/files/:fileId/file", (c) => {
  const settings = c.get("settings");
  const db = c.get("db");
  const fileId = Number(c.req.param("fileId"));
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as
    | FileRow
    | undefined;
  if (!f) throw new HTTPException(404, { message: "文件不存在" });
  const realPath = join(settings.dataDir, f.file_path);
  if (existsSync(realPath)) {
    return serveWithRange(c, realPath, mediaTypeOf(f.format));
  }
  throw new HTTPException(404, { message: "文件缺失（磁盘上找不到该文件的字节）" });
});

function serveWithRange(c: Context<Env>, path: string, mediaType: string) {
  const size = statSync(path).size;
  const header = c.req.header("range");
  if (header) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        return c.body(null, 416, { "Content-Range": `bytes */${size}` });
      }
      return c.body(
        Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream,
        206,
        {
          "Content-Type": mediaType,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
        },
      );
    }
  }
  return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, {
    "Content-Type": mediaType,
    "Content-Length": String(size),
    "Accept-Ranges": "bytes",
  });
}
