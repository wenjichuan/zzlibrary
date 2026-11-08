import { createHash } from "node:crypto";

/** 同步 SHA-256（node:crypto）——server 侧唯一实现，勿再各文件手写。 */
export function sha256Sync(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
