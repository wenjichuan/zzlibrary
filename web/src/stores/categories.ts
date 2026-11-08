import { create } from "zustand";
import { api, type CategoryNode } from "@zzlibrary/shared/client";

interface CategoriesState {
  tree: CategoryNode[];
  loaded: boolean;
  loading: boolean;
  load: (force?: boolean) => Promise<void>;
  /** 单点变更就地更新（接口已返回最新节点），不整树重拉 */
  applyNode: (updated: CategoryNode) => void;
  addChild: (parentId: number | null, node: CategoryNode) => void;
  removeNode: (id: number) => void;
}

function sortSiblings(nodes: CategoryNode[]): CategoryNode[] {
  return [...nodes].sort((a, b) => a.sort_order - b.sort_order);
}
function insertNode(tree: CategoryNode[], parentId: number | null, node: CategoryNode): CategoryNode[] {
  if (parentId === null) return sortSiblings([...tree, node]);
  return tree.map((n) =>
    n.id === parentId
      ? { ...n, children: sortSiblings([...n.children, node]) }
      : { ...n, children: insertNode(n.children, parentId, node) },
  );
}
function removeById(tree: CategoryNode[], id: number): CategoryNode[] {
  return tree
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, children: removeById(n.children, id) }));
}
function findNode(tree: CategoryNode[], id: number): CategoryNode | undefined {
  for (const n of tree) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

export const useCategories = create<CategoriesState>((set, get) => ({
  tree: [],
  loaded: false,
  loading: false,
  load: async (force) => {
    if (get().loading) return;
    if (get().loaded && !force) return;
    set({ loading: true });
    try {
      const tree = await api.categories();
      set({ tree, loaded: true });
    } catch (err) {
      console.error("分类树加载失败", err); // 不再向上冒泡成 unhandled rejection；页面态保持可重试
    } finally {
      set({ loading: false });
    }
  },
  applyNode: (updated) =>
    set((s) => {
      const existing = findNode(s.tree, updated.id);
      // 保留当前子树（服务端禁止带子分类的节点移动，改名/排序场景子树不变）
      const merged: CategoryNode = { ...updated, children: existing?.children ?? updated.children ?? [] };
      return { tree: insertNode(removeById(s.tree, updated.id), merged.parent_id, merged) };
    }),
  addChild: (parentId, node) => set((s) => ({ tree: insertNode(s.tree, parentId, node) })),
  removeNode: (id) => set((s) => ({ tree: removeById(s.tree, id) })),
}));

/** 扁平化：一级/二级列表（三级无消费方，不再计算）。 */
export function flatten(tree: CategoryNode[]) {
  const l1 = tree;
  const l2 = tree.flatMap((n) => n.children);
  return { l1, l2 };
}
