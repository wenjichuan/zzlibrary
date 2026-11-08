import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../stores/auth";
import { useToast } from "../stores/toast";
import { Button, Field, Input } from "../components/ui";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  const { push } = useToast();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(username, password);
      push("success", "登录成功");
      navigate((location.state as { from?: string })?.from ?? "/", { replace: true });
    } catch (err) {
      push("error", err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-stone-100 via-amber-50 to-stone-200">
      <form
        onSubmit={submit}
        className="zz-fade-in w-90 max-w-sm rounded-2xl border border-stone-200 bg-white/90 p-8 shadow-xl backdrop-blur"
      >
        <div className="mb-6 flex flex-col items-center gap-1">
          <span className="text-4xl">🏛</span>
          <h1 className="text-lg font-semibold text-stone-800">zzlibrary · 个人资料库</h1>
          <p className="text-xs text-stone-500">个人资料库 · 资料在手 · 随身阅读</p>
        </div>
        <div className="space-y-4">
          <Field label="用户名">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </Field>
          <Field label="密码">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Button type="submit" disabled={busy || !username || !password} className="w-full">
            {busy ? "登录中…" : "登录"}
          </Button>
        </div>
      </form>
    </div>
  );
}
