import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PackagePage, type ShelvesOut } from "@zzlibrary/shared";
import { Button, PageHeader, Spinner } from "../components/ui";
import { useCategories } from "../stores/categories";

export default function HomePage() {
  const [pkgs, setPkgs] = useState<PackagePage | null>(null);
  const [shelvesByL1, setShelvesByL1] = useState<Record<string, ShelvesOut>>({});
  const tree = useCategories((s) => s.tree);
  const load = useCategories((s) => s.load);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    void api.listPackages({ page: 1, page_size: 100 }).then(setPkgs);
  }, []);

  useEffect(() => {
    void (async () => {
      const result: Record<string, ShelvesOut> = {};
      for (const node of tree) {
        try {
          result[node.id] = await api.shelves(node.id);
        } catch {
          /* ignore */
        }
      }
      setShelvesByL1(result);
    })();
  }, [tree]);

  const totalPackages = pkgs?.total ?? 0;
  const totalFiles = pkgs?.items.reduce((acc, p) => acc + p.file_count, 0) ?? 0;

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <PageHeader
        title="馆藏"
        actions={
          <Link to="/upload">
            <Button>＋ 入库</Button>
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-4 gap-4">
        <StatCard icon="📦" label="资料包" value={totalPackages} />
        <StatCard icon="🗂" label="文件总数" value={totalFiles} />
        <StatCard icon="🏷" label="一级分类" value={tree.length} />
        <StatCard
          icon="🔖"
          label="二级分类"
          value={tree.reduce((acc, n) => acc + n.children.length, 0)}
        />
      </div>

      {tree.length === 0 ? (
        pkgs === null ? (
          <Spinner />
        ) : (
          <div className="rounded-xl border border-stone-200 bg-white p-8 text-center">
            <div className="text-4xl">🏛</div>
            <div className="mt-2 text-sm font-medium text-stone-700">欢迎来到你的个人资料库</div>
            <ol className="mx-auto mt-3 max-w-md list-decimal space-y-1 pl-6 text-left text-xs leading-6 text-stone-600">
              <li>到「分类」页建立一/二/三级分类（也可以先跳过，入库后再整理）</li>
              <li>到「入库」页上传文件——多个文件（如录屏+PPT+纪要）可合并为一个「资料包」</li>
              <li>需要按年/十年/自定义区间切层时，在「时间分段」页配置</li>
            </ol>
          </div>
        )
      ) : (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-stone-700">一级分类概览</h2>
          {tree.map((node) => {
            const shelves = shelvesByL1[String(node.id)];
            const l2Count = node.children.length;
            return (
              <Link
                key={node.id}
                to={`/shelves/${node.id}`}
                className="flex items-center justify-between rounded-xl border border-stone-200 bg-white px-5 py-4 transition-shadow hover:shadow-md"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xl">🏛</span>
                  <div>
                    <div className="text-sm font-semibold text-stone-800">{node.name}</div>
                    <div className="text-xs text-stone-500">{l2Count} 个二级分类</div>
                  </div>
                </div>
                <div className="flex items-center gap-6 text-sm">
                  <div className="text-right">
                    <div className="font-semibold text-amber-800">{shelves?.total ?? "…"}</div>
                    <div className="text-xs text-stone-400">资料包</div>
                  </div>
                  {shelves && (
                    <div className="hidden gap-1.5 md:flex">
                      {shelves.groups.slice(0, 3).map((g, i) => (
                        <span key={i} className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">
                          {g.l2?.name ?? "未分类"} · {g.total}
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="text-stone-400">进入书架 →</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: string; label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex items-center gap-2 text-xs text-stone-500">
        <span>{icon}</span>
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-stone-800">{value}</div>
    </div>
  );
}
