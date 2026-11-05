import type { Package, PackageMetaInput } from "@zzlibrary/shared";
import type { CategoryValue } from "./CategoryCascade";
import ClassificationsEditor from "./ClassificationsEditor";
import { Field, Input, Textarea } from "./ui";

/** 表单态（作者/标签用逗号分隔的字符串，便于录入；分类为多路径）。 */
export interface MetaFormValue {
  title: string;
  authors: string;
  publisher: string;
  publish_date: string;
  tags: string;
  notes: string;
  classifications: CategoryValue[];
}

export const emptyMeta: MetaFormValue = {
  title: "",
  authors: "",
  publisher: "",
  publish_date: "",
  tags: "",
  notes: "",
  classifications: [],
};

export function metaFromPackage(pkg: Package): MetaFormValue {
  return {
    title: pkg.title,
    authors: pkg.authors.join("，"),
    publisher: pkg.publisher ?? "",
    publish_date: pkg.publish_date ?? "",
    tags: pkg.tags.join("，"),
    notes: pkg.notes ?? "",
    classifications: pkg.classifications.map((p) => ({
      l1_id: p.l1?.id ?? null,
      l2_id: p.l2?.id ?? null,
      l3_id: p.l3?.id ?? null,
    })),
  };
}

export function metaToInput(v: MetaFormValue): PackageMetaInput {
  return {
    title: v.title.trim(),
    authors: splitList(v.authors),
    // 只提交选了一级的路径
    classifications: v.classifications.filter((p) => p.l1_id !== null),
    publisher: v.publisher.trim() || null,
    publish_date: v.publish_date.trim() || null,
    tags: splitList(v.tags),
    notes: v.notes.trim() || null,
  };
}

function splitList(s: string): string[] {
  return s
    .split(/[,，;；、]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 包元数据表单（不含包名，包名由外层组卡片提供）。 */
export default function PackageMetaForm({
  value,
  onChange,
  showNotes = true,
}: {
  value: MetaFormValue;
  onChange: (v: MetaFormValue) => void;
  showNotes?: boolean;
}) {
  const set = (patch: Partial<MetaFormValue>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="作者" hint="逗号分隔">
          <Input value={value.authors} onChange={(e) => set({ authors: e.target.value })} placeholder="如：刘慈欣" />
        </Field>
        <Field label="发布/发版时间" hint="前221 / YYYY / YYYY-MM / YYYY-MM-DD">
          <Input
            value={value.publish_date}
            onChange={(e) => set({ publish_date: e.target.value })}
            placeholder="如 前221、2008 或 2008-05-12"
          />
        </Field>
      </div>
      <Field label="分类路径" hint="可多条，包会出现在每个所属书架">
        <ClassificationsEditor value={value.classifications} onChange={(v) => set({ classifications: v })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="发布方">
          <Input value={value.publisher} onChange={(e) => set({ publisher: e.target.value })} />
        </Field>
        <Field label="标签" hint="逗号分隔">
          <Input value={value.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="如：会议，架构" />
        </Field>
      </div>
      {showNotes && (
        <Field label="备注">
          <Textarea value={value.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      )}
    </div>
  );
}
