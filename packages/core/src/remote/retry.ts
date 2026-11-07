/** 传输层重试（WebDAV/S3 共用）：限流与瞬时故障的指数退避。
 *
 * 重试条件：网络异常（fetch 抛错）或 429/502/503/504；其余状态原样返回由调用方处置。
 * 退避：500ms × 3^n + 抖动；服务端 Retry-After（秒数或 HTTP 日期）优先，封顶 30s。
 * PUT 幂等性：本库写路径全部内容寻址（同键必同字节），重复 PUT 无害；
 * SigV4 签名含时间戳但允许 ±15 分钟时钟偏移，数秒退避内重签不必要、原签名仍有效。 */

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 4 */
  attempts?: number;
  /** 退避基数毫秒，默认 500 */
  baseDelayMs?: number;
}

const RETRYABLE = new Set([429, 502, 503, 504]);

function backoffMs(attempt: number, retryAfter: string | null, base: number): number {
  if (retryAfter !== null && retryAfter !== "") {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 30_000);
    const d = Date.parse(retryAfter);
    if (Number.isFinite(d)) return Math.min(Math.max(d - Date.now(), 0), 30_000);
  }
  return base * 3 ** attempt + Math.random() * 250;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** fetch + 限流/瞬时故障退避重试。请求体须可重放（Uint8Array/string，非流）。 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 500;
  for (let i = 0; ; i++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(backoffMs(i, null, base));
      continue;
    }
    if (!RETRYABLE.has(res.status) || i === attempts - 1) return res;
    // 消费掉本次响应体再退避（连接归还池）
    await res.body?.cancel().catch(() => undefined);
    await sleep(backoffMs(i, res.headers.get("retry-after"), base));
  }
}
