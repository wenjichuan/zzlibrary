/** 传输重试层：限流/瞬时故障退避（stub HTTP 服务器真实流量）。 */
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchWithRetry } from "./retry";

function startServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

describe("传输重试 fetchWithRetry", () => {
  it("503×2 → 200：退避后成功", async () => {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${port}/x`, { method: "GET" }, { baseDelayMs: 10 });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(hits).toBe(3);
    } finally {
      server.close();
    }
  });

  it("429 带 Retry-After:0：重试耗尽返回最后一次响应（调用方处置）", async () => {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(429, { "retry-after": "0" });
      res.end();
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${port}/x`, {}, { attempts: 2, baseDelayMs: 10 });
      expect(res.status).toBe(429);
      expect(hits).toBe(2);
    } finally {
      server.close();
    }
  });

  it("非重试状态（404）不重试", async () => {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(404);
      res.end();
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${port}/x`, {}, { attempts: 3, baseDelayMs: 10 });
      expect(res.status).toBe(404);
      expect(hits).toBe(1);
    } finally {
      server.close();
    }
  });

  it("网络异常（拒连）重试后抛错", async () => {
    await expect(
      fetchWithRetry("http://127.0.0.1:1/x", {}, { attempts: 2, baseDelayMs: 10 }),
    ).rejects.toThrow();
  });
});
