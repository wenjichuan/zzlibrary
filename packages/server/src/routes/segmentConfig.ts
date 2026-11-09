/** 时间分段配置：全局默认 + 按二级分类覆盖 + 按三级分类覆盖。
 * 生效优先级：三级覆盖 > 二级覆盖 > 全局默认。 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseRange } from "@zzlibrary/core";
import type { Env } from "../env";
import { getCategory } from "../deps";
import { nowSqlite } from "../db";
import { langOf, msg, msgFor, type Lang } from "../i18n";

export const segmentConfigRouter = new Hono<Env>();

interface ConfigRow {
  id: number;
  scope: "global" | "l2" | "l3";
  l2_id: number | null;
  l3_id: number | null;
  mode: string;
  params: string; // JSON text
}

function out(cfg: ConfigRow) {
  return {
    scope: cfg.scope,
    l2_id: cfg.l2_id,
    l3_id: cfg.l3_id,
    mode: cfg.mode,
    params: safeParams(cfg.params),
  };
}

function safeParams(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function validate(payload: { mode?: string; params?: Record<string, unknown> }, lang: Lang): void {
  const mode = payload.mode ?? "";
  const params = payload.params ?? {};
  if (mode === "n_years") {
    const n = params.n;
    if (typeof n !== "number" || !Number.isInteger(n) || !(1 <= n && n <= 100)) {
      throw new HTTPException(422, { message: msgFor(lang, "seg.nYearsParam") });
    }
  } else if (mode === "custom") {
    const ranges = params.ranges;
    if (!Array.isArray(ranges) || ranges.length === 0) {
      throw new HTTPException(422, { message: msgFor(lang, "seg.rangesMissing") });
    }
    for (const r of ranges) {
      if (typeof r !== "object" || r === null || parseRange(r) === null) {
        throw new HTTPException(422, {
          message: msgFor(lang, "seg.rangeInvalid", { raw: JSON.stringify(r) }),
        });
      }
    }
  } else if (!["year", "decade", "month"].includes(mode)) {
    throw new HTTPException(422, { message: msgFor(lang, "seg.modeInvalid") });
  }
}

function upsert(
  db: Env["Variables"]["db"],
  scope: "global" | "l2" | "l3",
  l2Id: number | null,
  l3Id: number | null,
  payload: { mode: string; params: Record<string, unknown> },
): ConfigRow {
  const existing = db
    .prepare("SELECT * FROM segment_configs WHERE scope = ? AND l2_id IS ? AND l3_id IS ?")
    .get(scope, l2Id, l3Id) as ConfigRow | undefined;
  const paramsText = JSON.stringify(payload.params ?? {});
  if (existing === undefined) {
    db.prepare(
      "INSERT INTO segment_configs (scope, l2_id, l3_id, mode, params, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(scope, l2Id, l3Id, payload.mode, paramsText, nowSqlite());
    return db
      .prepare("SELECT * FROM segment_configs WHERE scope = ? AND l2_id IS ? AND l3_id IS ?")
      .get(scope, l2Id, l3Id) as ConfigRow;
  }
  db.prepare("UPDATE segment_configs SET mode = ?, params = ?, updated_at = ? WHERE id = ?").run(
    payload.mode,
    paramsText,
    nowSqlite(),
    existing.id,
  );
  return { ...existing, mode: payload.mode, params: paramsText };
}

segmentConfigRouter.get("/api/segment-config", (c) => {
  const db = c.get("db");
  const globalCfg = db
    .prepare("SELECT * FROM segment_configs WHERE scope = 'global'")
    .get() as ConfigRow | undefined;
  const overrides = db
    .prepare("SELECT * FROM segment_configs WHERE scope IN ('l2','l3') ORDER BY l2_id, l3_id")
    .all() as ConfigRow[];
  return c.json({
    global: globalCfg
      ? out(globalCfg)
      : { scope: "global", l2_id: null, l3_id: null, mode: "year", params: {} },
    overrides: overrides.map(out),
  });
});

segmentConfigRouter.put("/api/segment-config", async (c) => {
  const payload = await c.req
    .json<{ mode?: string; params?: Record<string, unknown> }>()
    .catch(() => ({}) as never);
  validate(payload, langOf(c));
  const result = out(upsert(c.get("db"), "global", null, null, payload as { mode: string; params: Record<string, unknown> }));
  return c.json(result);
});

segmentConfigRouter.put("/api/segment-config/:l2Id", async (c) => {
  const db = c.get("db");
  const l2Id = Number(c.req.param("l2Id"));
  const l2 = getCategory(db, l2Id);
  if (l2 === null || l2.level !== 2) throw new HTTPException(404, { message: msg(c, "seg.l2NotFound") });
  const payload = await c.req
    .json<{ mode?: string; params?: Record<string, unknown> }>()
    .catch(() => ({}) as never);
  validate(payload, langOf(c));
  const result = out(upsert(db, "l2", l2Id, null, payload as { mode: string; params: Record<string, unknown> }));
  return c.json(result);
});

segmentConfigRouter.delete("/api/segment-config/:l2Id", (c) => {
  const db = c.get("db");
  const l2Id = Number(c.req.param("l2Id"));
  const cfg = db
    .prepare("SELECT * FROM segment_configs WHERE scope = 'l2' AND l2_id = ?")
    .get(l2Id) as ConfigRow | undefined;
  if (cfg === undefined) throw new HTTPException(404, { message: msg(c, "seg.noL2Override") });
  db.prepare("DELETE FROM segment_configs WHERE id = ?").run(cfg.id);
  return c.json({ ok: true });
});

segmentConfigRouter.put("/api/segment-config/l3/:l3Id", async (c) => {
  const db = c.get("db");
  const l3Id = Number(c.req.param("l3Id"));
  const l3 = getCategory(db, l3Id);
  if (l3 === null || l3.level !== 3 || l3.parent_id === null) {
    throw new HTTPException(404, { message: msg(c, "seg.l3NotFound") });
  }
  const payload = await c.req
    .json<{ mode?: string; params?: Record<string, unknown> }>()
    .catch(() => ({}) as never);
  validate(payload, langOf(c));
  const result = out(upsert(db, "l3", l3.parent_id, l3Id, payload as { mode: string; params: Record<string, unknown> }));
  return c.json(result);
});

segmentConfigRouter.delete("/api/segment-config/l3/:l3Id", (c) => {
  const db = c.get("db");
  const l3Id = Number(c.req.param("l3Id"));
  const cfg = db
    .prepare("SELECT * FROM segment_configs WHERE scope = 'l3' AND l3_id = ?")
    .get(l3Id) as ConfigRow | undefined;
  if (cfg === undefined) throw new HTTPException(404, { message: msg(c, "seg.noL3Override") });
  db.prepare("DELETE FROM segment_configs WHERE id = ?").run(cfg.id);
  return c.json({ ok: true });
});
