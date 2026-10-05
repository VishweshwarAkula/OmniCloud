import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

// Single-user local app: no sign-in. This just loads who "you" are, for names and avatars.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  useEffect(() => {
    let active = true;
    api("/me")
      .then(({ user: u }) => active && setUser(u))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo(() => ({ user }), [user]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
