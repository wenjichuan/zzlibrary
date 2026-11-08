import { useEffect, useState } from "react";
import { api, type CustomRange, type SegmentConfig, type SegmentConfigBundle } from "@zzlibrary/shared/client";
import { Button, Input, PageHeader, Select, Spinner } from "../components/ui";
import { useCategories } from "../stores/categories";
import { useToast } from "../stores/toast";

const MODE_LABELS: Record<string, string> = {
  year: "按年",
  n_years: "每 N 年",
  decade: "按十年",
  month: "按月",
  custom: "自定义区间",
};

export default function SegmentPage() {
  const [bundle, setBundle] = useState<SegmentConfigBundle | null>(null);
  const [globalCfg, setGlobalCfg] = useState<SegmentConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const loadCategories = useCategories((s) => s.load);
  const tree = useCategories((s) => s.tree);
  const { push } = useToast();

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const load = async () => {
    const data = await api.segmentConfig();
    setBundle(data);
    setGlobalCfg({ ...data.global, params: structuredClone(data.global.params) });
  };

  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    setLoadError(null);
    load().catch((err) => {
      const msg = err instanceof Error ? err.message : "加载失败";
      setLoadError(msg);
      push("error", msg);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryTick]);

  const saveGlobal = async () => {
    if (!globalCfg) return;
    setSaving(true);
    try {
      await api.putGlobalSegmentConfig(globalCfg);
      push("success", "全局默认已保存");
      setBundle((b) => (b ? { ...b, global: globalCfg } : b)); // 就地更新，不整包重拉
    } catch (err) {
      push("error", err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  /** 单条覆盖就地更新/删除（接口成功后本地改 bundle），不整包重拉 */
  const patchOverride = (cfg: SegmentConfig) => {
    setBundle((b) => {
      if (!b) return b;
      const key = (o: SegmentConfig) => (o.scope === "l2" ? `l2:${o.l2_id}` : `l3:${o.l3_id}`);
      const k = key(cfg);
      return { ...b, overrides: [...b.overrides.filter((o) => key(o) !== k), cfg] };
    });
  };
  const dropOverride = (scope: "l2" | "l3", id: number) => {
    setBundle((b) =>
      b ? { ...b, overrides: b.overrides.filter((o) => (scope === "l2" ? o.l2_id !== id : o.l3_id !== id)) } : b,
    );
  };

  const l2Override = new Map(
    (bundle?.overrides ?? []).filter((o) => o.scope === "l2").map((o) => [o.l2_id!, o]),
  );
  const l3Override = new Map(
    (bundle?.overrides ?? []).filter((o) => o.scope === "l3").map((o) => [o.l3_id!, o]),
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <PageHeader title="时间分段设置" />
      <p className="mb-5 text-xs leading-5 text-stone-500">
        时间分段决定书架正面「按发布时间」轴的段带划分：生效优先级 <b>三级分类覆盖 &gt; 二级分类覆盖 &gt; 全局默认</b>，
        没有设置的层级跟随上一级。各层可用不同的分期（如朝代），自定义区间支持别名（轴上显示为「1368–1644（明）」）。
        「按入库时间」轴所有层共用日历分段，不受此页设置影响。
      </p>

      {!bundle || !globalCfg ? (
        loadError !== null ? (
          <div className="flex flex-col items-center gap-3 py-16 text-sm text-stone-500">
            <div>加载失败：{loadError}</div>
            <Button variant="outline" size="sm" onClick={() => setRetryTick((t) => t + 1)}>重试</Button>
          </div>
        ) : (
          <Spinner />
        )
      ) : (
        <div className="space-y-6">
          <section className="rounded-xl border border-stone-200 bg-white p-5">
            <h3 className="mb-4 text-sm font-semibold text-stone-700">全局默认</h3>
            <ConfigEditor value={globalCfg} onChange={setGlobalCfg} />
            <div className="mt-4 flex justify-end">
              <Button onClick={() => void saveGlobal()} disabled={saving}>{saving ? "保存中…" : "保存全局默认"}</Button>
            </div>
          </section>

          <section className="rounded-xl border border-stone-200 bg-white p-5">
            <h3 className="mb-1 text-sm font-semibold text-stone-700">按分类覆盖</h3>
            <p className="mb-4 text-xs text-stone-500">
              二级分类下可再为每个三级分类单独设置（缩进行）；没有条目的层级跟随上一级。
            </p>
            {tree.length === 0 ? (
              <div className="py-6 text-center text-sm text-stone-500">还没有分类，先到「分类」页创建。</div>
            ) : (
              <div className="space-y-3">
                {tree.flatMap((l1) =>
                  l1.children.map((l2) => (
                    <div key={l2.id} className="space-y-2">
                      <ConfigRow
                        name={`${l1.name} / ${l2.name}`}
                        initial={l2Override.get(l2.id)}
                        defaultCfg={{ scope: "l2", l2_id: l2.id, l3_id: null, mode: "year", params: {} }}
                        onSave={async (cfg) => {
                          const full = { ...cfg, scope: "l2", l2_id: l2.id, l3_id: null } as SegmentConfig;
                          await api.putSegmentOverride(l2.id, full);
                          patchOverride(full);
                        }}
                        onDelete={
                          l2Override.has(l2.id)
                            ? async () => {
                                await api.deleteSegmentOverride(l2.id);
                                dropOverride("l2", l2.id);
                              }
                            : undefined
                        }
                      />
                      {l2.children.map((l3) => (
                        <div key={l3.id} className="pl-8">
                          <ConfigRow
                            name={l3.name}
                            small
                            initial={l3Override.get(l3.id)}
                            defaultCfg={{ scope: "l3", l2_id: l2.id, l3_id: l3.id, mode: "year", params: {} }}
                            onSave={async (cfg) => {
                              const full = { ...cfg, scope: "l3", l2_id: l2.id, l3_id: l3.id } as SegmentConfig;
                              await api.putL3SegmentOverride(l3.id, full);
                              patchOverride(full);
                            }}
                            onDelete={
                              l3Override.has(l3.id)
                                ? async () => {
                                    await api.deleteL3SegmentOverride(l3.id);
                                    dropOverride("l3", l3.id);
                                  }
                                : undefined
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )),
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ConfigEditor({ value, onChange }: { value: SegmentConfig; onChange: (v: SegmentConfig) => void }) {
  const params = value.params as Record<string, any>;
  const ranges: CustomRange[] = Array.isArray(params.ranges) ? params.ranges : [];

  const setParams = (patch: Record<string, unknown>) =>
    onChange({ ...value, params: { ...params, ...patch } });

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <span className="w-20 shrink-0 text-sm text-stone-600">分段方式</span>
        <Select
          className="w-full sm:w-44"
          value={value.mode}
          onChange={(e) => onChange({ ...value, mode: e.target.value, params: {} })}
        >
          {Object.entries(MODE_LABELS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </Select>
      </div>

      {value.mode === "n_years" && (
        <div className="flex items-center gap-3">
          <span className="w-20 text-sm text-stone-600">N（年）</span>
          <Input
            type="number"
            min={1}
            max={100}
            className="w-28"
            value={params.n ?? 5}
            onChange={(e) => setParams({ n: Number(e.target.value) || 5 })}
          />
        </div>
      )}

      {value.mode === "custom" && (
        <div className="space-y-2">
          <div className="text-xs text-stone-500">
            日期支持 <code className="rounded bg-stone-100 px-1">618</code> /{" "}
            <code className="rounded bg-stone-100 px-1">618-06</code> /{" "}
            <code className="rounded bg-stone-100 px-1">618-06-18</code>；只填年份时自动取 1/1~12/31。
            别名可选（如朝代、时期名）。
          </div>
          {ranges.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input
                className="w-28 flex-1 sm:w-32 sm:flex-none"
                placeholder="起始，如 581"
                value={r.start}
                onChange={(e) => {
                  const next = [...ranges];
                  next[i] = { ...r, start: e.target.value };
                  setParams({ ranges: next });
                }}
              />
              <span className="text-stone-400">→</span>
              <Input
                className="w-28 flex-1 sm:w-32 sm:flex-none"
                placeholder="截止，如 907"
                value={r.end}
                onChange={(e) => {
                  const next = [...ranges];
                  next[i] = { ...r, end: e.target.value };
                  setParams({ ranges: next });
                }}
              />
              <Input
                className="w-28 flex-1 sm:w-28 sm:flex-none"
                placeholder="别名：隋唐"
                value={r.alias ?? r.label ?? ""}
                onChange={(e) => {
                  const next = [...ranges];
                  next[i] = { ...r, alias: e.target.value, label: undefined };
                  setParams({ ranges: next });
                }}
              />
              <button
                className="rounded px-2 py-1 text-xs text-stone-400 hover:bg-red-50 hover:text-red-600"
                onClick={() => setParams({ ranges: ranges.filter((_, j) => j !== i) })}
              >
                删除
              </button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setParams({ ranges: [...ranges, { start: "", end: "", alias: "" }] })}
          >
            ＋ 添加区间
          </Button>
        </div>
      )}
    </div>
  );
}

function ConfigRow({
  name,
  small,
  initial,
  defaultCfg,
  onSave,
  onDelete,
}: {
  name: string;
  small?: boolean;
  initial: SegmentConfig | undefined;
  defaultCfg: SegmentConfig;
  onSave: (cfg: SegmentConfig) => Promise<unknown>;
  onDelete: (() => Promise<unknown>) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [cfg, setCfg] = useState<SegmentConfig>(initial ?? defaultCfg);
  const { push } = useToast();

  const save = async () => {
    try {
      await onSave({ ...cfg, params: structuredClone(cfg.params) });
      push("success", `已保存「${name}」的分段配置`);
      setEditing(false);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "保存失败");
    }
  };

  return (
    <div className={`rounded-lg border px-4 py-3 ${small ? "border-stone-100 bg-stone-50/60" : "border-stone-200"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`${small ? "text-xs" : "text-sm"} font-medium text-stone-800`}>{name}</span>
          {initial ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
              {MODE_LABELS[initial.mode] ?? initial.mode}
            </span>
          ) : (
            <span className="text-xs text-stone-400">{small ? "跟随二级/全局" : "跟随全局默认"}</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {!editing && (
            <button
              className="text-stone-500 hover:text-amber-700"
              onClick={() => {
                setCfg(structuredClone(initial ?? defaultCfg));
                setEditing(true);
              }}
            >
              {initial ? "修改" : "设置覆盖"}
            </button>
          )}
          {initial && !editing && onDelete && (
            <button
              className="text-stone-500 hover:text-red-600"
              onClick={async () => {
                try {
                  await onDelete();
                  push("success", "已删除覆盖");
                } catch (err) {
                  push("error", err instanceof Error ? err.message : "删除失败");
                }
              }}
            >
              删除覆盖
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-3 space-y-3 border-t border-stone-100 pt-3">
          <ConfigEditor value={cfg} onChange={setCfg} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>取消</Button>
            <Button size="sm" onClick={() => void save()}>保存</Button>
          </div>
        </div>
      )}
    </div>
  );
}
