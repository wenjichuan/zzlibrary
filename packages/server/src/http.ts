/** 应用工厂：中间件（会话校验/CORS/错误格式）、路由挂载、健康检查、SPA/静态。 */
import { existsSync, readFileSync } from "node:fs";
import { langOf, msg, msgFor } from "./i18n";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import type { Env } from "./env";
import { Settings } from "./config";
import { openDb, migrate, purgeStaleStaging } from "./db";
import { SessionManager, SESSION_COOKIE } from "./security";
import { recomputeAllPackageStatuses } from "./repo";
import { authRouter } from "./routes/auth";
import { categoriesRouter } from "./routes/categories";
import { packagesRouter } from "./routes/packages";
import { shelvesRouter } from "./routes/shelves";
import { segmentConfigRouter } from "./routes/segmentConfig";
import { progressRouter } from "./routes/progress";
import { backupRouter } from "./routes/backup";

export function createApp(settings = new Settings()): Hono<Env> {
  settings.ensureDirs();
  const db = openDb(settings.dbPath);
  const sessions = new SessionManager(settings);

  // —— 启动期（对应 Python lifespan）——
  migrate(db);
  const changed = recomputeAllPackageStatuses(db); // 存量对账（幂等）
  if (changed > 0) console.log(`包状态存量对账：重算了 ${changed} 个包`);
  purgeStaleStaging(settings);
  if (settings.password === "zzlibrary") {
    console.warn(
      "正在使用默认密码 zzlibrary（环境变量 ZZLIB_PASSWORD 可修改；也支持 pbkdf2$... 哈希）",
    );
  }

  const app = new Hono<Env>();

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
      // 键式消息（无上下文的深层抛出，如 err.pkgNotFound / multipart）在出口按请求语言翻译
      const detail = /^err./.test(err.message) ? msgFor(langOf(c), err.message) : err.message;
      return c.json({ detail }, err.status);
    }
    console.error(err);
    return c.json({ detail: "Internal Server Error" }, 500);
  });

  // 会话校验：除登录外的 /api/* 一律需要会话
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/login" || c.req.path === "/api/health") return next();
    const username = sessions.resolve(getCookie(c, SESSION_COOKIE));
    if (username === null || username !== settings.username) {
      return c.json({ detail: msg(c, "err.unauthorized") }, 401);
    }
    c.set("username", username);
    return next();
  });

  app.use(async (c, next) => {
    c.set("settings", settings);
    c.set("sessions", sessions);
    c.set("db", db);
    return next();
  });

  app.route("/", authRouter);
  app.route("/", categoriesRouter);
  app.route("/", packagesRouter);
  app.route("/", shelvesRouter);
  app.route("/", segmentConfigRouter);
  app.route("/", progressRouter);
  app.route("/", backupRouter);

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  // 生产模式：Web 静态资源 + SPA 深链回退（资源文件名带哈希，进程内缓存即可——每请求 readFileSync 是纯浪费）
  const dist = settings.webDistDir;
  const distIndex = join(dist, "index.html");
  if (existsSync(distIndex)) {
    const indexHtml = readFileSync(distIndex, "utf-8");
    const assetCache = new Map<string, { body: Buffer; type: string }>();
    const asset = (path: string) => {
      let hit = assetCache.get(path);
      if (hit === undefined) {
        const filePath = join(dist, path.slice(1));
        if (!existsSync(filePath)) return null;
        const type = path.endsWith(".js") || path.endsWith(".mjs")
          ? "text/javascript"
          : path.endsWith(".css")
            ? "text/css"
            : "application/octet-stream";
        hit = { body: readFileSync(filePath), type };
        assetCache.set(path, hit);
      }
      return hit;
    };
    app.get("*", (c) => {
      const url = new URL(c.req.url);
      const path = url.pathname;
      if (path.startsWith("/api")) return c.json({ detail: "Not Found" }, 404);
      if (path.startsWith("/assets/")) {
        const hit = asset(path);
        if (hit === null) return c.json({ detail: "Not Found" }, 404);
        return c.body(hit.body as unknown as ReadableStream, 200, { "Content-Type": hit.type });
      }
      return c.html(indexHtml);
    });
  }

  return app;
}
