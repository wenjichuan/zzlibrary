/** S3 实现验证：s3rver 本地模拟器（真实 HTTP + SigV4 校验）跑全动词 + multipart。 */
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

  it("multipart：putStream 流式分段上传 → 逐字节一致；putBytes 超阈值也走分段", async () => {
    const { default: S3rver } = await import("s3rver");
    const root = mkdtempSync(join(tmpdir(), "zzlib-s3mp-"));
    mkdirSync(join(root, "zzlib-test"));
    const s3rver = new S3rver({ directory: root, silent: true });
    const server = await s3rver.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const { createS3Store } = await import("@zzlibrary/core");
      const store = createS3Store({
        endpoint: `http://127.0.0.1:${port}`,
        region: "us-east-1",
        bucket: "zzlib-test",
        accessKeyId: "S3RVER",
        secretAccessKey: "S3RVER",
        prefix: "zzlibrary",
        multipartPartBytes: 64 * 1024, // 测试调小：300KB 流 → 5 段
      });
      // 300KB 伪随机内容（multipart 拼装错位会立刻暴露）
      const total = 300 * 1024;
      const content = new Uint8Array(total);
      for (let i = 0; i < total; i++) content[i] = (i * 31 + 7) & 0xff;
      const stream = new Blob([content]).stream() as ReadableStream<Uint8Array>;
      await store.putStream!("blobs/mp/big.bin", stream);
      const got = await store.getBytes("blobs/mp/big.bin");
      expect(got!.length).toBe(total);
      expect(got!.every((b, i) => b === content[i])).toBe(true);
      // 区间读（前缀增长流式代理依赖）
      const part = await store.getBytesRange!("blobs/mp/big.bin", 65536, 65536 + 100);
      expect(part!.length).toBe(101);
      expect(part!.every((b, i) => b === content[65536 + i])).toBe(true);
      // putBytes 超阈值 → 分段路径
      await store.putBytes("blobs/mp/big2.bin", content);
      const got2 = await store.getBytes("blobs/mp/big2.bin");
      expect(got2!.every((b, i) => b === content[i])).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        /* Windows 句柄 */
      }
    }
  }, 30000);
});
