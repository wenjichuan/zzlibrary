/** 本机备份（1.0 数据安全兜底，无云版本）：VACUUM INTO 一致性快照 + files/art 目录拷贝。
 * 目标目录由用户指定（如移动硬盘/另一块盘）；不进数据目录（防套娃备份自身）。 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Env } from "../env";

export const backupRouter = new Hono<Env>();

// 进程内单飞：并发触发只认第一个
let running = false;

/** 递归拷贝目录树（跳过 SQLite 运行时文件），返回 {文件数, 字节数}。 */
function copyTree(src: string, dest: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name.endsWith("-wal") || e.name.endsWith("-shm")) continue;
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) {
      const r = copyTree(s, d);
      files += r.files;
      bytes += r.bytes;
    } else {
      copyFileSync(s, d);
      files += 1;
      bytes += statSync(s).size;
    }
  }
  return { files, bytes };
}

backupRouter.post("/api/backup/run", async (c) => {
  if (running) throw new HTTPException(409, { message: "已有备份正在进行中，请稍候" });
  const settings = c.get("settings");
  const payload = await c.req.json<{ dest?: string }>().catch(() => ({}) as never);
  const dest = (payload?.dest ?? "").trim();
  if (!dest) throw new HTTPException(422, { message: "请填写备份目标目录" });
  const absDest = resolve(dest);
  const absData = resolve(settings.dataDir);
  if (absDest === absData || absDest.startsWith(absData + sep)) {
    throw new HTTPException(422, { message: "备份目录不能在数据目录内部" });
  }
  running = true;
  try {
    mkdirSync(absDest, { recursive: true });
    // 一致性 SQLite 快照（VACUUM INTO 要求目标不存在——先移除旧快照）
    const dbDest = join(absDest, "library.db");
    if (existsSync(dbDest)) unlinkSync(dbDest);
    c.get("db").exec(`VACUUM INTO '${dbDest.replaceAll("\\", "/").replaceAll("'", "''")}'`);
    let files = 1;
    let bytes = statSync(dbDest).size;
    for (const sub of ["files", "art"]) {
      const r = copyTree(join(absData, sub), join(absDest, sub));
      files += r.files;
      bytes += r.bytes;
    }
    return c.json({ dest: absDest, files, bytes });
  } finally {
    running = false;
  }
});
