import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

/** 同步 SHA-256（node:crypto）——server 侧唯一实现，勿再各文件手写。 */
export function sha256Sync(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 同步流式文件哈希：1MB 块定点读，不整读进内存（阻塞事件循环——仅供兜底路径，
 * 正常入库的哈希在 stage 流式写盘时已增量算好）。 */
export function sha256FileSync(abs: string): string {
  const h = createHash("sha256");
  const fd = openSync(abs, "r");
  const buf = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}
