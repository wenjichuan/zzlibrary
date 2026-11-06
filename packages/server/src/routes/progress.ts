/** 阅读进度：按包内文件记录，多端同步；包状态由文件进度聚合。 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env";
import { getProgress, progressOut, recomputePackageStatus } from "../repo";
import { nowSqlite } from "../db";
import { recordTombstone } from "../sync-device";

export const progressRouter = new Hono<Env>();

progressRouter.get("/api/progress/:fileId", (c) => {
  const db = c.get("db");
  const fileId = Number(c.req.param("fileId"));
  const f = db.prepare("SELECT id FROM files WHERE id = ?").get(fileId);
  if (!f) throw new HTTPException(404, { message: "文件不存在" });
  return c.json(progressOut(getProgress(db, fileId)));
});

progressRouter.put("/api/progress/:fileId", async (c) => {
  const db = c.get("db");
  const fileId = Number(c.req.param("fileId"));
  const f = db.prepare("SELECT id, package_id FROM files WHERE id = ?").get(fileId) as
    | { id: number; package_id: number }
    | undefined;
  if (!f) throw new HTTPException(404, { message: "文件不存在" });
  const payload = await c.req
    .json<{ locator?: Record<string, unknown>; percent?: number }>()
    .catch(() => ({}) as never);
  const locator = payload.locator ?? {};
  const percent = payload.percent;
  if (typeof percent !== "number" || !(0 <= percent && percent <= 100)) {
    throw new HTTPException(422, { message: "percent 需在 0~100" });
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
  c.get("sync").queueLocalChange();
  return c.json(progressOut(getProgress(db, fileId)));
});

/** 重置进度：删除行 + 墓碑（全端生效；读得更远的对端进度按 LWW 保留）。 */
progressRouter.delete("/api/progress/:fileId", (c) => {
  const db = c.get("db");
  const fileId = Number(c.req.param("fileId"));
  const f = db.prepare("SELECT id, package_id, uuid FROM files WHERE id = ?").get(fileId) as
    | { id: number; package_id: number; uuid: string }
    | undefined;
  if (!f) throw new HTTPException(404, { message: "文件不存在" });
  if (getProgress(db, fileId) === null) throw new HTTPException(404, { message: "该文件没有进度记录" });
  recordTombstone(db, "progress", f.uuid);
  db.prepare("DELETE FROM reading_progress WHERE file_id = ?").run(fileId);
  recomputePackageStatus(db, f.package_id);
  c.get("sync").queueLocalChange();
  return c.json({ ok: true });
});
