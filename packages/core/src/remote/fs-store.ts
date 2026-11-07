/** 本地目录实现的远端存储（node:fs）：全量本地测试与桌面端单机模拟用。
 * 目录结构即云端结构（library.json / db/ / blobs/）。 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, unlinkSync, openSync, readSync, closeSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { SyncTransportError, type RemoteStore } from "./store";

export function createFsStore(rootDir: string): RemoteStore {
  const abs = (path: string) => join(rootDir, ...path.split("/"));
  const ensureParent = (path: string) => mkdirSync(dirname(abs(path)), { recursive: true });

  return {
    async probe() {
      ensureParent("zzlib-probe/probe.txt");
      writeFileSync(abs("zzlib-probe/probe.txt"), "ok", "utf-8");
      const read = readFileSync(abs("zzlib-probe/probe.txt"), "utf-8");
      if (read !== "ok") throw new SyncTransportError("探针读写不一致", "zzlib-probe/probe.txt");
      unlinkSync(abs("zzlib-probe/probe.txt"));
    },
    async getText(path) {
      try {
        return readFileSync(abs(path), "utf-8");
      } catch {
        return null;
      }
    },
    async putText(path, text) {
      try {
        ensureParent(path);
        writeFileSync(abs(path), text, "utf-8");
      } catch (err) {
        throw new SyncTransportError(`写入失败：${err instanceof Error ? err.message : err}`, path);
      }
    },
    async getBytes(path) {
      try {
        return new Uint8Array(readFileSync(abs(path)));
      } catch {
        return null;
      }
    },
    async getBytesRange(path, start, end) {
      const fd = openSync(abs(path), "r");
      try {
        const len = end - start + 1;
        const buf = Buffer.alloc(len);
        let read = 0;
        while (read < len) {
          const n = readSync(fd, buf, read, len - read, start + read);
          if (n <= 0) break;
          read += n;
        }
        return new Uint8Array(buf.subarray(0, read));
      } catch {
        return null;
      } finally {
        closeSync(fd);
      }
    },
    async putBytes(path, bytes) {
      try {
        ensureParent(path);
        writeFileSync(abs(path), bytes);
      } catch (err) {
        throw new SyncTransportError(`写入失败：${err instanceof Error ? err.message : err}`, path);
      }
    },
    async putStream(path, source) {
      ensureParent(path);
      const ws = createWriteStream(abs(path));
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!ws.write(value)) {
            await new Promise<void>((resolve, reject) => {
              ws.once("drain", resolve);
              ws.once("error", reject);
            });
          }
        }
        await new Promise<void>((resolve, reject) => {
          ws.once("error", reject);
          ws.end(resolve);
        });
      } catch (err) {
        ws.destroy();
        await reader.cancel().catch(() => undefined);
        throw new SyncTransportError(`流式写入失败：${err instanceof Error ? err.message : err}`, path);
      }
    },
    async head(path) {
      try {
        return statSync(abs(path)).isFile();
      } catch {
        return false;
      }
    },
    async remove(path) {
      try {
        rmSync(abs(path), { force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}
