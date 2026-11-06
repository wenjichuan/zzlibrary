import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../stores/auth";

const NAV = [
  { to: "/", label: "馆藏", icon: "🏛", end: true },
  { to: "/packages", label: "资料包", icon: "📦" },
  { to: "/upload", label: "入库", icon: "📥" },
  { to: "/categories", label: "分类", icon: "🗂" },
  { to: "/segments", label: "时间分段", icon: "🕰" },
  { to: "/settings", label: "设置", icon: "⚙" },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const username = useAuth((s) => s.username);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col bg-stone-800 text-stone-100">
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="text-2xl">🏛</span>
          <div>
            <div className="text-base font-semibold tracking-wide">zzlibrary</div>
            <div className="text-xs text-stone-400">个人资料库</div>
          </div>
        </div>
        <nav className="mt-2 flex-1 space-y-1 px-3">
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
  );
}
