import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatBytes, type StagedFile } from "@zzlibrary/shared";
import PackageMetaForm, { emptyMeta, metaToInput, type MetaFormValue } from "../components/PackageMetaForm";
import { Button, Input, PageHeader } from "../components/ui";
import { useCategories } from "../stores/categories";
import { useToast } from "../stores/toast";

/** 已暂存文件 */
interface StagedItem {
  key: string;
  staged: StagedFile | null;
  error: string | null;
}

const FORMAT_ICONS: Record<string, string> = {
  epub: "📕", pdf: "📄", txt: "📝", md: "📝", html: "🌐",
  docx: "📘", pptx: "📊", xlsx: "📊",
  mp4: "🎬", webm: "🎬", mov: "🎬", m4v: "🎬", mkv: "🎬",
  mp3: "🎵", m4a: "🎵", wav: "🎵", ogg: "🎵", flac: "🎵",
  jpg: "🖼", png: "🖼", gif: "🖼", webp: "🖼",
};

/**
 * 入库向导（一次入库一个包）：上传的**所有文件都属于同一个资料包**。
 * 流程：选/拖文件（逐个暂存+抽取元数据）→ 填包名与元数据 → 入库。
 * 放弃（移除文件/离开页面）即废弃对应暂存。
 */
export default function UploadPage() {
  const [items, setItems] = useState<StagedItem[]>([]);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false); // 用户改过包名后不再自动预填
  const [meta, setMeta] = useState<MetaFormValue>(emptyMeta);
  const [busy, setBusy] = useState(false);
  const [donePkg, setDonePkg] = useState<{ id: number; title: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // 尚未入库的暂存登记表（key → stage_id）：移除/离开页面时立即废弃
  const liveStages = useRef<Map<string, string>>(new Map());
  const metaPrefilled = useRef(false); // 元数据只用首个文件预填一次
  const { push } = useToast();
  const navigate = useNavigate();
  const loadCategories = useCategories((s) => s.load);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  // 离开页面兜底：未入库的暂存立即废弃。两条路径都覆盖——
  // SPA 路由切换（组件卸载）与整页关闭/刷新（pagehide 事件），keepalive 保证送达
  useEffect(() => {
    const discard = () => {
      const rest = [...liveStages.current.values()];
      if (rest.length) {
        void fetch("/api/packages/stage/discard", {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage_ids: rest }),
        }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", discard);
    return () => {
      window.removeEventListener("pagehide", discard);
      discard();
    };
  }, []);

  const stagedItems = items.filter((i) => i.staged);
  const uploading = items.some((i) => !i.staged && !i.error);
  const hasErrors = items.some((i) => i.error);
  const totalSize = stagedItems.reduce((acc, i) => acc + (i.staged?.size ?? 0), 0);

  // 包名预填：单文件默认文件名；用户手动编辑过则尊重输入
  useEffect(() => {
    if (titleTouched) return;
    if (stagedItems.length === 1) {
      const s = stagedItems[0].staged!;
      setTitle((s.meta.title || s.filename.replace(/\.[^.]+$/, "")).slice(0, 200));
    } else {
      setTitle("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedItems.length, titleTouched]);

  const addFiles = (files: FileList | File[]) => {
    // 立刻快照：FileList 是活的且绑定 <input>，首个文件暂存成功会触发重渲染
    // 卸载/重建 input，原 FileList 随之被清空——循环里再读就拿不到后续文件了
    const list = Array.from(files);
    const newItems: StagedItem[] = list.map((file, idx) => ({
      key: `${Date.now()}-${idx}-${file.name}`,
      staged: null,
      error: null,
    }));
    setItems((prev) => [...prev, ...newItems]);
    void (async () => {
      for (let i = 0; i < newItems.length; i++) {
        const item = newItems[i];
        const file = list[i];
        try {
          const staged = await api.stageFile(file);
          liveStages.current.set(item.key, staged.stage_id);
          setItems((prev) => prev.map((it) => (it.key === item.key ? { ...it, staged } : it)));
          // 首个文件抽取到的元数据预填表单（只做一次，避免后续文件反复覆盖用户输入）
          if (!metaPrefilled.current) {
            metaPrefilled.current = true;
            setMeta((prev) => ({
              ...prev,
              authors: staged.meta.authors.join("，"),
              publish_date: staged.meta.publish_date ?? "",
              publisher: staged.meta.publisher ?? "",
            }));
          }
        } catch (err) {
          setItems((prev) =>
            prev.map((it) =>
              it.key === item.key ? { ...it, error: err instanceof Error ? err.message : "上传失败" } : it,
            ),
          );
        }
      }
    })();
  };

  const removeItem = (key: string) => {
    const stageId = liveStages.current.get(key);
    liveStages.current.delete(key);
    if (stageId) void api.discardStages([stageId]).catch(() => {}); // 放弃即删，不等 TTL
    setItems((prev) => prev.filter((i) => i.key !== key));
  };

  const reset = () => {
    setItems([]);
    setTitle("");
    setTitleTouched(false);
    setMeta(emptyMeta);
    setDonePkg(null);
    metaPrefilled.current = false;
  };

  const commit = async () => {
    if (!title.trim()) {
      push("error", "多文件包需要命名：请填写包名");
      return;
    }
    const stageIds = stagedItems.map((i) => i.staged!.stage_id);
    if (!stageIds.length) return;
    setBusy(true);
    try {
      const pkg = await api.commitPackage(stageIds, metaToInput({ ...meta, title }));
      for (const k of stageIds) liveStages.current.delete(k);
      setDonePkg({ id: pkg.id, title: pkg.title });
      push("success", `已入库「${pkg.title}」`);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "入库失败");
    } finally {
      setBusy(false);
    }
  };

  // 拖拽区常驻且样式统一（空态不再放大）：不限格式，任意文件均可入库
  const fileDrop = (
    <div
      className={`flex h-24 flex-row items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-4 transition-colors ${
        dragOver ? "border-amber-600 bg-amber-50" : "border-stone-300 bg-white"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      <span className="text-2xl">📥</span>
      <div className="text-xs leading-5 text-stone-500">
        {items.length > 0 ? (
          <>
            继续拖拽文件到此处，或
            <button className="mx-1 text-amber-700 hover:underline" onClick={() => fileInput.current?.click()}>
              点击选择
            </button>
            ，新文件将加入本包
          </>
        ) : (
          <>
            拖拽任意文件到此处，或
            <button className="mx-1 text-amber-700 hover:underline" onClick={() => fileInput.current?.click()}>
              点击选择
            </button>
            ，本次上传的所有文件将组成<b>一个资料包</b>
          </>
        )}
      </div>
    </div>
  );

  const hiddenInput = (
    <input
      ref={fileInput}
      type="file"
      multiple
      hidden
      onChange={(e) => {
        if (e.target.files) addFiles(e.target.files);
        e.target.value = ""; // 允许重复选择同一文件（addFiles 内部已做快照）
      }}
    />
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <PageHeader
        title="入库"
        actions={
          donePkg ? (
            <Button variant="outline" onClick={reset}>
              再入一包
            </Button>
          ) : items.length > 0 ? (
            <Button
              onClick={() => void commit()}
              disabled={busy || uploading || stagedItems.length === 0 || !title.trim()}
            >
              {busy ? "入库中…" : `入库（${stagedItems.length} 个文件 · ${formatBytes(totalSize)}）`}
            </Button>
          ) : null
        }
      />

      {donePkg ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
            <div className="text-3xl">📦</div>
            <div className="mt-2 text-sm font-semibold text-emerald-800">已入库「{donePkg.title}」</div>
            <div className="mt-3 flex justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate("/packages")}>
                查看资料包列表 →
              </Button>
              <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
                去书架看看
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* 拖拽区常驻：空态/有文件同一根矮条，拖拽/点击始终可用 */}
          {fileDrop}
          {hiddenInput}

          {items.length > 0 && (
            <>
          {/* 文件清单 */}
          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="font-medium text-stone-700">
                本包文件 {stagedItems.length} 个 · {formatBytes(totalSize)}
                {uploading && <span className="ml-2 text-xs text-amber-700">正在上传/抽取元数据…</span>}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {items.map((item) => (
                <span
                  key={item.key}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${
                    item.error
                      ? "border-red-200 bg-red-50 text-red-700"
                      : item.staged
                        ? "border-stone-200 bg-stone-50 text-stone-700"
                        : "border-stone-200 bg-white text-stone-400"
                  }`}
                >
                  {item.staged
                    ? `${FORMAT_ICONS[item.staged.format] ?? "📄"} ${item.staged.filename}`
                    : item.error ?? "上传中…"}
                  <button className="ml-1 text-stone-400 hover:text-red-600" onClick={() => removeItem(item.key)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
            {hasErrors && (
              <div className="mt-2 text-xs text-red-600">有文件上传失败（网络问题），已自动忽略，可移除后重试。</div>
            )}
          </div>

          {/* 包信息（一个包，一张表单） */}
          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <div className="mb-3 text-sm font-semibold text-stone-700">资料包信息</div>
            <div className="mb-4">
              <div className="mb-1.5 text-sm font-medium text-stone-700">
                包名<span className="ml-1 text-xs font-normal text-stone-400">{stagedItems.length > 1 ? "（多文件包需命名）" : ""}</span>
              </div>
              <Input
                value={title}
                placeholder={stagedItems.length > 1 ? "如：架构评审会议" : "单文件包默认文件名，可修改"}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleTouched(true);
                }}
              />
            </div>
            <PackageMetaForm value={meta} onChange={setMeta} />
          </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
