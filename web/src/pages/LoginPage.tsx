import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../stores/auth";
import { useToast } from "../stores/toast";
import { Button, Field, Input } from "../components/ui";
import { useT } from "../i18n/lang";
import LangToggle from "../components/LangToggle";

export default function LoginPage() {
  const t = useT();
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
      push("success", t("login.ok"));
      navigate((location.state as { from?: string })?.from ?? "/", { replace: true });
    } catch (err) {
      push("error", err instanceof Error ? err.message : t("login.fail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full items-center justify-center bg-gradient-to-br from-stone-100 via-amber-50 to-stone-200">
      <div className="absolute right-4 top-4 [margin-top:env(safe-area-inset-top)]">
        <LangToggle className="text-stone-600" />
      </div>
      <form
        onSubmit={submit}
        className="zz-fade-in w-90 max-w-sm rounded-2xl border border-stone-200 bg-white/90 p-8 shadow-xl backdrop-blur"
      >
        <div className="mb-6 flex flex-col items-center gap-1">
          <span className="text-4xl">🏛</span>
          <h1 className="text-lg font-semibold text-stone-800">{t("login.heading")}</h1>
          <p className="text-xs text-stone-500">{t("login.subtitle")}</p>
        </div>
        <div className="space-y-4">
          <Field label={t("login.username")}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </Field>
          <Field label={t("login.password")}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Button type="submit" disabled={busy || !username || !password} className="w-full">
            {busy ? t("login.submitting") : t("login.submit")}
          </Button>
        </div>
      </form>
    </div>
  );
}
