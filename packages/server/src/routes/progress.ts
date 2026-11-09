/** 阅读进度：按包内文件记录；包状态由文件进度聚合。 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env";
import { msg } from "../i18n";
import { getProgress, progressOut, recomputePackageStatus } from "../repo";
import { nowSqlite } from "../db";

export const progressRouter = new Hono<Env>();

progressRouter.get("/api/progress/:fileId", (c) => {
  const db = c.get("db");
  const fileId = Number(c.req.param("fileId"));
  const f = db.prepare("SELECT id FROM files WHERE id = ?").get(fileId);
  if (!f) throw new HTTPException(404, { message: msg(c, "file.notFound") });
  return c.json(progressOut(getProgress(db, fileId)));
});

progressRouter.put("/api/progress/:fileId", async (c) => {
  const db = c.get("db");
  const fileId = Number(c.req.param("fileId"));
  const f = db.prepare("SELECT id, package_id FROM files WHERE id = ?").get(fileId) as
    | { id: number; package_id: number }
    | undefined;
  if (!f) throw new HTTPException(404, { message: msg(c, "file.notFound") });
  const payload = await c.req
    .json<{ locator?: Record<string, unknown>; percent?: number }>()
    .catch(() => ({}) as never);
  const locator = payload.locator ?? {};
  const percent = payload.percent;
  if (typeof percent !== "number" || !(0 <= percent && percent <= 100)) {
    throw new HTTPException(422, { message: msg(c, "prog.percentRange") });
  }
  const existing = getProgress(db, fileId);
  if (existing === null) {
    db.prepare(
      "INSERT INTO reading_progress (file_id, locator, percent, updated_at) VALUES (?, ?, ?, ?)",
    ).run(fileId, JSON.stringify(locator), percent, nowSqlite());
  } else {
    db.prepare("UPDATE reading_progress SET locator = ?, percent = ?, updated_at = ? WHERE file_id = ?").run(
      JSON.stringify(locator),
      percent,
      nowSqlite(),
      fileId,
    );
  }
  // 重算所属包状态（写事件）
  recomputePackageStatus(db, f.package_id);
  return c.json(progressOut(getProgress(db, fileId)));
});

/** 重置进度：删除该文件的进度记录。 */
progressRouter.delete("/api/progress/:fileId", (c) => {
  const db = c.get("db");
  const fileId = Number(c.req.param("fileId"));
  const f = db.prepare("SELECT id, package_id FROM files WHERE id = ?").get(fileId) as
    | { id: number; package_id: number }
    | undefined;
  if (!f) throw new HTTPException(404, { message: msg(c, "file.notFound") });
  if (getProgress(db, fileId) === null) throw new HTTPException(404, { message: msg(c, "prog.noProgress") });
  db.prepare("DELETE FROM reading_progress WHERE file_id = ?").run(fileId);
  recomputePackageStatus(db, f.package_id);
  return c.json({ ok: true });
});
