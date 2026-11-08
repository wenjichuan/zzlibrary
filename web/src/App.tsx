import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import Layout from "./components/Layout";
import { Spinner } from "./components/ui";
import LoginPage from "./pages/LoginPage";
import HomePage from "./pages/HomePage";
import PackagesPage from "./pages/PackagesPage";
import UploadPage from "./pages/UploadPage";
import LibraryPage from "./pages/LibraryPage";
// 低频管理页懒加载：切出主入口 bundle（重库本就动态 import，这里补齐页面层代码分割）
const CategoriesPage = lazy(() => import("./pages/CategoriesPage"));
const SegmentPage = lazy(() => import("./pages/SegmentPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
import { useAuth } from "./stores/auth";
import { ToastProvider } from "./stores/toast";

function Protected({ children }: { children: React.ReactNode }) {
  const username = useAuth((s) => s.username);
  const loaded = useAuth((s) => s.loaded);
  const location = useLocation();
  if (!loaded) return null;
  if (!username) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  const init = useAuth((s) => s.init);
  const logout = useAuth((s) => s.logout);

  useEffect(() => {
    init();
    const onUnauthorized = () => logout();
    window.addEventListener("zzlib:unauthorized", onUnauthorized);
    return () => window.removeEventListener("zzlib:unauthorized", onUnauthorized);
  }, [init, logout]);

  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<Protected><HomePage /></Protected>} />
        <Route path="/shelves/:l1Id" element={<Protected><LibraryPage /></Protected>} />
        <Route path="/packages" element={<Protected><PackagesPage /></Protected>} />
        <Route path="/upload" element={<Protected><UploadPage /></Protected>} />
        <Route path="/categories" element={<Protected><Suspense fallback={<Spinner />}><CategoriesPage /></Suspense></Protected>} />
        <Route path="/segments" element={<Protected><Suspense fallback={<Spinner />}><SegmentPage /></Suspense></Protected>} />
        <Route path="/settings" element={<Protected><Suspense fallback={<Spinner />}><SettingsPage /></Suspense></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}
