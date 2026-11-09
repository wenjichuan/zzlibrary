export * from "./types";
/** fetch API 客户端：同源 + 会话 Cookie。 */
import type {
  BackupReport,
  CategoryNode,
  FileDetail,
  PackageDetail,
  PackageMetaInput,
  PackagePage,
  Progress,
  SegmentConfig,
  SegmentConfigBundle,
  ShelvesDetail,
  Stats,
  StagedFile,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  headers.set("Accept-Language", acceptLanguage()); // 界面选择的语言下发给服务端消息协商
  const resp = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });
  if (resp.status === 401 && !path.includes("/auth/")) {
    window.dispatchEvent(new CustomEvent("zzlib:unauthorized"));
  }
  if (!resp.ok) {
    let detail = fallbackMessage(resp.status);
    try {
      const body = await resp.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (Array.isArray(body?.detail)) detail = body.detail.map((d: any) => d?.msg).filter(Boolean).join("; ") || detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(resp.status, detail);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

/** 服务端错误消息的语言协商：读界面持久化的语言偏好（无则空，浏览器同源请求自带 Accept-Language）。 */
function acceptLanguage(): string {
  try {
    return localStorage.getItem("zzlib:lang") ?? "";
  } catch {
    return "";
  }
}

/** 响应体不可读（网关 502/连接中断等）时的兜底串：跟随界面语言（存了偏好用偏好，否则按浏览器语言）。 */
function fallbackMessage(status: number): string {
  let zh = true;
  try {
    const saved = localStorage.getItem("zzlib:lang");
    zh = saved === "en" ? false : saved === "zh" ? true : (navigator.language ?? "zh").toLowerCase().startsWith("zh");
  } catch {
    /* 受限环境保持 zh（与服务端缺省一致） */
  }
  return zh ? `请求失败（${status}）` : `Request failed (${status})`;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return "";
  return "?" + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

export const api = {
  // auth
  login: (username: string, password: string) =>
    request<{ username: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ username: string }>("/api/auth/me"),

  // categories
  categories: () => request<CategoryNode[]>("/api/categories"),
  createCategory: (name: string, parentId: number | null) =>
    request<CategoryNode>("/api/categories", { method: "POST", body: JSON.stringify({ name, parent_id: parentId }) }),
  updateCategory: (id: number, patch: { name?: string; sort_order?: number; parent_id?: number | null }) =>
    request<CategoryNode>(`/api/categories/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteCategory: (id: number) => request<{ ok: boolean }>(`/api/categories/${id}`, { method: "DELETE" }),

  // packages
  listPackages: (params: {
    l1?: string; l2?: string; l3?: string; q?: string; format?: string; status?: string;
    undated?: string; sort?: string; page?: number; page_size?: number;
  }, signal?: AbortSignal) =>
    request<PackagePage>(`/api/packages${qs(params)}`, signal ? { signal } : undefined),
  getPackage: (id: number) => request<PackageDetail>(`/api/packages/${id}`),
  updatePackage: (id: number, patch: Partial<PackageMetaInput>) =>
    request<PackageDetail>(`/api/packages/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePackage: (id: number) => request<{ ok: boolean }>(`/api/packages/${id}`, { method: "DELETE" }),
  stageFile: (file: File, cover?: Blob | null) => {
    const form = new FormData();
    form.append("file", file);
    if (cover !== null && cover !== undefined) form.append("cover", cover, "cover.png");
    return request<StagedFile>("/api/packages/stage", { method: "POST", body: form });
  },
  /** 主动废弃暂存（放弃入库/移除文件时立即删除，不等 24h TTL）。 */
  discardStages: (stageIds: string[]) =>
    request<{ ok: boolean; removed: number }>("/api/packages/stage/discard", {
      method: "POST",
      body: JSON.stringify({ stage_ids: stageIds }),
    }),
  commitPackage: (stageIds: string[], meta: PackageMetaInput) =>
    request<PackageDetail>("/api/packages", { method: "POST", body: JSON.stringify({ stage_ids: stageIds, meta }) }),
  // 包内文件管理
  addPackageFile: (packageId: number, stageId: string) =>
    request<FileDetail>(`/api/packages/${packageId}/files`, { method: "POST", body: JSON.stringify({ stage_id: stageId }) }),
  /** 批量文件编辑（一次请求完成移除+新增；返回最新详情） */
  applyPackageFiles: (packageId: number, removeIds: number[], addStageIds: string[]) =>
    request<PackageDetail>(`/api/packages/${packageId}/files/batch`, {
      method: "POST",
      body: JSON.stringify({ remove_ids: removeIds, add_stage_ids: addStageIds }),
    }),
  updatePackageFile: (packageId: number, fileId: number, patch: { name?: string; sort_order?: number }) =>
    request<FileDetail>(`/api/packages/${packageId}/files/${fileId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePackageFile: (packageId: number, fileId: number) =>
    request<{ ok: boolean }>(`/api/packages/${packageId}/files/${fileId}`, { method: "DELETE" }),

  // 资产 URL
  stageCoverUrl: (stageId: string) => `/api/packages/stage/${stageId}/cover`,
  packageCoverUrl: (id: number) => `/api/packages/${id}/cover`,
  packageSpineUrl: (id: number) => `/api/packages/${id}/spine`,
  fileCoverUrl: (fileId: number) => `/api/files/${fileId}/cover`,
  fileUrl: (fileId: number) => `/api/files/${fileId}/file`,

  // shelves
  shelvesOverview: (l1: number) => request<ShelvesDetail>(`/api/shelves/${l1}/overview`),
  shelfRack: (l1: number, l2: string) => request<ShelvesDetail>(`/api/shelves/${l1}/rack?l2=${encodeURIComponent(l2)}`),
  stats: () => request<Stats>("/api/stats"),

  // segment config（全局默认 + 二级覆盖 + 三级覆盖）
  segmentConfig: () => request<SegmentConfigBundle>("/api/segment-config"),
  putGlobalSegmentConfig: (cfg: SegmentConfig) =>
    request<SegmentConfig>("/api/segment-config", { method: "PUT", body: JSON.stringify(cfg) }),
  putSegmentOverride: (l2Id: number, cfg: SegmentConfig) =>
    request<SegmentConfig>(`/api/segment-config/${l2Id}`, { method: "PUT", body: JSON.stringify(cfg) }),
  deleteSegmentOverride: (l2Id: number) =>
    request<{ ok: boolean }>(`/api/segment-config/${l2Id}`, { method: "DELETE" }),
  putL3SegmentOverride: (l3Id: number, cfg: SegmentConfig) =>
    request<SegmentConfig>(`/api/segment-config/l3/${l3Id}`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),
  deleteL3SegmentOverride: (l3Id: number) =>
    request<{ ok: boolean }>(`/api/segment-config/l3/${l3Id}`, { method: "DELETE" }),

  // progress（按文件）
  getProgress: (fileId: number) => request<Progress | null>(`/api/progress/${fileId}`),
  putProgress: (fileId: number, locator: Record<string, unknown>, percent: number) =>
    request<Progress>(`/api/progress/${fileId}`, { method: "PUT", body: JSON.stringify({ locator, percent }) }),
  deleteProgress: (fileId: number) =>
    request<{ ok: boolean }>(`/api/progress/${fileId}`, { method: "DELETE" }),

  // 维护与备份
  /** 整库备份到本机目录（VACUUM INTO 快照 + files/art 拷贝）。 */
  backupLibrary: (dest: string) =>
    request<BackupReport>("/api/backup/run", { method: "POST", body: JSON.stringify({ dest }) }),
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
