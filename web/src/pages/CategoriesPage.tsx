import { useEffect, useMemo, useState } from "react";
import { api, type CategoryNode } from "@zzlibrary/shared/client";
import { Button, Input, Modal, PageHeader, Spinner } from "../components/ui";
import { flatten, useCategories } from "../stores/categories";
import { useToast } from "../stores/toast";

export default function CategoriesPage() {
  const tree = useCategories((s) => s.tree);
  const loaded = useCategories((s) => s.loaded);
  const load = useCategories((s) => s.load);
  const applyNode = useCategories((s) => s.applyNode);
  const addChild = useCategories((s) => s.addChild);
  const removeNode = useCategories((s) => s.removeNode);

  useEffect(() => {
    load();
  }, [load]);
  const [creatingUnder, setCreatingUnder] = useState<number | null | undefined>(undefined); // undefined=关闭, null=顶层
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const { push } = useToast();
  const { l1, l2 } = useMemo(() => flatten(tree), [tree]);

  const create = async () => {
    if (!newName.trim()) return;
    try {
      const node = await api.createCategory(newName.trim(), creatingUnder ?? null);
      push("success", "已创建");
      setCreatingUnder(undefined);
      setNewName("");
      addChild(creatingUnder ?? null, node); // 就地插入，不整树重拉
    } catch (err) {
      push("error", err instanceof Error ? err.message : "创建失败");
    }
  };

  const rename = async () => {
    if (!renaming || !renaming.name.trim()) return;
    try {
      const node = await api.updateCategory(renaming.id, { name: renaming.name.trim() });
      push("success", "已重命名");
      setRenaming(null);
      applyNode(node);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "重命名失败");
    }
  };

  const remove = async (node: CategoryNode) => {
    if (!window.confirm(`确定删除分类「${node.name}」？引用它的图书会变为未设置该级分类。`)) return;
    try {
      await api.deleteCategory(node.id);
      push("success", "已删除");
      removeNode(node.id);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "删除失败");
    }
  };

  const move = async (node: CategoryNode, direction: -1 | 1) => {
    try {
      const updated = await api.updateCategory(node.id, { sort_order: node.sort_order + direction * 1.5 });
      applyNode(updated);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "移动失败");
    }
  };

  const moveTo = async (node: CategoryNode, parentId: number | null) => {
    try {
      const updated = await api.updateCategory(node.id, { parent_id: parentId });
      push("success", "已移动");
      applyNode(updated);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "移动失败");
    }
  };

  const renderNode = (node: CategoryNode, depth: number) => {
    const sameLevelParents =
      node.level === 1
        ? [{ id: null, name: "（顶层）" } as const]
        : node.level === 2
          ? l1.map((p) => ({ id: p.id, name: p.name }))
          : l2.map((p) => ({ id: p.id, name: p.name }));

    // 缩进：移动端小步长（40px 封顶），桌面维持原 28px 步长
    const indentCls = ["pl-2", "pl-6 sm:pl-9", "pl-10 sm:pl-16"][depth] ?? "pl-10 sm:pl-16";
    return (
      <div key={node.id} className="zz-fade-in">
        <div className={`group flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg py-2 pr-2 hover:bg-white ${indentCls}`}>
          <span className="shrink-0 text-xs text-stone-400">{'一二三'[node.level - 1]}级</span>
          {renaming?.id === node.id ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Input
                className="min-w-0 flex-1 sm:max-w-xs"
                value={renaming.name}
                autoFocus
                onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && void rename()}
              />
              <Button size="sm" className="shrink-0" onClick={() => void rename()}>保存</Button>
              <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setRenaming(null)}>取消</Button>
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800">{node.name}</span>
          )}
          {renaming?.id !== node.id && (
            /* 窄屏 w-full：操作组整体换行到名称下方（组内再 flex-wrap），控件全部 nowrap 防中文竖折 */
            <div className="flex w-full flex-wrap items-center gap-1 text-xs sm:ml-auto sm:w-auto">
              {node.level < 3 && (
                <button className="whitespace-nowrap rounded px-2 py-1.5 text-stone-500 hover:bg-amber-50 hover:text-amber-700" onClick={() => { setCreatingUnder(node.id); setNewName(""); }}>
                  ＋子分类
                </button>
              )}
              <button className="whitespace-nowrap rounded px-2 py-1.5 text-stone-500 hover:bg-amber-50 hover:text-amber-700" onClick={() => setRenaming({ id: node.id, name: node.name })}>
                重命名
              </button>
              <button className="rounded px-2 py-1.5 text-stone-500 hover:bg-amber-50" onClick={() => void move(node, -1)} title="上移">↑</button>
              <button className="rounded px-2 py-1.5 text-stone-500 hover:bg-amber-50" onClick={() => void move(node, 1)} title="下移">↓</button>
              <select
                className="shrink-0 rounded border border-stone-200 bg-white px-1.5 py-1.5 text-xs text-stone-600"
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") return;
                  void moveTo(node, v === "top" ? null : Number(v));
                }}
              >
                <option value="">移动到…</option>
                {sameLevelParents.map((p) => (
                  <option key={p.id ?? "top"} value={p.id ?? "top"}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Button variant="danger" size="sm" className="shrink-0" onClick={() => void remove(node)}>删除</Button>
            </div>
          )}
        </div>
        {node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <PageHeader
        title="分类管理"
        actions={
          <Button onClick={() => { setCreatingUnder(null); setNewName(""); }}>＋ 新建一级分类</Button>
        }
      />

      <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-3">
        {!loaded ? (
          <Spinner />
        ) : tree.length === 0 ? (
          <div className="py-12 text-center text-sm text-stone-500">
            还没有分类。先建一个一级分类（如「技术」「文学」），图书入库时就可以选择了。
          </div>
        ) : (
          tree.map((n) => renderNode(n, 0))
        )}
      </div>

      {creatingUnder !== undefined && (
        <Modal
          title={creatingUnder === null ? "新建一级分类" : `在「${tree.flatMap(findName(creatingUnder)).join("")}」下新建子分类`}
          onClose={() => setCreatingUnder(undefined)}
        >
          <Input
            autoFocus
            placeholder="分类名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreatingUnder(undefined)}>取消</Button>
            <Button onClick={() => void create()} disabled={!newName.trim()}>创建</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function findName(id: number) {
  return function visit(node: CategoryNode): string[] {
    if (node.id === id) return [node.name];
    return node.children.flatMap(visit);
  };
}
