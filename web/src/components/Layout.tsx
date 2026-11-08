import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../stores/auth";

const NAV = [
  { to: "/", label: "馆藏", icon: "🏛", end: true },
  { to: "/packages", label: "资料包", icon: "📦" },
  { to: "/upload", label: "入库", icon: "📥" },
  { to: "/categories", label: "分类", icon: "🗂" },
  { to: "/segments", label: "时间分段", icon: "🕰" },
  { to: "/settings", label: "设置", icon: "⚙" },
];

/** 应用外壳：桌面（≥md）= 常驻侧栏；小屏 = 顶栏汉堡 + 抽屉侧栏（背板点击/导航/路由变化关闭）。 */
export default function Layout({ children }: { children: React.ReactNode }) {
  const username = useAuth((s) => s.username);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 路由变化即关抽屉（点导航项/浏览器返回都覆盖）
  useEffect(() => {
    setDrawerOpen(false);
  }, [location]);

  // Esc 关抽屉
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* 小屏顶栏：汉堡 + 品牌（刘海安全区） */}
      <header className="flex items-center gap-3 bg-stone-800 px-4 pb-2 text-stone-100 [padding-top:max(0.5rem,env(safe-area-inset-top))] md:hidden">
        <button
          aria-label="打开导航"
          className="-ml-1 rounded-lg p-2 text-xl hover:bg-stone-700/60"
          onClick={() => setDrawerOpen(true)}
        >
          ☰
        </button>
        <div className="flex items-center gap-2">
          <span className="text-lg">🏛</span>
          <span className="text-sm font-semibold tracking-wide">zzlibrary</span>
          <span className="text-xs text-stone-400">个人资料库</span>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* 小屏背板 */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setDrawerOpen(false)} />
        )}
        <aside
          className={
            "flex shrink-0 flex-col bg-stone-800 text-stone-100 transition-transform duration-200 " +
            // 小屏：离屏抽屉（max-md 变体只在 <768px 生效，桌面零 translate 不受顺序影响）；md+：常驻侧栏
            "fixed inset-y-0 left-0 z-50 w-64 md:static md:z-auto md:w-52 " +
            "[padding-top:env(safe-area-inset-top)] md:[padding-top:0] " +
            (drawerOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full")
          }
        >
          <div className="flex items-center gap-2 px-5 py-5">
            <span className="text-2xl">🏛</span>
            <div>
              <div className="text-base font-semibold tracking-wide">zzlibrary</div>
              <div className="text-xs text-stone-400">个人资料库</div>
            </div>
            <button
              aria-label="关闭导航"
              className="ml-auto rounded-lg p-1.5 text-stone-400 hover:bg-stone-700/60 hover:text-white md:hidden"
              onClick={() => setDrawerOpen(false)}
            >
              ✕
            </button>
          </div>
          <nav className="mt-2 flex-1 space-y-1 overflow-y-auto px-3">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                    isActive
                      ? "bg-amber-600/90 text-white"
                      : "text-stone-300 hover:bg-stone-700/60 hover:text-white"
                  }`
                }
              >
                <span>{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-stone-700 px-4 py-4 text-sm">
            <div className="mb-2 text-stone-400">
              👤 {username}
            </div>
            <button
              className="text-stone-400 transition-colors hover:text-amber-400"
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              退出登录
            </button>
          </div>
        </aside>
        <main className="zz-fade-in relative min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
