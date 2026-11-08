/** 单账号认证：PBKDF2 口令校验（与 Python 版同格式，存量哈希直接可用）
 * + HMAC 签名会话 Cookie（自 Python itsdangerous 方案重签，切换后需重登一次）。 */
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Settings } from "./config";

export const SESSION_COOKIE = "zzlib_session";
const PBKDF2_ITERATIONS = 240_000;

/** 生成 pbkdf2 密码哈希（与 Python 版同格式）。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(Buffer.from(password, "utf-8"), salt, PBKDF2_ITERATIONS, 32, "sha256");
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString("hex")}$${digest.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const iters = Number(parts[1]);
    const saltHex = parts[2]!;
    const hashHex = parts[3]!;
    if (!Number.isFinite(iters) || !/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) {
      return false;
    }
    const digest = pbkdf2Sync(
      Buffer.from(password, "utf-8"),
      Buffer.from(saltHex, "hex"),
      iters,
      hashHex.length / 2,
      "sha256",
    );
    return timingSafeEqual(Buffer.from(digest.toString("hex")), Buffer.from(hashHex));
  }
  // 明文配置（个人局域网部署的便捷选项）
  const a = Buffer.from(password);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 会话令牌：base64url(payload) + "." + HMAC-SHA256 签名（含过期时间戳）。 */
export class SessionManager {
  private readonly key: string;
  private readonly maxAge: number;

  constructor(settings: Settings) {
    this.key = settings.effectiveSessionSecret();
    this.maxAge = settings.sessionMaxAge;
  }

  private sign(data: string): string {
    return createHmac("sha256", this.key).update(data).digest("base64url");
  }

  issue(username: string): string {
    const payload = Buffer.from(
      JSON.stringify({ u: username, exp: Math.floor(Date.now() / 1000) + this.maxAge }),
      "utf-8",
    ).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  resolve(token: string | undefined): string | null {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expect = this.sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
        u?: string;
        exp?: number;
      };
      if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
      return data.u ?? null;
    } catch {
      return null;
    }
  }

  setCookie(c: Context, username: string): void {
    setCookie(c, SESSION_COOKIE, this.issue(username), {
      maxAge: this.maxAge,
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
  }

  clearCookie(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }
}
