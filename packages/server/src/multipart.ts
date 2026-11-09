/** 流式 multipart/form-data 解析（零依赖、二进制安全）：大文件上传不再整读进内存。
 *
 * 逐块扫描边界，内容经 onChunk 顺序回调（await 背压天然成立——慢消费者暂停读取）；
 * 处理跨块的边界串（尾部保留策略）；支持多 part、per-part filename/content-type、
 * 结束边界 --boundary--。仅供 stage 上传端点使用（浏览器/undici 生成的规范格式）。 */
import { HTTPException } from "hono/http-exception";

export interface MultipartSink {
  /** part 头解析完毕（此后该 part 的内容块经 onChunk 到来） */
  onPartHeader(info: { name: string; filename?: string; contentType?: string }): Promise<void> | void;
  onChunk(bytes: Uint8Array): Promise<void> | void;
  onPartEnd(): Promise<void> | void;
}

/** 从 content-type 提取 boundary。 */
export function boundaryOf(contentType: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  return m === null ? null : (m[1] ?? m[2] ?? null);
}

const HEADER_CAP = 16 * 1024; // part 头上限（防畸形请求耗内存）

/** 文件名解码：part 头整体按 latin1 匹配捕获，但浏览器/undici 均以 UTF-8 原始字节
 * 下发 filename=，需按 UTF-8 还原（latin1 捕获是字节 1:1 映射，无损可逆；ASCII 原样）。 */
function utf8Filename(s: string): string {
  return /[^\x00-\x7f]/.test(s) ? Buffer.from(s, "latin1").toString("utf8") : s;
}

export async function streamMultipart(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  sink: MultipartSink,
): Promise<void> {
  const boundary = boundaryOf(contentType);
  if (boundary === null || boundary === "") throw new HTTPException(400, { message: "err.multipartBoundary" });
  const dashBoundary = Buffer.from(`--${boundary}`);
  const crlfDashBoundary = Buffer.from(`\r\n--${boundary}`);
  const CRLF = Buffer.from("\r\n");
  const reader = body.getReader();
  let buf = Buffer.alloc(0);
  // preamble=找首个边界；after=边界后定界（--结束 / \r\n 接头）；headers=part 头；body=内容
  let state: "preamble" | "after" | "headers" | "body" = "preamble";
  let headerBytes: Buffer = Buffer.alloc(0);
  let inPart = false;

  const emitHeaders = async (): Promise<void> => {
    const text = headerBytes.toString("latin1");
    headerBytes = Buffer.alloc(0);
    const nameM = /name="([^"]*)"/.exec(text);
    const fileStarM = /filename\*=(?:utf-8|UTF-8)''([^;\r\n]+)/.exec(text);
    const fileM = /filename="([^"]*)"/.exec(text);
    const ctM = /content-type:\s*([^\r\n]+)/i.exec(text);
    await sink.onPartHeader({
      name: nameM === null ? "" : nameM[1]!,
      // filename*=（RFC 5987 百分号编码）优先于 filename=
      filename:
        fileStarM !== null
          ? decodeURIComponent(fileStarM[1]!)
          : fileM === null
            ? undefined
            : utf8Filename(fileM[1]!),
      contentType: ctM === null ? undefined : ctM[1]!.trim(),
    });
    inPart = true;
  };

  const endPart = async (): Promise<void> => {
    if (inPart) await sink.onPartEnd();
    inPart = false;
  };

  read: for (;;) {
    // 状态机推进：buf 不足以判定时跳出等下一块
    for (;;) {
      if (state === "preamble") {
        const i = buf.indexOf(dashBoundary);
        if (i < 0) {
          // 只保留可能是边界前缀的尾部
          const hold = Math.min(buf.length, dashBoundary.length);
          buf = buf.subarray(buf.length - hold);
          break;
        }
        buf = buf.subarray(i + dashBoundary.length);
        state = "after";
        continue;
      }
      if (state === "after") {
        if (buf.length < 2) break;
        if (buf[0] === 0x2d && buf[1] === 0x2d) break read; // "--"：全部结束
        if (buf[0] === 0x0d && buf[1] === 0x0a) {
          buf = buf.subarray(2);
          state = "headers";
          continue;
        }
        throw new HTTPException(400, { message: "err.multipartMalformed" });
      }
      if (state === "headers") {
        const i = buf.indexOf(Buffer.concat([CRLF, CRLF]));
        if (i < 0) {
          headerBytes = Buffer.concat([headerBytes, buf]);
          if (headerBytes.length > HEADER_CAP) throw new HTTPException(413, { message: "err.multipartHeaderCap" });
          buf = Buffer.alloc(0);
          break;
        }
        headerBytes = Buffer.concat([headerBytes, buf.subarray(0, i)]);
        if (headerBytes.length > HEADER_CAP) throw new HTTPException(413, { message: "err.multipartHeaderCap" });
        buf = buf.subarray(i + 4);
        await emitHeaders();
        state = "body";
        continue;
      }
      // state === "body"：内容直到 \r\n--boundary
      const i = buf.indexOf(crlfDashBoundary);
      if (i < 0) {
        // 尾部保留可能与下块拼成边界串；不足边界长的全留
        const hold = Math.min(buf.length, crlfDashBoundary.length - 1);
        if (buf.length - hold > 0) {
          await sink.onChunk(buf.subarray(0, buf.length - hold));
        }
        buf = buf.subarray(buf.length - hold);
        break;
      }
      if (i > 0) await sink.onChunk(buf.subarray(0, i));
      buf = buf.subarray(i + crlfDashBoundary.length);
      await endPart();
      state = "after";
      continue;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf = buf.length === 0 ? Buffer.from(value) : Buffer.concat([buf, Buffer.from(value)]);
  }
  if (inPart) throw new HTTPException(400, { message: "err.multipartTruncated" });
  await reader.cancel().catch(() => undefined);
}
