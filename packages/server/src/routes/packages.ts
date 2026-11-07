/** 资料包：暂存入库（stage→commit）、列表检索、详情/编辑/删除、
 * 包内文件管理、封面/书脊/文件流服务。 */
import { createReadStream } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { detectFormat, displayDate, mediaTypeOf, parsePartialDate } from "@zzlibrary/core";
import type { Env } from "../env";
import { resolvePaths } from "../deps";
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
import { inTransaction, nowSqlite } from "../db";
import { extractMeta } from "../extract";
import { makePlaceholderCover, normalizeCover, paletteFromCover, regeneratePackageArt } from "../art";
import { recordPackageTombstones, recordTombstone } from "../sync-device";

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const packagesRouter = new Hono<Env>();

export function sanitizeFilename(name: string): string {
  let n = name;
  for (const ch of ["\\", "/", ":", "?", "*", '"', "<", ">", "|"]) n = n.split(ch).join("_");
  n = n.replace(/[\x00-\x1f]/g, "").replace(/^[. ]+|[. ]+$/g, "");
  return n.slice(0, 120) || "file";
}

function stemOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** 包目录名：{入库日期}_{包id}_{包名快照}——资源管理器离库可读；id 保证唯一。 */
function packageDirName(pkgId: number, title: string, createdAt: string): string {
  const datePart = createdAt ? createdAt.slice(0, 10) : "unknown";
  return `${datePart}_${pkgId}_${sanitizeFilename(title).slice(0, 40)}`;
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
      has_cover: existsSync(fileCoverPath(settings, f)),
      local: f.local === 1 && existsSync(join(settings.dataDir, f.file_path)),
      progress: progressOut(getProgress(db, f.id)),
    })),
  };
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

function runStage(
  settings: Env["Variables"]["settings"],
  filename: string,
  buffer: Buffer,
  coverBytes?: Uint8Array,
): StageResult {
  const fmt = detectFormat(filename); // 不限格式：未知扩展名原样登记
  const stageId = randomUUID().replaceAll("-", "");
  const stagingDir = join(settings.stagingDir, stageId);
  mkdirSync(stagingDir, { recursive: true });
  const target = join(stagingDir, "file");
  writeFileSync(target, buffer);
  const size = buffer.length;

  const meta = extractMeta(target, buffer, filename, fmt);
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
      filename: sanitizeFilename(filename),
      format: fmt,
      size,
      page_count: meta.page_count,
    }),
  );
  return { stageId, filename, size, format: fmt, meta, hasCover };
}


packagesRouter.post("/api/packages/stage", async (c) => {
  const settings = c.get("settings");
  const body = await c.req.parseBody();
  const upload = body.file;
  if (!(upload instanceof File) || !upload.name) {
    throw new HTTPException(422, { message: "缺少文件名" });
  }
  const filename = upload.name;
  const buffer = Buffer.from(await upload.arrayBuffer());
  const coverUpload = body.cover;
  const coverBytes = coverUpload instanceof File ? new Uint8Array(await coverUpload.arrayBuffer()) : undefined;
  const result = runStage(settings, filename, buffer, coverBytes);
  return c.json({
    stage_id: result.stageId,
    filename: result.filename,
    size: result.size,
    format: result.format,
    meta: {
      title: result.meta.title ?? sanitizeFilename(stemOf(result.filename)),
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
    info: { filename: string; format: string; size: number; page_count: number | null };
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
      const stagedBytes = readFileSync(join(dir, "file"));
      const f = db
        .prepare(
          "INSERT INTO files (package_id, name, format, file_path, file_size, page_count, sort_order, sha256, local, updated_at, uuid) VALUES (?, ?, ?, '', ?, ?, ?, ?, 1, ?, ?)",
        )
        .run(pkgId, info.filename, info.format, info.size, info.page_count ?? null, order, sha256Of(new Uint8Array(stagedBytes)), nowSqlite(), randomUUID().replaceAll("-", ""));
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
    packageCover === null ? null : sha256Of(new Uint8Array(packageCover)),
    pkgId,
  );
  for (const { dir } of staged) rmSync(dir, { recursive: true, force: true });
  c.get("sync").queueLocalChange();
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
    const like = `%${q.trim()}%`;
    conds.push("(packages.title LIKE ? OR packages.authors LIKE ? OR packages.publisher LIKE ? OR packages.notes LIKE ? OR packages.tags LIKE ?)");
    params.push(like, like, like, like, like);
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

function parseIdFilterNullable(raw: string | null | undefined): [number | null, boolean] {
  if (raw === null || raw === undefined || raw === "") return [null, false];
  if (raw === "none") return [null, true];
  const n = Number(raw);
  if (Number.isInteger(n) && String(n) === raw.trim()) return [n, false];
  throw new HTTPException(422, { message: `分类参数无效：${raw}` });
}

packagesRouter.get("/api/packages/:id", (c) => {
  const pkg = getPackageOr404(c.get("db"), Number(c.req.param("id")));
  // 释放本地空间的安全前提（云端确认有全部字节副本）；UI 据此显示按钮，释放端点再硬校验
  return c.json({ ...packageDetail(c.get("settings"), c.get("db"), pkg), can_release: c.get("sync").canRelease(pkg.row.id).ok });
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
  c.get("sync").queueLocalChange();
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
  inTransaction(db, () => {
    recordPackageTombstones(db, pkg);
    db.prepare("DELETE FROM packages WHERE id = ?").run(pkg.row.id);
  });
  c.get("sync").queueLocalChange();
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
  };

  const maxOrder = pkg.files.reduce((m, f) => Math.max(m, f.sort_order), -1);
  const stagedBytes = readFileSync(join(stagingDir, "file"));
  const { fileId, coverImg } = inTransaction(db, () => {
    const ins = db
      .prepare(
        "INSERT INTO files (package_id, name, format, file_path, file_size, page_count, sort_order, sha256, local, updated_at, uuid) VALUES (?, ?, ?, '', ?, ?, ?, ?, 1, ?, ?)",
      )
      .run(pkgId, info.filename, info.format, info.size, info.page_count ?? null, maxOrder + 1, sha256Of(new Uint8Array(stagedBytes)), nowSqlite(), randomUUID().replaceAll("-", ""));
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
      JSON.stringify(palette), sha256Of(new Uint8Array(coverImg)), pkgId,
    );
  }
  rmSync(stagingDir, { recursive: true, force: true });
  c.get("sync").queueLocalChange();
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
    params.push(sanitizeFilename(payload.name));
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
    c.get("sync").queueLocalChange();
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
  recordTombstone(db, "files", f.uuid,
    typeof f.sha256 === "string" && f.sha256 !== "" ? [{ sha256: f.sha256, size: f.file_size }] : undefined);
  recordTombstone(db, "progress", f.uuid);
  db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  syncCounts(db, pkgId);
  recomputePackageStatus(db, pkgId); // 删文件同理（如移除最后一个未读文件→已读）
  c.get("sync").queueLocalChange();
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
  const sync = c.get("sync");
  const pkg = getPackageOr404(db, Number(c.req.param("id")));
  const path = join(settings.artDir, "covers", `${pkg.row.id}.png`);
  if (!existsSync(path)) {
    // 真封面在云端 → 取回；没有真封面 → 本地确定性占位（palette 优先用列内缓存，释放后颜色不变）
    const fetched = await sync.ensureCoverLocal(pkg.row.id).catch(() => null);
    if (fetched === null) {
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
    sha256Of(new Uint8Array(normalized)),
    JSON.stringify(palette),
    pkgId,
  );
  c.get("sync").queueLocalChange();
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

packagesRouter.get("/api/files/:fileId/file", async (c) => {
  const settings = c.get("settings");
  const sync = c.get("sync");
  const fileId = Number(c.req.param("fileId"));
  const f = c.get("db").prepare("SELECT * FROM files WHERE id = ?").get(fileId) as
    | FileRow
    | undefined;
  if (!f) throw new HTTPException(404, { message: "文件不存在" });
  let path = join(settings.dataDir, f.file_path);
  if (!existsSync(path)) {
    // 透明取回：本地已释放 → 云端拉回缓存再伺服
    try {
      path = await sync.ensureFileLocal(fileId);
    } catch (err) {
      throw new HTTPException(404, { message: err instanceof Error ? err.message : "文件缺失" });
    }
  }
  const mediaType = mediaTypeOf(f.format);
  return serveWithRange(c, path, mediaType);
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
