/** 同步与备份 API：云配置（凭据脱敏返回）、连接探测、立即同步、状态、释放本地空间。 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env";
import type { SyncConfig } from "@zzlibrary/shared";

export const syncRouter = new Hono<Env>();

function maskConfig(cfg: SyncConfig | null): unknown {
  if (cfg === null) return null;
  const masked = structuredClone(cfg) as SyncConfig;
  if (masked.webdav?.password) masked.webdav.password = "***";
  if (masked.s3?.secretAccessKey) masked.s3.secretAccessKey = "***";
  return masked;
}

syncRouter.get("/api/sync/config", (c) => {
  return c.json({ config: maskConfig(c.get("sync").loadConfig()) });
});

syncRouter.put("/api/sync/config", async (c) => {
  const svc = c.get("sync");
  const body = await c.req.json<SyncConfig>().catch(() => ({}) as never);
  if (body === null || typeof body !== "object" || !["fs", "webdav", "s3"].includes(body.provider ?? "")) {
    throw new HTTPException(422, { message: "provider 需为 fs / webdav / s3" });
  }
  // 密钥脱敏回传时保留旧值
  const prev = svc.loadConfig();
  if (body.provider === "webdav" && body.webdav?.password === "***" && prev?.webdav?.password) {
    body.webdav.password = prev.webdav.password;
  }
  if (body.provider === "s3" && body.s3?.secretAccessKey === "***" && prev?.s3?.secretAccessKey) {
    body.s3.secretAccessKey = prev.s3.secretAccessKey;
  }
  try {
    svc.createStore(body); // 参数完整性
  } catch (err) {
    throw new HTTPException(422, { message: err instanceof Error ? err.message : "配置无效" });
  }
  svc.saveConfig({ ...body, autoSync: body.autoSync ?? false });
  return c.json({ ok: true, config: maskConfig(body) });
});

syncRouter.post("/api/sync/test", async (c) => {
  const svc = c.get("sync");
  let config = svc.loadConfig();
  if (config === null) {
    const body = await c.req.json<SyncConfig>().catch(() => null);
    if (body === null) throw new HTTPException(422, { message: "尚未配置云端，请先保存配置" });
    config = body;
  }
  try {
    await svc.createStore(config).probe();
    return c.json({ ok: true });
  } catch (err) {
    throw new HTTPException(422, { message: `连接失败：${err instanceof Error ? err.message : err}` });
  }
});

syncRouter.post("/api/sync/now", async (c) => {
  const svc = c.get("sync");
  try {
    const report = await svc.runSync();
    return c.json({ ok: true, report });
  } catch (err) {
    throw new HTTPException(422, { message: err instanceof Error ? err.message : "同步失败" });
  }
});

syncRouter.get("/api/sync/status", (c) => {
  return c.json(c.get("sync").status());
});

/** 聚焦驱动的云端变更探测（轻版本号校验）：web 窗口聚焦/可见时调用，毫秒级，不抛错（离线静默）。 */
syncRouter.get("/api/sync/check", async (c) => {
  return c.json(await c.get("sync").checkCloud());
});

syncRouter.post("/api/sync/release/:id", (c) => {
  const db = c.get("db");
  const svc = c.get("sync");
  const pkgId = Number(c.req.param("id"));
  const exists = db.prepare("SELECT id FROM packages WHERE id = ?").get(pkgId);
  if (!exists) throw new HTTPException(404, { message: "资料包不存在" });
  try {
    const r = svc.releasePackage(pkgId);
    return c.json({ ok: true, ...r });
  } catch (err) {
    // 释放守卫：云端没确认副本前拒绝删除本地字节
    throw new HTTPException(422, { message: err instanceof Error ? err.message : "释放失败" });
  }
});

/** 整理云端：清理超过保留期的删除墓碑与无引用内容块（手动触发，不可恢复）。 */
syncRouter.post("/api/sync/gc", async (c) => {
  const svc = c.get("sync");
  const body = await c.req.json<{ retention_days?: number }>().catch(() => ({}) as never);
  const retention = body?.retention_days;
  try {
    const report = await svc.gcCloud(
      typeof retention === "number" && retention >= 0 ? retention : 180,
    );
    return c.json({ ok: true, report });
  } catch (err) {
    throw new HTTPException(422, { message: err instanceof Error ? err.message : "整理失败" });
  }
});
