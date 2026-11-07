/** WebDAV 客户端（纯 fetch）：坚果云/NAS/Nextcloud 等通用。
 * 只依赖 PUT/GET/HEAD/DELETE/MKCOL 五个基础动词——不需要 PROPFIND 列目录
 * （两级索引设计让云端永远无需列目录，兼容性最大化）。
 * PUT 前自动逐级 MKCOL 建目录（已存在返回 405，忽略）。 */
import { SyncTransportError, type RemoteStore } from "./store";

export interface WebDavOptions {
  /** 服务根，如 https://dav.jianguoyun.com/dav/ */
  baseUrl: string;
  username?: string;
  password?: string;
  /** 库根路径（服务内），默认 zzlibrary */
  rootPath?: string;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function createWebDavStore(opts: WebDavOptions): RemoteStore {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const root = (opts.rootPath ?? "zzlibrary").replace(/^\/+|\/+$/g, "");
  const auth =
    opts.username !== undefined && opts.username !== ""
      ? `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${opts.username}:${opts.password ?? ""}`)))}`
      : undefined;

  const mkcolCache = new Set<string>();
  const url = (path: string) => `${base}/${root}/${encodePath(path)}`;

  async function request(path: string, init: RequestInit & { method: string }): Promise<Response> {
    const headers = new Headers(init.headers);
    if (auth) headers.set("authorization", auth);
    try {
      return await fetch(url(path), { ...init, headers });
    } catch (err) {
      throw new SyncTransportError(
        `网络错误：${err instanceof Error ? err.message : err}`,
        path,
      );
    }
  }

  async function ensureDirs(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop(); // 末段是文件
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (mkcolCache.has(dir) || dir === "") continue;
      const res = await request(dir, { method: "MKCOL" });
      // 201 创建 / 405 已存在 / 301 部分服务器对已存在目录返回
      if (!(res.status === 201 || res.status === 405 || res.status === 301)) {
        throw new SyncTransportError(`MKCOL ${dir} 失败`, dir, res.status);
      }
      mkcolCache.add(dir);
    }
  }

  return {
    async probe() {
      const res = await request("zzlib-probe/probe.txt", { method: "PUT", body: "ok" }).catch(() => null);
      if (res === null || res.status >= 400) {
        // 有些服务器 PUT 前需目录存在——先建目录重试一次
        if (res !== null) await ensureDirs("zzlib-probe/probe.txt");
        const retry = await request("zzlib-probe/probe.txt", { method: "PUT", body: "ok" });
        if (retry.status >= 400) throw new SyncTransportError("无法写入", "zzlib-probe/probe.txt", retry.status);
      }
      const got = await request("zzlib-probe/probe.txt", { method: "GET" });
      if (got.status >= 400 || (await got.text()) !== "ok") {
        throw new SyncTransportError("读取校验失败", "zzlib-probe/probe.txt", got.status);
      }
      await request("zzlib-probe/probe.txt", { method: "DELETE" });
    },
    async getText(path) {
      const res = await request(path, { method: "GET" });
      if (res.status === 404) return null;
      if (res.status >= 400) throw new SyncTransportError("GET 失败", path, res.status);
      return res.text();
    },
    async putText(path, text) {
      await ensureDirs(path);
      const res = await request(path, {
        method: "PUT",
        body: text,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
      if (res.status >= 400) throw new SyncTransportError("PUT 失败", path, res.status);
    },
    async getBytes(path) {
      const res = await request(path, { method: "GET" });
      if (res.status === 404) return null;
      if (res.status >= 400) throw new SyncTransportError("GET 失败", path, res.status);
      return new Uint8Array(await res.arrayBuffer());
    },
    async putBytes(path, bytes) {
      await ensureDirs(path);
      // DOM 与 undici 两套 BodyInit 对 Uint8Array 泛型参数要求不一致（TS5.7+）；运行时两平台都接受任意 Uint8Array
      const res = await request(path, { method: "PUT", body: bytes as unknown as never });
      if (res.status >= 400) throw new SyncTransportError("PUT 失败", path, res.status);
    },
    async head(path) {
      const res = await request(path, { method: "HEAD" });
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      // 个别服务器不支持 HEAD：用 1 字节 Range 探测
      if (res.status === 405 || res.status === 501) {
        const r2 = await request(path, { method: "GET", headers: { range: "bytes=0-0" } });
        if (r2.status === 206 || r2.status === 200) return true;
        return false;
      }
      return res.status >= 200 && res.status < 300;
    },
    async remove(path) {
      const res = await request(path, { method: "DELETE" });
      if (res.status >= 400 && res.status !== 404) {
        throw new SyncTransportError("DELETE 失败", path, res.status);
      }
    },
  };
}
