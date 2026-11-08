import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import HomePage from "./pages/HomePage";
import PackagesPage from "./pages/PackagesPage";
import UploadPage from "./pages/UploadPage";
import CategoriesPage from "./pages/CategoriesPage";
import SegmentPage from "./pages/SegmentPage";
import SettingsPage from "./pages/SettingsPage";
import LibraryPage from "./pages/LibraryPage";
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
        <Route path="/categories" element={<Protected><CategoriesPage /></Protected>} />
        <Route path="/segments" element={<Protected><SegmentPage /></Protected>} />
        <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}
