/** S3 兼容对象存储客户端（手写 SigV4 签名，fetch 传输，零依赖）：
 * AWS S3 / Cloudflare R2 / MinIO / 阿里 OSS(S3 兼容) 等通用。
 * 路径风格寻址（path-style）：endpoint/bucket/key。 */
import { signAwsV4 } from "./sigv4";
import { SyncTransportError, type RemoteStore } from "./store";

export interface S3Options {
  /** 如 https://s3.amazonaws.com 或 https://<account>.r2.cloudflarestorage.com 或 http://127.0.0.1:9000 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 库根前缀，默认 zzlibrary */
  prefix?: string;
}

export function createS3Store(opts: S3Options): RemoteStore {
  const base = opts.endpoint.replace(/\/+$/, "");
  const prefix = (opts.prefix ?? "zzlibrary").replace(/^\/+|\/+$/g, "");
  const url = (path: string) =>
    `${base}/${opts.bucket}/${prefix}/${path.split("/").map(encodeURIComponent).join("/")}`;

  async function request(
    path: string,
    init: RequestInit & { method: string; body?: Uint8Array | string },
  ): Promise<Response> {
    const fullUrl = url(path);
    const body =
      typeof init.body === "string"
        ? new TextEncoder().encode(init.body)
        : (init.body ?? undefined);
    const signed = await signAwsV4({
      method: init.method,
      url: fullUrl,
      region: opts.region,
      service: "s3",
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      body,
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(signed)) headers.set(k, v);
    try {
      return await fetch(fullUrl, { method: init.method, headers, body });
    } catch (err) {
      throw new SyncTransportError(
        `网络错误：${err instanceof Error ? err.message : err}`,
        path,
      );
    }
  }

  return {
    async probe() {
      const res = await request("zzlib-probe/probe.txt", { method: "PUT", body: "ok" });
      if (res.status >= 400) throw new SyncTransportError("无法写入（检查密钥/桶权限）", "zzlib-probe/probe.txt", res.status);
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
      const res = await request(path, { method: "PUT", body: text, headers: { "content-type": "application/json" } });
      if (res.status >= 400) throw new SyncTransportError("PUT 失败", path, res.status);
    },
    async getBytes(path) {
      const res = await request(path, { method: "GET" });
      if (res.status === 404) return null;
      if (res.status >= 400) throw new SyncTransportError("GET 失败", path, res.status);
      return new Uint8Array(await res.arrayBuffer());
    },
    async putBytes(path, bytes) {
      // DOM 与 undici 两套 BodyInit 对 Uint8Array 泛型参数要求不一致（TS5.7+）；运行时两平台都接受任意 Uint8Array
      const res = await request(path, { method: "PUT", body: bytes as unknown as never });
      if (res.status >= 400) throw new SyncTransportError("PUT 失败", path, res.status);
    },
    async head(path) {
      const res = await request(path, { method: "HEAD" });
      return res.status === 200;
    },
    async remove(path) {
      const res = await request(path, { method: "DELETE" });
      if (res.status >= 400 && res.status !== 404) {
        throw new SyncTransportError("DELETE 失败", path, res.status);
      }
    },
  };
}
