/** S3 实现验证：s3rver 本地模拟器（真实 HTTP + SigV4 校验）跑全动词。 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("S3 store（s3rver 真实流量）", () => {
  it("PUT/GET/HEAD/DELETE + 探针全通", async () => {
    const { default: S3rver } = await import("s3rver");
    const root = mkdtempSync(join(tmpdir(), "zzlib-s3-"));
    mkdirSync(join(root, "zzlib-test")); // directory 子目录即桶
    const s3rver = new S3rver({ directory: root, silent: true });
    const server = await s3rver.listen(0); // 随机端口；v3 的 run() 不回 http.Server
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 4568;
    try {
      const { createS3Store } = await import("@zzlibrary/core");
      const store = createS3Store({
        endpoint: `http://127.0.0.1:${port}`,
        region: "us-east-1",
        bucket: "zzlib-test",
        accessKeyId: "S3RVER",
        secretAccessKey: "S3RVER",
        prefix: "zzlibrary",
      });
      await store.probe();
      await store.putText("db/test.json", '{"ok":1}');
      expect(await store.getText("db/test.json")).toBe('{"ok":1}');
      expect(await store.head("db/test.json")).toBe(true);
      expect(await store.head("db/missing.json")).toBe(false);
      const bytes = new TextEncoder().encode("hello blob");
      await store.putBytes("blobs/ab/abc", bytes);
      const got = await store.getBytes("blobs/ab/abc");
      expect(new TextDecoder().decode(got!)).toBe("hello blob");
      await store.remove?.("db/test.json");
      expect(await store.getText("db/test.json")).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        /* Windows 句柄 */
      }
    }
  }, 20000);
});
