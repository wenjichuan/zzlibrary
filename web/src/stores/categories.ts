import { create } from "zustand";
import { api, type CategoryNode } from "@zzlibrary/shared";

interface CategoriesState {
  tree: CategoryNode[];
  loaded: boolean;
  loading: boolean;
  load: (force?: boolean) => Promise<void>;
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
    } finally {
      set({ loading: false });
    }
  },
}));

/** 扁平化：一级/二级/三级列表。 */
export function flatten(tree: CategoryNode[]) {
  const l1 = tree;
  const l2 = tree.flatMap((n) => n.children);
  const l3 = l2.flatMap((n) => n.children);
  return { l1, l2, l3 };
}
