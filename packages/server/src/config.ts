/** 应用配置：环境变量（前缀 ZZLIB_）或仓库根 .env 文件（与 Python 版同名同义）。 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根 = packages/server/src → 上三级
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SRC_DIR, "..", "..", "..");

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
  /** 流式代理阈值：本地无字节且大于该值且云端支持区间读 → 前缀增长流式伺服；否则整文件取回 */
  readonly smallFetchThreshold: number;
  /** 单次同步的哈希回填字节预算：防止「5000 个 2GB 视频」把同步绑在一小时哈希上；新文件优先 */
  readonly hashBudgetBytes: number;

  constructor() {
    this.dataDir = env("DATA_DIR") ?? join(REPO_ROOT, "data");
    this.username = env("USERNAME") ?? "admin";
    this.password = env("PASSWORD") ?? "zzlibrary";
    this.sessionSecret = env("SESSION_SECRET") ?? null;
    this.sessionMaxAge = env("SESSION_MAX_AGE") ? Number(env("SESSION_MAX_AGE")) : 30 * 24 * 3600;
    this.corsOrigins = env("CORS_ORIGINS") ?? "";
    this.port = env("PORT") ? Number(env("PORT")) : Number(process.env.PORT ?? 8000);
    this.smallFetchThreshold = env("SMALL_FETCH") ? Number(env("SMALL_FETCH")) : 8 * 1024 * 1024;
    this.hashBudgetBytes = env("HASH_BUDGET_MB") ? Number(env("HASH_BUDGET_MB")) * 1024 * 1024 : 2 * 1024 * 1024 * 1024;
  }

  get dbPath(): string {
    return join(this.dataDir, "library.db");
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
