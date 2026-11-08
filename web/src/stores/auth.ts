import { create } from "zustand";
import { api } from "@zzlibrary/shared/client";

interface AuthState {
  username: string | null;
  loaded: boolean;
  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  username: null,
  loaded: false,
  init: async () => {
    try {
      const me = await api.me();
      set({ username: me.username, loaded: true });
    } catch {
      set({ username: null, loaded: true });
    }
  },
  login: async (username, password) => {
    const me = await api.login(username, password);
    set({ username: me.username });
  },
  logout: () => {
    set({ username: null });
    void api.logout().catch(() => undefined);
  },
}));
