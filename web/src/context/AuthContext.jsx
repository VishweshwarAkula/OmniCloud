import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const qc = useQueryClient();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [methods, setMethods] = useState({ google: false, devLogin: false });

  useEffect(() => {
    let active = true;
    Promise.allSettled([api("/auth/me"), api("/auth/config")]).then(([me, cfg]) => {
      if (!active) return;
      setUser(me.status === "fulfilled" ? me.value.user : null);
      if (cfg.status === "fulfilled") setMethods(cfg.value);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  // Google sign-in is a full-page round trip through the API (it sets an httpOnly cookie).
  const signIn = useCallback((next = "/app") => {
    window.location.assign(`/api/auth/google/start?next=${encodeURIComponent(next)}`);
  }, []);

  const devSignIn = useCallback(async (email) => {
    const { user: u } = await api("/auth/dev", { method: "POST", body: { email } });
    setUser(u);
    return u;
  }, []);

  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    qc.clear();
    setUser(null);
  }, [qc]);

  const value = useMemo(() => ({ user, loading, methods, signIn, devSignIn, signOut }), [user, loading, methods, signIn, devSignIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
