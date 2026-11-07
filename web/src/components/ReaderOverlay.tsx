/** 全屏阅读器：包详情点文件进入。
 * EPUB=foliate-js（CFI 定位）· PDF=pdfjs-dist（页码）· TXT/MD/HTML/docx=文档渲染 ·
 * 图片/音频/视频=原生（播放百分比）。进度节流写回 PUT /api/progress，关闭时冲刷。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { formatKind, isReadableFormat } from "@zzlibrary/core";
import { api } from "@zzlibrary/shared/client";
import type { FileDetail, PackageDetail, Progress } from "@zzlibrary/shared/client";

const DOC_CSS = `<style>
body{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
max-width:42em;margin:2rem auto;padding:0 1rem;line-height:1.9;color:#292524;font-size:17px}
img{max-width:100%;height:auto}pre{overflow-x:auto;background:#f5f5f4;padding:12px 16px;border-radius:10px;font-size:14px}
code{background:#f5f5f4;padding:2px 6px;border-radius:6px;font-size:0.9em}
h1,h2,h3{line-height:1.4}table{border-collapse:collapse}td,th{border:1px solid #e7e5e4;padding:6px 10px}
a{color:#b45309}blockquote{border-left:3px solid #d6d3d1;margin:1em 0;padding-left:1em;color:#57534e}
</style>`;

interface ReaderProps {
  pkgTitle: string;
  file: FileDetail;
  initialProgress: Progress | null;
  onClose: () => void;
  /** 进度变化（已节流） */
  onProgress: (percent: number) => void;
}

export default function ReaderOverlay({ pkgTitle, file, initialProgress, onClose, onProgress }: ReaderProps) {
  const [percent, setPercent] = useState(Math.round(initialProgress?.percent ?? 0));
  const [showToc, setShowToc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const percentRef = useRef(percent);
  percentRef.current = percent;

  // 节流写进度（3s）+ 关闭冲刷
  const pendingRef = useRef<{ locator: Record<string, unknown>; percent: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  const save = useCallback((locator: Record<string, unknown>, pct: number) => {
    pendingRef.current = { locator, percent: pct };
    setPercent(pct);
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const p = pendingRef.current;
      if (p !== null) {
        pendingRef.current = null;
        void api.putProgress(file.id, p.locator, p.percent).catch(() => undefined);
      }
    }, 3000);
  }, [file.id]);
  /** 立即冲刷挂起的进度并等写回完成——显式关闭（返回/Esc）走这里，保证 onClose 后（父级刷新列表）看到的已是重算后的状态 */
  const flushNow = useCallback(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const p = pendingRef.current;
    if (p !== null) {
      pendingRef.current = null;
      await api.putProgress(file.id, p.locator, p.percent).catch(() => undefined);
    }
  }, [file.id]);
  useEffect(() => {
    const flush = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const p = pendingRef.current;
      if (p !== null) {
        pendingRef.current = null;
        void fetch(`/api/progress/${file.id}`, {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          keepalive: true,
          body: JSON.stringify({ locator: p.locator, percent: p.percent }),
        }).catch(() => undefined);
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
      onProgress(percentRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  const resetProgress = async () => {
    await api.deleteProgress(file.id).catch(() => undefined);
    pendingRef.current = null;
    setPercent(0);
    onProgress(0);
  };

  // 关闭 = 先冲刷进度写回，再回调（父级在 onClose 里刷新列表，必须看到重算后的状态）
  const requestClose = useCallback(async () => {
    await flushNow();
    onClose();
  }, [flushNow, onClose]);
  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-stone-100">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4">
        <button className="rounded-lg px-2 py-1 text-stone-500 hover:bg-stone-100 hover:text-stone-800" onClick={() => void requestClose()} title="返回（Esc）">
          ← 返回
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-stone-800" title={file.name}>{file.name}</div>
          <div className="truncate text-xs text-stone-400">{pkgTitle}</div>
        </div>
        {initialProgress !== null && (
          <button className="rounded-lg px-2 py-1 text-xs text-stone-400 hover:bg-stone-100 hover:text-red-600" onClick={() => void resetProgress()}>
            重置进度
          </button>
        )}
        <span className="w-12 text-right text-xs tabular-nums text-stone-400">{percent}%</span>
      </header>

      <div className="relative min-h-0 flex-1">
        {error !== null ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-red-600">{error}</div>
        ) : (
          <>
            {(file.format === "epub") && <EpubReader file={file} initialProgress={initialProgress} onProgress={save} onToc={setShowToc} showToc={showToc} setError={setError} />}
            {(file.format === "pdf") && <PdfReader file={file} initialProgress={initialProgress} onProgress={save} setError={setError} />}
            {(file.format === "txt") && <TextReader file={file} initialProgress={initialProgress} onProgress={save} setError={setError} />}
            {(file.format === "md" || file.format === "html" || file.format === "docx") && (
              <DocReader file={file} initialProgress={initialProgress} onProgress={save} setError={setError} />
            )}
            {formatKind(file.format) === "image" && (
              <div className="flex h-full items-center justify-center p-4">
                <img src={api.fileUrl(file.id)} alt={file.name} className="max-h-full max-w-full object-contain" />
              </div>
            )}
            {formatKind(file.format) === "audio" && (
              <MediaReader file={file} initialProgress={initialProgress} onProgress={save} kind="audio" />
            )}
            {formatKind(file.format) === "video" && (
              <MediaReader file={file} initialProgress={initialProgress} onProgress={save} kind="video" />
            )}
            {!isReadableFormat(file.format) && (
              <div className="flex h-full items-center justify-center text-sm text-stone-400">
                该格式（{file.format.toUpperCase()}）不支持内置阅读，可在详情页下载原图
              </div>
            )}
          </>
        )}
      </div>

      <footer className="flex h-1.5 shrink-0 bg-stone-200">
        <div className="bg-amber-700 transition-all" style={{ width: `${percent}%` }} />
      </footer>
    </div>
  );
}

// ---------- EPUB（foliate-js） ----------

function EpubReader({
  file, initialProgress, onProgress, showToc, onToc, setError,
}: {
  file: FileDetail; initialProgress: Progress | null;
  onProgress: (locator: Record<string, unknown>, percent: number) => void;
  showToc: boolean; onToc: (v: boolean) => void; setError: (e: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<{ next: () => void; prev: () => void; goTo: (t: unknown) => Promise<void>; close: () => void } | null>(null);
  const [toc, setToc] = useState<Array<{ label: string; href: string; depth: number }>>([]);
  const [fontSize, setFontSize] = useState(17);

  useEffect(() => {
    let view: (HTMLElement & Record<string, unknown>) | null = null;
    let dead = false;
    void (async () => {
      try {
        const { makeBook } = await import("foliate-js/view.js");
        const v = document.createElement("foliate-view") as unknown as HTMLElement & Record<string, unknown>;
        v.style.height = "100%";
        v.style.fontSize = "17px";
        hostRef.current?.appendChild(v);
        view = v;
        viewRef.current = v as never;
        const resp = await fetch(api.fileUrl(file.id), { credentials: "include" });
        if (!resp.ok) throw new Error(`取回文件失败（${resp.status}）`);
        const blob = await resp.blob();
        const bookFile = new File([blob], file.name, { type: blob.type || "application/epub+zip" });
        const book = await makeBook(bookFile);
        if (dead) return;
        v.addEventListener("relocate", ((e: CustomEvent) => {
          const d = e.detail as { cfi?: string; fraction?: number };
          if (typeof d.cfi === "string") onProgress({ cfi: d.cfi }, Math.round((d.fraction ?? 0) * 100));
        }) as EventListener);
        await (v.open as (b: unknown) => Promise<void>)(book);
        const cfi = initialProgress?.locator?.cfi;
        await (v.init as (o: { lastLocation: string | null; showTextStart: boolean }) => Promise<void>)({
          lastLocation: typeof cfi === "string" ? cfi : null,
          showTextStart: true,
        });
        const flat: Array<{ label: string; href: string; depth: number }> = [];
        const walk = (items: Array<{ label?: string; href?: string; subarray?: unknown[] }>, depth: number) => {
          for (const it of items) {
            if (it.label && it.href) flat.push({ label: it.label, href: it.href, depth });
            const sub = it.subarray;
            if (Array.isArray(sub)) walk(sub as never, depth + 1);
          }
        };
        const bookToc = (book as { toc?: unknown[] }).toc;
        if (Array.isArray(bookToc)) walk(bookToc as never, 0);
        setToc(flat);
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : "打开 EPUB 失败");
      }
    })();
    return () => {
      dead = true;
      try {
        (view?.close as (() => void) | undefined)?.();
      } catch {
        /* ignore */
      }
      view?.remove();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  // 键盘翻页 + 目录按钮挂到 header 的桥（简化：目录开关由父级渲染按钮，这里渲染面板）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") viewRef.current?.next();
      if (e.key === "ArrowLeft" || e.key === "PageUp") viewRef.current?.prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 字号
  useEffect(() => {
    const el = hostRef.current?.querySelector("foliate-view");
    if (el !== null && el !== undefined) (el as HTMLElement).style.fontSize = `${fontSize}px`;
  }, [fontSize]);

  return (
    <>
      <div ref={hostRef} className="h-full" />
      {/* 工具条 */}
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-stone-200 bg-white/95 px-2 py-1 shadow-lg">
        <button className="rounded-full px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-100" onClick={() => viewRef.current?.prev()} title="上一页（←）">←</button>
        {toc.length > 0 && (
          <button className="rounded-full px-3 py-1 text-sm text-stone-600 hover:bg-stone-100" onClick={() => onToc(!showToc)}>目录</button>
        )}
        <button className="rounded-full px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-100" onClick={() => setFontSize((s) => Math.max(12, s - 1))} title="缩小">A−</button>
        <span className="w-8 text-center text-xs tabular-nums text-stone-400">{fontSize}</span>
        <button className="rounded-full px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-100" onClick={() => setFontSize((s) => Math.min(28, s + 1))} title="放大">A+</button>
        <button className="rounded-full px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-100" onClick={() => viewRef.current?.next()} title="下一页（→）">→</button>
      </div>
      {showToc && (
        <div className="absolute inset-y-0 left-0 w-72 overflow-y-auto border-r border-stone-200 bg-white p-3 shadow-xl">
          <div className="mb-2 text-sm font-semibold text-stone-700">目录</div>
          {toc.map((item, i) => (
            <button
              key={`${item.href}-${i}`}
              className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-stone-600 hover:bg-stone-100"
              style={{ paddingLeft: `${8 + item.depth * 16}px` }}
              onClick={() => {
                onToc(false);
                void viewRef.current?.goTo(item.href);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---------- PDF（pdfjs-dist） ----------

function PdfReader({
  file, initialProgress, onProgress, setError,
}: {
  file: FileDetail; initialProgress: Progress | null;
  onProgress: (locator: Record<string, unknown>, percent: number) => void;
  setError: (e: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [docState, setDocState] = useState<{ page: number; numPages: number; scale: number } | null>(null);
  const docRef = useRef<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const workerMod = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default;
        const doc = await pdfjs.getDocument({ url: api.fileUrl(file.id), withCredentials: true }).promise;
        if (dead) return;
        docRef.current = doc as never;
        const startPage = typeof initialProgress?.locator?.page === "number" ? initialProgress.locator.page : 1;
        setDocState({ page: Math.min(Math.max(1, startPage), doc.numPages), numPages: doc.numPages, scale: 1 });
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : "打开 PDF 失败");
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  const { page, numPages, scale } = docState ?? { page: 0, numPages: 0, scale: 1 };

  useEffect(() => {
    if (page === 0 || docRef.current === null) return;
    let dead = false;
    void (async () => {
      const doc = docRef.current!;
      const p = (await doc.getPage(page)) as {
        getViewport: (o: { scale: number }) => { width: number; height: number };
        render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
      };
      if (dead || canvasRef.current === null || wrapRef.current === null) return;
      const canvas = canvasRef.current;
      const wrapW = wrapRef.current.clientWidth - 32;
      const base = p.getViewport({ scale: 1 });
      const fit = wrapW / base.width;
      const viewport = p.getViewport({ scale: fit * scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext("2d")!;
      await p.render({ canvasContext: ctx, viewport }).promise;
    })();
    return () => {
      dead = true;
    };
  }, [page, scale]);

  useEffect(() => {
    if (numPages > 0) onProgress({ page }, Math.round((page / numPages) * 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, numPages]);

  const turn = useCallback((delta: number) => {
    setDocState((s) => {
      if (s === null) return s;
      const np = Math.min(Math.max(1, s.page + delta), s.numPages);
      return np === s.page ? s : { ...s, page: np };
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") turn(1);
      if (e.key === "ArrowLeft" || e.key === "PageUp") turn(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn]);

  if (page === 0) return <div className="flex h-full items-center justify-center text-sm text-stone-400">PDF 载入中…</div>;
  return (
    <>
      <div ref={wrapRef} className="h-full overflow-auto p-4">
        <canvas ref={canvasRef} className="mx-auto rounded-lg bg-white shadow" />
      </div>
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-stone-200 bg-white/95 px-2 py-1 shadow-lg">
        <button className="rounded-full px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-100" onClick={() => turn(-1)} title="上一页（←）">←</button>
        <span className="px-1 text-xs tabular-nums text-stone-500">{page} / {numPages}</span>
        <button className="rounded-full px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-100" onClick={() => turn(1)} title="下一页（→）">→</button>
        <span className="mx-1 h-4 w-px bg-stone-200" />
        <button className="rounded-full px-2 py-1 text-sm text-stone-600 hover:bg-stone-100" onClick={() => setDocState((s) => s && { ...s, scale: Math.max(0.5, s.scale - 0.2) })}>−</button>
        <span className="w-10 text-center text-xs tabular-nums text-stone-400">{Math.round(scale * 100)}%</span>
        <button className="rounded-full px-2 py-1 text-sm text-stone-600 hover:bg-stone-100" onClick={() => setDocState((s) => s && { ...s, scale: Math.min(3, s.scale + 0.2) })}>＋</button>
      </div>
    </>
  );
}

// ---------- TXT ----------

async function fetchText(file: FileDetail): Promise<string> {
  const buf = await (await fetch(api.fileUrl(file.id), { credentials: "include" })).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let label = "utf-8";
  try {
    const jschardet = await import("jschardet");
    const guess = jschardet.detect(bytes.subarray(0, 64 * 1024));
    if (guess !== null && typeof guess.encoding === "string" && guess.confidence > 0.5) label = guess.encoding.toLowerCase();
  } catch {
    /* 默认 utf-8 */
  }
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function TextReader({
  file, initialProgress, onProgress, setError,
}: {
  file: FileDetail; initialProgress: Progress | null;
  onProgress: (locator: Record<string, unknown>, percent: number) => void;
  setError: (e: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const reportedRef = useRef(-1);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const text = await fetchText(file);
        if (dead) return;
        const el = ref.current;
        if (el === null) return;
        // 注意：只往专用容器追加节点，绝不碰 React 管理的兄弟节点（textContent 会连 React 子女一起抹掉 → 卸载时 removeChild 崩树）
        el.replaceChildren();
        const paragraphs = text.split(/\r?\n/);
        const frag = document.createDocumentFragment();
        let buf: string[] = [];
        // 按空行分段（连续行合并），大文件靠 content-visibility 跳过屏外渲染
        for (let i = 0; i < paragraphs.length; i++) {
          buf.push(paragraphs[i]!);
          if (paragraphs[i] === "" || i === paragraphs.length - 1) {
            const p = document.createElement("p");
            p.textContent = buf.join("\n").trimEnd();
            p.style.cssText = "content-visibility:auto;contain-intrinsic-size:auto 1.8em;white-space:pre-wrap;margin:0 0 1em";
            frag.appendChild(p);
            buf = [];
          }
        }
        el.appendChild(frag);
        const startPct = typeof initialProgress?.locator?.scroll === "number" ? initialProgress.locator.scroll : 0;
        if (startPct > 0) setTimeout(() => {
          el.scrollTop = (el.scrollHeight - el.clientHeight) * (startPct / 100);
        }, 0);
        setReady(true);
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : "打开文本失败");
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  useEffect(() => {
    if (!ready) return;
    const el = ref.current?.parentElement;
    if (el === null || el === undefined) return;
    // scroll 事件本身已随滚动节流，直接计算（rAF 在无合成器帧的环境会挂起：IAB 自动化/低端 WebView）
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      const pct = max <= 0 ? 100 : Math.min(100, Math.round((el.scrollTop / max) * 100));
      if (pct !== reportedRef.current) {
        reportedRef.current = pct;
        onProgress({ scroll: pct }, pct);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // 一屏即整读：无滚动距离时打开即 100%——滚动事件永远不会发生，不补这条短文永不记进度
    if (el.scrollHeight - el.clientHeight <= 0) onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      {!ready && <div className="text-center text-sm text-stone-400">载入中…</div>}
      <div ref={ref} className={ready ? "min-h-full" : "hidden"} />
    </div>
  );
}

// ---------- MD / HTML / DOCX（沙箱 iframe） ----------

function DocReader({
  file, initialProgress, onProgress, setError,
}: {
  file: FileDetail; initialProgress: Progress | null;
  onProgress: (locator: Record<string, unknown>, percent: number) => void;
  setError: (e: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const reportedRef = useRef(-1);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        let html: string;
        if (file.format === "md") {
          const text = await fetchText(file);
          const { marked } = await import("marked");
          html = await marked.parse(text);
        } else if (file.format === "docx") {
          const buf = await (await fetch(api.fileUrl(file.id), { credentials: "include" })).arrayBuffer();
          const mammoth = await import("mammoth");
          const result = await mammoth.convertToHtml({ arrayBuffer: buf });
          html = result.value;
        } else {
          html = await fetchText(file);
        }
        if (dead) return;
        const iframe = document.createElement("iframe");
        // allow-same-origin（不含 allow-scripts）：脚本/弹窗照旧全禁；开同源仅为父级可量内容高度，让滚动与进度由外层容器接管
        iframe.setAttribute("sandbox", "allow-same-origin");
        iframe.style.cssText = "width:100%;border:0;background:#fafaf9;display:block";
        iframe.srcdoc = DOC_CSS + html;
        const measure = () => {
          try {
            const d = iframe.contentDocument;
            if (d?.body) {
              const h = Math.max(d.body.scrollHeight, d.documentElement?.scrollHeight ?? 0);
              if (h > 0) iframe.style.height = `${h}px`;
            }
          } catch {
            /* 不可达：同源沙箱 */
          }
        };
        const startPct = typeof initialProgress?.locator?.scroll === "number" ? initialProgress.locator.scroll : 0;
        iframe.addEventListener("load", () => {
          measure();
          setTimeout(measure, 500); // 图片/字体后到时再校一次高度
          const wrap = wrapRef.current;
          if (wrap && wrap.scrollHeight - wrap.clientHeight <= 0) {
            // 一屏即整读：无滚动距离时打开即 100%（须在 measure 之后判定——iframe 高度未定前 wrap 无滚动距离）
            reportedRef.current = 100;
            onProgress({ scroll: 100 }, 100);
          } else if (startPct > 0 && wrap) {
            wrap.scrollTop = (wrap.scrollHeight - wrap.clientHeight) * (startPct / 100);
          }
        });
        boxRef.current?.appendChild(iframe);
        setReady(true);
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : "打开文档失败");
      }
    })();
    return () => {
      dead = true;
      boxRef.current?.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  // 进度：外层容器滚动百分比（iframe 高度=内容高、内部不滚），与 TextReader 同一套直算
  useEffect(() => {
    if (!ready) return;
    const el = wrapRef.current;
    if (el === null || el === undefined) return;
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      const pct = max <= 0 ? 100 : Math.min(100, Math.round((el.scrollTop / max) * 100));
      if (pct !== reportedRef.current) {
        reportedRef.current = pct;
        onProgress({ scroll: pct }, pct);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div ref={wrapRef} className="h-full overflow-y-auto bg-stone-50">
      {!ready && <div className="text-center text-sm text-stone-400">载入中…</div>}
      <div ref={boxRef} className={ready ? "min-h-full" : "hidden"} />
    </div>
  );
}

// ---------- 媒体 ----------

function MediaReader({
  file, initialProgress, onProgress, kind,
}: {
  file: FileDetail; initialProgress: Progress | null;
  onProgress: (locator: Record<string, unknown>, percent: number) => void;
  kind: "audio" | "video";
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const t = typeof initialProgress?.locator?.time === "number" ? initialProgress.locator.time : null;
    if (t !== null) {
      el.addEventListener("loadedmetadata", () => {
        if (el.duration > 0 && t <= el.duration) el.currentTime = t;
      }, { once: true });
    }
    const onTime = () => {
      if (el.duration > 0) onProgress({ time: Math.round(el.currentTime) }, Math.round((el.currentTime / el.duration) * 100));
    };
    el.addEventListener("timeupdate", onTime);
    return () => el.removeEventListener("timeupdate", onTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);
  return (
    <div className="flex h-full items-center justify-center bg-black/90 p-4">
      {kind === "video" ? (
        <video ref={ref} src={api.fileUrl(file.id)} controls autoPlay className="max-h-full max-w-full" />
      ) : (
        <audio ref={ref} src={api.fileUrl(file.id)} controls autoPlay className="w-full max-w-lg" />
      )}
    </div>
  );
}

/** 阅读器装配（两个详情面板共用的唯一接线）：打开状态 + 关闭冲刷/刷新回调一致。
 * refresh 在进度写回后被调用（如刷新详情、就地补丁列表行）。 */
export function useReaderOverlay(
  detail: PackageDetail | null,
  refresh: (packageId: number) => Promise<unknown>,
) {
  const [reading, setReading] = useState<FileDetail | null>(null);
  const readerNode =
    reading !== null && detail !== null ? (
      <ReaderOverlay
        pkgTitle={detail.title}
        file={reading}
        initialProgress={reading.progress}
        onClose={() => setReading(null)}
        onProgress={() => void refresh(detail.id)}
      />
    ) : null;
  return { openReader: setReading, readerNode };
}
