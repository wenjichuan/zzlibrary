/** AWS Signature Version 4 手写签名（WebCrypto，平台无关、零依赖）。
 * 覆盖 S3 所需子集：路径风格寻址、请求体整体哈希、可选查询串（multipart 的
 * ?uploads / ?partNumber=N&uploadId=X 等）。 */

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  type DigestInput = Parameters<typeof crypto.subtle.digest>[1];
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as unknown as DigestInput));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as Parameters<typeof crypto.subtle.importKey>[1],
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

export interface SigV4Input {
  method: string;
  /** 完整 URL（无查询串；查询经 query 参数单独传入并参与签名） */
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 请求体（无则空） */
  body?: Uint8Array;
  /** 参与签名的额外头（如 range——S3 要求请求头与签名一致；键会被小写化后按序并入） */
  extraHeaders?: Record<string, string>;
  /** 查询参数（multipart 等）：与实际请求 URL 用同一套编码，避免签名/请求不一致 */
  query?: Record<string, string>;
}

export interface SigV4Headers {
  "x-amz-date": string;
  "x-amz-content-sha256": string;
  authorization: string;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** AWS 规范 URI 编码：encodeURIComponent 之外再补 ! ' ( ) *（RFC3986 保留字符）。 */
export function awsUriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 规范查询串：键值各自编码 → 按编码后键值排序 → k=v 用 & 连接（空值保留 =）。 */
export function canonicalQueryString(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort(([ka, va], [kb, vb]) => (ka === kb ? (va < vb ? -1 : va > vb ? 1 : 0) : ka < kb ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export async function signAwsV4(input: SigV4Input): Promise<SigV4Headers> {
  const url = new URL(input.url);
  const body = input.body ?? new Uint8Array(0);
  const payloadHash = body.length === 0 ? EMPTY_SHA256 : hex(await sha256(body));

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  // 规范 URI：逐段编码（路径已按段 encodeURIComponent，这里保守再规整一次）
  const canonicalUri = url.pathname
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");

  const extras = Object.entries(input.extraHeaders ?? {}).map(
    ([k, v]) => [k.toLowerCase(), String(v).trim()] as const,
  );
  extras.sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalHeaders =
    `host:${url.host}\n` +
    extras.map(([k, v]) => `${k}:${v}\n`).join("") +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = ["host", ...extras.map(([k]) => k), "x-amz-content-sha256", "x-amz-date"].join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    input.query !== undefined ? canonicalQueryString(input.query) : "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hex(await sha256(encoder.encode(canonicalRequest))),
  ].join("\n");

  let key = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), dateStamp);
  key = await hmac(key, input.region);
  key = await hmac(key, input.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
