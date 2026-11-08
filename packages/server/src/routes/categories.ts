/** 分类树管理。 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env";
import { randomUUID } from "node:crypto";
import { getCategory, type CategoryRow } from "../deps";
import { nowSqlite } from "../db";

export const categoriesRouter = new Hono<Env>();

interface CategoryOut {
  id: number;
  level: number;
  parent_id: number | null;
  name: string;
  sort_order: number;
  children: CategoryOut[];
}

function tree(db: Parameters<typeof getCategory>[0], _parentId: number | null): CategoryOut[] {
  // 一次全表读取内存建树：递归逐层查询在分类多时是每节点一条 SQL
  const all = db
    .prepare("SELECT * FROM categories ORDER BY sort_order, id")
    .all() as CategoryRow[];
  const byParent = new Map<number | null, CategoryRow[]>();
  for (const n of all) {
    const a = byParent.get(n.parent_id);
    if (a) a.push(n);
    else byParent.set(n.parent_id, [n]);
  }
  const build = (parentId: number | null): CategoryOut[] =>
    (byParent.get(parentId) ?? []).map((n) => ({
      id: n.id,
      level: n.level,
      parent_id: n.parent_id,
      name: n.name,
      sort_order: n.sort_order,
      children: build(n.id),
    }));
  return build(null);
}

categoriesRouter.get("/api/categories", (c) => c.json(tree(c.get("db"), null)));

categoriesRouter.post("/api/categories", async (c) => {
  const db = c.get("db");
  const payload = await c.req.json<{ name?: unknown; parent_id?: number | null }>().catch(() => ({}) as never);
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name || name.length > 200) throw new HTTPException(422, { message: "名称长度需在 1~200" });
  const parentId = payload.parent_id ?? null;
  const parent = getCategory(db, parentId);
  if (parentId !== null && parent === null) {
    throw new HTTPException(422, { message: "上级分类不存在" });
  }
  const level = parent ? parent.level + 1 : 1;
  if (level > 3) throw new HTTPException(422, { message: "最多支持三级分类" });
  const maxOrder = db
    .prepare(
      "SELECT sort_order FROM categories WHERE parent_id IS ? ORDER BY sort_order DESC LIMIT 1",
    )
    .get(parentId) as { sort_order: number } | undefined;
  const node = db
    .prepare("INSERT INTO categories (level, parent_id, name, sort_order, created_at, updated_at, uuid) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(level, parentId, name, maxOrder ? maxOrder.sort_order + 1 : 0, nowSqlite(), nowSqlite(), randomUUID().replaceAll("-", ""));
  const id = Number(node.lastInsertRowid);
  return c.json({ id, level, parent_id: parentId, name, sort_order: maxOrder ? maxOrder.sort_order + 1 : 0, children: [] }, 201);
});

categoriesRouter.patch("/api/categories/:cid", async (c) => {
  const db = c.get("db");
  const cid = Number(c.req.param("cid"));
  const node = getCategory(db, cid);
  if (node === null) throw new HTTPException(404, { message: "分类不存在" });
  const payload = await c.req
    .json<{ name?: string | null; sort_order?: number | null; parent_id?: number | null }>()
    .catch(() => ({}) as never);

  let name = node.name;
  let sortOrder = node.sort_order;
  let parentId = node.parent_id;

  if (payload.name !== undefined && payload.name !== null) name = payload.name.trim();
  if (payload.sort_order !== undefined && payload.sort_order !== null) sortOrder = payload.sort_order;
  if (payload.parent_id !== undefined && payload.parent_id !== null) {
    const newParent = getCategory(db, payload.parent_id);
    if (payload.parent_id !== null && newParent === null) {
      throw new HTTPException(422, { message: "目标上级分类不存在" });
    }
    const hasChildren = db
      .prepare("SELECT id FROM categories WHERE parent_id = ? LIMIT 1")
      .get(node.id);
    if (hasChildren) {
      throw new HTTPException(422, { message: "该分类包含子分类，不能移动（请先移走子分类）" });
    }
    if (newParent === null) {
      if (node.level !== 1) throw new HTTPException(422, { message: "只有一级分类可以移到顶层" });
      parentId = null;
    } else {
      if (newParent.level + 1 !== node.level) {
        throw new HTTPException(422, {
          message: `「${node.name}」是${"一二三"[node.level - 1]}级分类，只能移到同级分类之下`,
        });
      }
      if (newParent.id === node.id) throw new HTTPException(422, { message: "不能把自己作为上级" });
      parentId = newParent.id;
    }
  }
  db.prepare("UPDATE categories SET name = ?, sort_order = ?, parent_id = ?, updated_at = ? WHERE id = ?").run(
    name,
    sortOrder,
    parentId,
    nowSqlite(),
    cid,
  );
  return c.json({ id: cid, level: node.level, parent_id: parentId, name, sort_order: sortOrder });
});

categoriesRouter.delete("/api/categories/:cid", (c) => {
  const db = c.get("db");
  const cid = Number(c.req.param("cid"));
  const node = getCategory(db, cid);
  if (node === null) throw new HTTPException(404, { message: "分类不存在" });
  const hasChildren = db.prepare("SELECT id FROM categories WHERE parent_id = ? LIMIT 1").get(cid);
  if (hasChildren) throw new HTTPException(422, { message: "该分类包含子分类，请先删除子分类" });
  // 引用该分类的包路径由外键级联删除（FK ON DELETE CASCADE + PRAGMA foreign_keys=ON）
  db.prepare("DELETE FROM categories WHERE id = ?").run(cid);
  return c.json({ ok: true });
});
