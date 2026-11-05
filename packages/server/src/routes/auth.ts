/** 认证：单账号登录/登出/会话查询。 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env";
import { verifyPassword } from "../security";

export const authRouter = new Hono<Env>();

authRouter.post("/api/auth/login", async (c) => {
  const payload = await c.req.json<{ username?: string; password?: string }>().catch(() => ({}) as never);
  const username = payload.username ?? "";
  const password = payload.password ?? "";
  const settings = c.get("settings");
  if (username !== settings.username || !verifyPassword(password, settings.password)) {
    throw new HTTPException(401, { message: "用户名或密码错误" });
  }
  c.get("sessions").setCookie(c, username);
  return c.json({ username });
});

authRouter.post("/api/auth/logout", (c) => {
  c.get("sessions").clearCookie(c);
  return c.json({ ok: true });
});

authRouter.get("/api/auth/me", (c) => {
  return c.json({ username: c.get("username") });
});
