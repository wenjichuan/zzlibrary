/** 路由公共依赖与校验工具（自 Python deps.py 平移）。 */
import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { pstmt } from "./db";

export interface CategoryRow {
  id: number;
  uuid: string;
  level: number;
  parent_id: number | null;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function getCategory(db: DatabaseSync, cid: number | null | undefined): CategoryRow | null {
  if (cid === null || cid === undefined) return null;
  return (pstmt(db, "SELECT * FROM categories WHERE id = ?").get(cid) as CategoryRow) ?? null;
}

/** 校验并推导分类链：l3 必须属于 l2，l2 必须属于 l1；给出下级时自动补全上级。 */
export function resolveCategoryChain(
  db: DatabaseSync,
  l1Id: number | null,
  l2Id: number | null,
  l3Id: number | null,
): [number | null, number | null, number | null] {
  let l3: CategoryRow | null = null;
  let l2: CategoryRow | null = null;
  let l1: CategoryRow | null = null;
  if (l3Id !== null) {
    l3 = getCategory(db, l3Id);
    if (l3 === null || l3.level !== 3) throw new HTTPException(422, { message: "三级分类不存在" });
  }
  if (l2Id !== null || l3 !== null) {
    const effectiveL2 = l2Id !== null ? l2Id : l3 !== null ? l3.parent_id : null;
    l2 = getCategory(db, effectiveL2);
    if (l2 === null || l2.level !== 2) throw new HTTPException(422, { message: "二级分类不存在" });
    if (l3 !== null && l3.parent_id !== l2.id) {
      throw new HTTPException(422, { message: `三级分类「${l3.name}」不属于二级分类「${l2.name}」` });
    }
  }
  if (l1Id !== null || l2 !== null) {
    const effectiveL1 = l1Id !== null ? l1Id : l2!.parent_id;
    l1 = getCategory(db, effectiveL1);
    if (l1 === null || l1.level !== 1) throw new HTTPException(422, { message: "一级分类不存在" });
    if (l2 !== null && l2.parent_id !== l1.id) {
      throw new HTTPException(422, { message: `二级分类「${l2.name}」不属于一级分类「${l1.name}」` });
    }
  }
  return [l1 ? l1.id : null, l2 ? l2.id : null, l3 ? l3.id : null];
}

export interface PathIn {
  l1_id?: number | null;
  l2_id?: number | null;
  l3_id?: number | null;
}

/** 逐条校验分类路径并去重（PathIn 列表 → (l1,l2,l3) 元组列表）。 */
export function resolvePaths(db: DatabaseSync, paths: PathIn[] | null | undefined): Array<[number | null, number | null, number | null]> {
  const resolved: Array<[number | null, number | null, number | null]> = [];
  const seen = new Set<string>();
  for (const p of paths ?? []) {
    const tri = resolveCategoryChain(db, p.l1_id ?? null, p.l2_id ?? null, p.l3_id ?? null);
    if (tri[0] === null) throw new HTTPException(422, { message: "分类路径必须包含一级分类" });
    const key = tri.join("|");
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push(tri);
    }
  }
  return resolved;
}

/** 查询参数解析：数字 → (id, False)；'none' → (None, True)；缺失 → (None, False)。 */
export function parseIdFilter(raw: string | null | undefined): [number | null, boolean] {
  if (raw === null || raw === undefined || raw === "") return [null, false];
  if (raw === "none") return [null, true];
  const n = Number(raw);
  if (Number.isInteger(n) && String(n) === raw.trim()) return [n, false];
  throw new HTTPException(422, { message: `分类参数无效：${raw}` });
}
