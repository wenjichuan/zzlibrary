import { flatten, useCategories } from "../stores/categories";
import { Select } from "./ui";

export interface CategoryValue {
  l1_id: number | null;
  l2_id: number | null;
  l3_id: number | null;
}

/** 一/二/三级级联选择：选上级自动清下级；可以只选到任意一级。 */
export default function CategoryCascade({
  value,
  onChange,
}: {
  value: CategoryValue;
  onChange: (v: CategoryValue) => void;
}) {
  const tree = useCategories((s) => s.tree);
  const { l1, l2 } = flatten(tree);

  const l1Node = l1.find((n) => n.id === value.l1_id);
  const l2Options = value.l1_id ? (l1Node?.children ?? []) : l2.filter((n) => n.parent_id === value.l1_id);
  const l2Node = l2.find((n) => n.id === value.l2_id);
  const l3Options = value.l2_id ? (l2Node?.children ?? []) : [];

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <Select
        value={value.l1_id ?? ""}
        onChange={(e) => {
          const v = e.target.value ? Number(e.target.value) : null;
          onChange({ l1_id: v, l2_id: null, l3_id: null });
        }}
      >
        <option value="">不设置</option>
        {l1.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name}
          </option>
        ))}
      </Select>
      <Select
        value={value.l2_id ?? ""}
        disabled={!value.l1_id}
        onChange={(e) => {
          const v = e.target.value ? Number(e.target.value) : null;
          onChange({ ...value, l2_id: v, l3_id: null });
        }}
      >
        <option value="">{value.l1_id ? "不设置" : "先选一级"}</option>
        {l2Options.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name}
          </option>
        ))}
      </Select>
      <Select
        value={value.l3_id ?? ""}
        disabled={!value.l2_id}
        onChange={(e) => {
          const v = e.target.value ? Number(e.target.value) : null;
          onChange({ ...value, l3_id: v });
        }}
      >
        <option value="">{value.l2_id ? "不设置" : "先选二级"}</option>
        {l3Options.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
