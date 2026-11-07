/** 前缀增长式流式伺服（大文件云端 Range 代理 + 边看边落盘）。
 *
 * 本地无字节且云端支持区间读时启用：
 * - 请求落在已缓存前缀内 → 直接读盘（拖回进度条零云端请求）
 * - 请求接续前缘（含容差空档）→ 云端拉取+转发，同时 append 进 .zzpart（前缀增长）
 * - 请求越过前缘大跳 → 纯代理转发，不落盘（防随机拖动写放大）
 * - 前缀追满全文件 → 后台流式哈希校验 → 改名上位 + local=1（观看过程即取回过程）
 *
 * .zzpart 为严格字节前缀（append-only 无空洞）：部分期间 local 保持 0（详情照常显示在云端）；
 * 释放删的是整个包目录，.zzpart 顺带清理；进程重启后 .zzpart 尺寸即前缀长度（无记账表）。
 * 云端 blob 内容寻址不可变 → 本地缓存永不过期，无失效问题。 */
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Context } from "hono";
import type { Env } from "./env";

/** 云端单次拉取块大小（内存与请求粒度的平衡） */
const CHUNK = 4 * 1024 * 1024;
/** 前缘增长容差：请求起点距前缀尾不超过该值仍按连续增长（容忍播放器小跳；env GROW_TOL 可调，测试用） */
const GROW_TOL = Number(process.env.ZZLIB_GROW_TOL ?? 4 * 1024 * 1024);
/** ≤该值的文件直接整文件取回（文档/图片/小音频），不进前缀机制（默认 8MB，env SMALL_FETCH 可调，测试用） */
export const SMALL_FILE_THRESHOLD = Number(process.env.ZZLIB_SMALL_FETCH ?? 8 * 1024 * 1024);

/** 同文件并发区间请求串行化（追加写不能交错） */
const locks = new Map<number, Promise<unknown>>();
function withLock<T>(fileId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(fileId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(fileId, next);
  return next;
}

function readSlice(path: string, start: number, len: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** 流式文件哈希（GB 级不整读进内存） */
async function sha256OfFile(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

export interface ProxyFileCtx {
  fileId: number;
  sha256: string;
  realPath: string;
  size: number;
  /** 云端区间拉取（null=不支持/失败） */
  fetchRange: (start: number, end: number) => Promise<Uint8Array | null>;
  /** 前缀追满后的上位动作（校验通过后由本模块调用：翻 local、记 blob 缓存） */
  onFinalize: () => Promise<void>;
}

/**
 * 构造流式代理响应。start/end 为闭区间；status206=true 时按 Range 语义回 206/Content-Range，
 * 否则回 200 全量语义（无 Range 头的请求）。
 */
export function serveProxiedRange(
  c: Context<Env>,
  ctx: ProxyFileCtx,
  start: number,
  end: number,
  status206: boolean,
): Response {
  const partPath = `${ctx.realPath}.zzpart`;
  let prefixLen = existsSync(partPath) ? statSync(partPath).size : 0;
  const total = ctx.size;
  // 请求在前缀内或接续前缘（含容差）→ 可增长；越前缘大跳 → 纯代理
  const grow = start <= prefixLen + GROW_TOL;
  let pos = start;
  let finalized = false;

  const maybeFinalize = () => {
    if (finalized || prefixLen < total) return;
    finalized = true;
    // 后台校验上位（不阻塞响应流收尾）
    setImmediate(() => {
      void withLock(ctx.fileId, async () => {
        if (!existsSync(partPath) || statSync(partPath).size < total) return;
        const sha = await sha256OfFile(partPath);
        if (sha === ctx.sha256) {
          renameSync(partPath, ctx.realPath);
          await ctx.onFinalize();
        } else {
          rmSync(partPath, { force: true }); // 云端/本地字节损坏 → 弃前缀回纯代理态，下次重长
        }
      }).catch((err) => console.error("前缀取回上位失败：", err instanceof Error ? err.message : err));
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      await withLock(ctx.fileId, async () => {
        if (pos > end) {
          controller.close();
          maybeFinalize();
          return;
        }
        if (pos < prefixLen) {
          // 前缀内：读盘即答
          const take = Math.min(CHUNK, end - pos + 1, prefixLen - pos);
          controller.enqueue(new Uint8Array(readSlice(partPath, pos, take)));
          pos += take;
          return;
        }
        // 云端拉取；增长模式下从 min(pos, prefixLen) 起拉（把容差空档补进前缀保持连续）
        const fetchStart = grow ? Math.min(pos, prefixLen) : pos;
        const fetchEnd = Math.min(pos + CHUNK - 1, end);
        const bytes = await ctx.fetchRange(fetchStart, fetchEnd);
        if (bytes === null || bytes.length === 0) {
          controller.error(new Error("云端区间读取失败（该远端可能不支持 Range）"));
          return;
        }
        if (grow) {
          mkdirSync(dirname(partPath), { recursive: true });
          appendFileSync(partPath, bytes);
          prefixLen = Math.min(prefixLen + bytes.length, total);
        }
        const from = pos - fetchStart;
        const slice = bytes.subarray(from, from + Math.min(end - pos + 1, bytes.length - from));
        controller.enqueue(new Uint8Array(slice));
        pos += slice.length;
        if (pos > end) {
          controller.close();
          maybeFinalize();
        }
      }).catch((err) => {
        controller.error(err instanceof Error ? err : new Error(String(err)));
      });
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": c.req.header("accept") ?? "application/octet-stream",
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
  };
  if (status206) {
    headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    return new Response(stream as never, { status: 206, headers });
  }
  return new Response(stream as never, { status: 200, headers });
}

/** 解析 Range 头（闭区间）；无头/解析失败返回 null（按 200 全量处理）。 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = m[1] === "" ? 0 : Number(m[1]);
  let end = m[2] === "" ? size - 1 : Number(m[2]);
  end = Math.min(end, size - 1);
  if (start > end || start >= size) return null;
  return { start, end };
}
