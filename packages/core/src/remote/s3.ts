/** S3 兼容对象存储客户端（手写 SigV4 签名，fetch 传输，零依赖）：
 * AWS S3 / Cloudflare R2 / MinIO / 阿里 OSS(S3 兼容) 等通用。
 * 路径风格寻址（path-style）：endpoint/bucket/key。
 * 传输走 fetchWithRetry（429/502/503/504 指数退避 + Retry-After）；
 * putStream 走 multipart 分段（流式，大文件不整读进内存，绕开单 PUT 5GB 硬墙）。 */
import { signAwsV4, awsUriEncode } from "./sigv4";
import { fetchWithRetry } from "./retry";
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
  /** multipart 分段大小（默认 16MB；S3 下限 5MB；测试可调小验证分段路径） */
  multipartPartBytes?: number;
}

const DEFAULT_PART_BYTES = 16 * 1024 * 1024;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function createS3Store(opts: S3Options): RemoteStore {
  const base = opts.endpoint.replace(/\/+$/, "");
  const prefix = (opts.prefix ?? "zzlibrary").replace(/^\/+|\/+$/g, "");
  const partBytes = opts.multipartPartBytes ?? DEFAULT_PART_BYTES;
  const url = (path: string, query?: Record<string, string>) =>
    `${base}/${opts.bucket}/${prefix}/${path.split("/").map(encodeURIComponent).join("/")}` +
    (query !== undefined && Object.keys(query).length > 0
      ? `?${Object.entries(query).map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join("&")}`
      : "");

  async function request(
    path: string,
    init: RequestInit & { method: string; body?: Uint8Array | string; query?: Record<string, string> },
  ): Promise<Response> {
    const fullUrl = url(path, init.query);
    const body =
      typeof init.body === "string"
        ? new TextEncoder().encode(init.body)
        : (init.body ?? undefined);
    // 额外头（如 range）并入签名——S3 要求签名与实际请求头一致。
    // 同时接受 Headers 实例与普通对象（getBytesRange 传的是普通对象——历史 bug：
    // 只认 Headers 实例导致 range 头从未被签名也从未发出，S3 区间读静默失效）。
    const extraHeaders: Record<string, string> = {};
    if (init.headers instanceof Headers) {
      for (const [k, v] of init.headers.entries()) extraHeaders[k] = v;
    } else if (init.headers !== undefined) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        extraHeaders[k.toLowerCase()] = v;
      }
    }
    const signed = await signAwsV4({
      method: init.method,
      url: fullUrl,
      region: opts.region,
      service: "s3",
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      body,
      extraHeaders,
      query: init.query,
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(signed)) headers.set(k, v);
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    try {
      return await fetchWithRetry(fullUrl, { method: init.method, headers, body });
    } catch (err) {
      throw new SyncTransportError(
        `网络错误：${err instanceof Error ? err.message : err}`,
        path,
      );
    }
  }

  // ---------- multipart 原语 ----------

  async function createMultipartUpload(path: string): Promise<string> {
    const res = await request(path, { method: "POST", query: { uploads: "" } });
    if (res.status >= 300) throw new SyncTransportError("CreateMultipartUpload 失败", path, res.status);
    const xml = await res.text();
    const m = /<UploadId>([^<]+)<\/UploadId>/.exec(xml);
    if (m === null) throw new SyncTransportError("CreateMultipartUpload 响应异常", path, res.status);
    return m[1]!;
  }

  async function uploadPart(path: string, uploadId: string, n: number, part: Uint8Array): Promise<string> {
    const res = await request(path, {
      method: "PUT",
      body: part as unknown as never,
      query: { partNumber: String(n), uploadId },
    });
    if (res.status >= 300) throw new SyncTransportError(`UploadPart#${n} 失败`, path, res.status);
    await res.body?.cancel().catch(() => undefined);
    return res.headers.get("etag") ?? "";
  }

  async function completeMultipartUpload(
    path: string,
    uploadId: string,
    parts: Array<{ n: number; etag: string }>,
  ): Promise<void> {
    const xml =
      `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const res = await request(path, {
      method: "POST",
      body: xml,
      headers: { "content-type": "application/xml" },
      query: { uploadId },
    });
    if (res.status >= 300) {
      throw new SyncTransportError("CompleteMultipartUpload 失败", path, res.status);
    }
    await res.body?.cancel().catch(() => undefined);
  }

  async function abortMultipartUpload(path: string, uploadId: string): Promise<void> {
    try {
      const res = await request(path, { method: "DELETE", query: { uploadId } });
      await res.body?.cancel().catch(() => undefined);
    } catch {
      /* 尽力而为：孤儿分段由对象存储生命周期策略兜底 */
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
    async getBytesRange(path, start, end) {
      const res = await request(path, { method: "GET", headers: { range: `bytes=${start}-${end}` } });
      if (res.status === 404) return null;
      if (res.status !== 206) {
        await res.body?.cancel().catch(() => undefined);
        return null; // 不支持区间读 → 调用方回退整取
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return bytes.length > end - start + 1 ? bytes.subarray(0, end - start + 1) : bytes;
    },
    async putBytes(path, bytes) {
      // DOM 与 undici 两套 BodyInit 对 Uint8Array 泛型参数要求不一致（TS5.7+）；运行时两平台都接受任意 Uint8Array
      if (bytes.length <= partBytes) {
        const res = await request(path, { method: "PUT", body: bytes as unknown as never });
        if (res.status >= 400) throw new SyncTransportError("PUT 失败", path, res.status);
        return;
      }
      // 缓冲路径的超大 blob 也走 multipart（分段上传，签名逐段）
      const uploadId = await createMultipartUpload(path);
      try {
        const parts: Array<{ n: number; etag: string }> = [];
        for (let off = 0, n = 1; off < bytes.length; off += partBytes, n += 1) {
          const etag = await uploadPart(path, uploadId, n, bytes.subarray(off, Math.min(off + partBytes, bytes.length)));
          parts.push({ n, etag });
        }
        await completeMultipartUpload(path, uploadId, parts);
      } catch (err) {
        await abortMultipartUpload(path, uploadId);
        throw err;
      }
    },
    async putStream(path, source) {
      const reader = source.getReader();
      let pending: Uint8Array | null = null; // 未满一段的缓冲（内存中同时最多约一段）
      let uploadId: string | null = null;
      const parts: Array<{ n: number; etag: string }> = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending = pending === null ? value : concatBytes(pending, value);
          while (pending !== null && pending.length >= partBytes) {
            uploadId ??= await createMultipartUpload(path);
            const n = parts.length + 1;
            const etag = await uploadPart(path, uploadId, n, pending.subarray(0, partBytes));
            parts.push({ n, etag });
            pending = pending.length > partBytes ? pending.subarray(partBytes) : null;
          }
        }
        if (parts.length === 0) {
          // 全程不足一段 → 单 PUT（小封面/小文档零额外请求）
          const whole = pending ?? new Uint8Array(0);
          const res = await request(path, { method: "PUT", body: whole as unknown as never });
          if (res.status >= 400) throw new SyncTransportError("PUT 失败", path, res.status);
          return;
        }
        if (pending !== null && pending.length > 0) {
          const n = parts.length + 1; // 尾段允许小于分段下限
          const etag = await uploadPart(path, uploadId!, n, pending);
          parts.push({ n, etag });
        }
        await completeMultipartUpload(path, uploadId!, parts);
      } catch (err) {
        if (uploadId !== null) await abortMultipartUpload(path, uploadId);
        throw err;
      }
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
