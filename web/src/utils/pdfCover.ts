/** PDF 首页封面客户端渲染（入库即带封面 + 存量补齐共用）：
 * 无服务端原生依赖，CP2/CP3（WebView）天然复用同一套。 */
import { api } from "@zzlibrary/shared/client";

export async function renderPdfCover(file: Blob | ArrayBuffer): Promise<Blob | null> {
  try {
    const pdfjs = await import("pdfjs-dist");
    const workerMod = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default;
    const data = file instanceof Blob ? await file.arrayBuffer() : file;
    const doc = await pdfjs.getDocument({ data }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = 480 / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    // 只传 canvasContext（v6 的 canvas 参数走依赖合成器帧的新管线，无帧环境会挂起；阅读器同款路径）
    await page.render({ canvasContext: ctx, viewport } as never).promise;
    // toDataURL 同步编码（toBlob 的回调与 rAF 同族：无合成器帧的环境会挂起）
    const dataUrl = canvas.toDataURL("image/png");
    const bin = atob(dataUrl.split(",")[1] ?? "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  } catch {
    return null;
  }
}

/** 拉取文件字节并渲染首页封面（存量补齐用）。 */
export async function renderPdfCoverFromFile(fileId: number): Promise<Blob | null> {
  try {
    const resp = await fetch(api.fileUrl(fileId), { credentials: "include" });
    if (!resp.ok) return null;
    return await renderPdfCover(await resp.arrayBuffer());
  } catch {
    return null;
  }
}
