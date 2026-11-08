import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ShelvesDetail, type Stats } from "@zzlibrary/shared/client";
import { Button, PageHeader, Spinner } from "../components/ui";
import { useCategories } from "../stores/categories";

export default function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [shelvesByL1, setShelvesByL1] = useState<Record<string, ShelvesDetail>>({});
  const tree = useCategories((s) => s.tree);
  const load = useCategories((s) => s.load);

  useEffect(() => {
    load();
  }, [load]);

  // 轻统计端点（COUNT×5），不再拉 100 包列表——旧做法文件总数超过 100 包就是错的
  useEffect(() => {
    void api.stats().then(setStats).catch(() => undefined);
  }, []);

  // 概览卡：SQL 聚合计数的轻载荷（零包体零 N+1），并行拉取
  useEffect(() => {
    void Promise.all(
      tree.map((node) =>
        api
          .shelvesOverview(node.id)
          .then((r) => [node.id, r] as const)
          .catch(() => null),
      ),
    ).then((rows) => {
      setShelvesByL1(Object.fromEntries(rows.filter((r): r is [number, ShelvesDetail] => r !== null)));
    });
  }, [tree]);

  const totalPackages = stats?.packages ?? "…";
  const totalFiles = stats?.files ?? "…";

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

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
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
        stats === null ? (
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
