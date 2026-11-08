/** 应用配置：环境变量（前缀 ZZLIB_）或应用根 .env 文件（与 Python 版同名同义）。 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 本文件所在目录（源码=packages/server/src；打包产物=dist-server）
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** 应用根：① env ZZLIB_ROOT 显式指定（部署脚本/Docker/Tauri 壳统一入口）；
 * ② 打包产物（dist-server/index.js）→ 其父目录（zip 解压即跑，零配置）；
 * ③ 源码运行 → packages/server/src 上三级（仓库根，行为同旧版）。 */
export function resolveRoot(): string {
  const fromEnv = process.env.ZZLIB_ROOT;
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  if (basename(SRC_DIR) === "dist-server") return dirname(SRC_DIR);
  return resolve(SRC_DIR, "..", "..", "..");
}

export const REPO_ROOT = resolveRoot();

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const dotEnv = parseEnvFile(join(REPO_ROOT, ".env"));

function env(name: string): string | undefined {
  const key = `ZZLIB_${name.toUpperCase()}`;
  const v = process.env[key] ?? dotEnv[key];
  return v === "" ? undefined : v;
}

export class Settings {
  /** 应用根（部署布局锚点：web/dist、.env、默认 data 的基准） */
  readonly rootDir: string;
  /** 数据目录：库文件、原件、封面/书脊缓存、上传暂存 */
  readonly dataDir: string;
  /** 单账号 */
  readonly username: string;
  /** 明文或 pbkdf2$iterations$salt_hex$hash_hex 格式 */
  readonly password: string;
  readonly sessionSecret: string | null;
  readonly sessionMaxAge: number; // 秒
  /** 允许携带凭证的跨域来源（Expo 开发等），逗号分隔 */
  readonly corsOrigins: string;
  readonly port: number;

  constructor() {
    this.rootDir = env("ROOT") ?? REPO_ROOT;
    this.dataDir = env("DATA_DIR") ?? join(this.rootDir, "data");
    this.username = env("USERNAME") ?? "admin";
    this.password = env("PASSWORD") ?? "zzlibrary";
    this.sessionSecret = env("SESSION_SECRET") ?? null;
    this.sessionMaxAge = env("SESSION_MAX_AGE") ? Number(env("SESSION_MAX_AGE")) : 30 * 24 * 3600;
    this.corsOrigins = env("CORS_ORIGINS") ?? "";
    this.port = env("PORT") ? Number(env("PORT")) : Number(process.env.PORT ?? 8000);
  }

  get dbPath(): string {
    return join(this.dataDir, "library.db");
  }
  /** web 构建产物目录（服务进程静态伺服 + SPA 回退）：
   * ① env ZZLIB_WEB_DIST 显式指定；② 应用根下 web/dist（源码仓库/发布包/Docker 布局）；
   * ③ 旧行为兜底 dataDir 的上级 web/dist（自定义数据目录且 dist 在旁边的部署）。 */
  get webDistDir(): string {
    const fromEnv = env("WEB_DIST");
    if (fromEnv !== undefined) return fromEnv;
    const primary = join(this.rootDir, "web", "dist");
    if (existsSync(primary)) return primary;
    return join(this.dataDir, "..", "web", "dist");
  }
  get filesDir(): string {
    return join(this.dataDir, "files");
  }
  get artDir(): string {
    return join(this.dataDir, "art");
  }
  get stagingDir(): string {
    return join(this.dataDir, "staging");
  }

  ensureDirs(): void {
    for (const sub of ["files", "art/covers", "art/spines", "staging"]) {
      mkdirSync(join(this.dataDir, sub), { recursive: true });
    }
  }

  /** 会话签名密钥；未配置时自动生成并持久化到 data/.session_secret */
  effectiveSessionSecret(): string {
    if (this.sessionSecret) return this.sessionSecret;
    const secretFile = join(this.dataDir, ".session_secret");
    if (existsSync(secretFile)) {
      const saved = readFileSync(secretFile, "utf-8").trim();
      if (saved) return saved;
    }
    mkdirSync(this.dataDir, { recursive: true });
    const generated = randomBytes(36).toString("base64url");
    writeFileSync(secretFile, generated, "utf-8");
    return generated;
  }
}
