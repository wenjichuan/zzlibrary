/** 应用工厂：中间件（会话校验/CORS/错误格式）、路由挂载、健康检查、SPA/静态。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import type { Env } from "./env";
import { Settings } from "./config";
import { openDb, migrate, migratePackageDirs, purgeStaleStaging } from "./db";
import { SessionManager, SESSION_COOKIE } from "./security";
import { recomputeAllPackageStatuses } from "./repo";
import { SyncService } from "./sync";
import { authRouter } from "./routes/auth";
import { categoriesRouter } from "./routes/categories";
import { packagesRouter } from "./routes/packages";
import { shelvesRouter } from "./routes/shelves";
import { segmentConfigRouter } from "./routes/segmentConfig";
import { progressRouter } from "./routes/progress";
import { syncRouter } from "./routes/sync";

export function createApp(settings = new Settings()): Hono<Env> {
  settings.ensureDirs();
  const db = openDb(settings.dbPath);
  const sessions = new SessionManager(settings);

  // —— 启动期（对应 Python lifespan）——
  migrate(db);
  migratePackageDirs(settings, db);
  const changed = recomputeAllPackageStatuses(db); // 存量对账（幂等）
  if (changed > 0) console.log(`包状态存量对账：重算了 ${changed} 个包`);
  purgeStaleStaging(settings);
  if (settings.password === "zzlibrary") {
    console.warn(
      "正在使用默认密码 zzlibrary（环境变量 ZZLIB_PASSWORD 可修改；也支持 pbkdf2$... 哈希）",
    );
  }

  const app = new Hono<Env>();
  const sync = new SyncService(settings, db);

  // 启动补同步：防抖窗口内关机/上次失败未补的变更，重启即追上（顺带拉取其他设备的远端变更）
  if (sync.loadConfig()?.autoSync) {
    const bootTimer = setTimeout(() => {
      sync.runSync().catch((err) =>
        console.error("启动同步失败：", err instanceof Error ? err.message : err),
      );
    }, 2000);
    bootTimer.unref?.(); // 不阻止进程退出
  }

  if (settings.corsOrigins) {
    const origins = settings.corsOrigins
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    app.use("*", cors({ origin: origins, credentials: true }));
  }

  // 错误格式与 FastAPI 对齐：{"detail": message}
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ detail: err.message }, err.status);
    }
    console.error(err);
    return c.json({ detail: "Internal Server Error" }, 500);
  });

  // 会话校验：除登录外的 /api/* 一律需要会话
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/login" || c.req.path === "/api/health") return next();
    const username = sessions.resolve(getCookie(c, SESSION_COOKIE));
    if (username === null || username !== settings.username) {
      return c.json({ detail: "未登录或会话已过期" }, 401);
    }
    c.set("username", username);
    return next();
  });

  app.use(async (c, next) => {
    c.set("settings", settings);
    c.set("sessions", sessions);
    c.set("db", db);
    c.set("sync", sync);
    return next();
  });

  app.route("/", authRouter);
  app.route("/", categoriesRouter);
  app.route("/", packagesRouter);
  app.route("/", shelvesRouter);
  app.route("/", segmentConfigRouter);
  app.route("/", progressRouter);
  app.route("/", syncRouter);

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  // 生产模式：Web 静态资源 + SPA 深链回退
  const dist = join(settings.dataDir, "..", "web", "dist");
  const distIndex = join(dist, "index.html");
  if (existsSync(distIndex)) {
    app.get("*", (c) => {
      const url = new URL(c.req.url);
      const path = url.pathname;
      if (path.startsWith("/api")) return c.json({ detail: "Not Found" }, 404);
      if (path.startsWith("/assets/")) {
        const filePath = join(dist, path.slice(1));
        if (existsSync(filePath)) {
          const ext = path.endsWith(".js") || path.endsWith(".mjs")
            ? "text/javascript"
            : path.endsWith(".css")
              ? "text/css"
              : "application/octet-stream";
          return c.body(readFileSync(filePath) as unknown as ReadableStream, 200, {
            "Content-Type": ext,
          });
        }
        return c.json({ detail: "Not Found" }, 404);
      }
      return c.html(readFileSync(distIndex, "utf-8"));
    });
  }

  return app;
}
