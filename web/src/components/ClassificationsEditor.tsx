import CategoryCascade, { type CategoryValue } from "./CategoryCascade";

/** 多条分类路径编辑器：每行一个级联选择，可增删。 */
export default function ClassificationsEditor({
  value,
  onChange,
}: {
  value: CategoryValue[];
  onChange: (v: CategoryValue[]) => void;
}) {
  const update = (i: number, v: CategoryValue) =>
    onChange(value.map((row, idx) => (idx === i ? v : row)));

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <div className="rounded-lg border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-400">
          未分类（可添加分类路径，包会出现在每个所属书架上）
        </div>
      )}
      {value.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-xs text-stone-400">路径{i + 1}</span>
          <div className="min-w-0 flex-1">
            <CategoryCascade value={row} onChange={(v) => update(i, v)} />
          </div>
          <button
            className="shrink-0 rounded p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600"
            title="删除此路径"
            onClick={() => onChange(value.filter((_, idx) => idx !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="rounded-lg border border-dashed border-stone-300 px-3 py-1.5 text-xs text-stone-600 transition-colors hover:border-amber-600 hover:text-amber-800"
        onClick={() => onChange([...value, { l1_id: null, l2_id: null, l3_id: null }])}
      >
        ＋ 添加分类路径
      </button>
    </div>
  );
}
