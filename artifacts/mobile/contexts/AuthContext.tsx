import * as SecureStore from "expo-secure-store";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppState, Platform } from "react-native";

import { sgsApi, setAuthToken } from "@/lib/api/sgs";

const TOKEN_KEY = "sgs.authToken";
const USER_KEY = "sgs.authUser";
const LAST_SYNC_KEY = "sgs.lastSyncAt";
// Legacy key kept only for cleanup on sign-out so existing installs don't
// hold a stale refresh token in SecureStore. The live SGS backend uses an
// HTTP-only refresh cookie instead.
const LEGACY_REFRESH_KEY = "sgs.refreshToken";

type User = {
  id: string;
  name: string;
  role: string;
  /** Three-letter IATA station code (e.g. "JED") parsed from the JWT. */
  stationCode?: string;
};

type AuthContextValue = {
  ready: boolean;
  user: User | null;
  token: string | null;
  lastSyncAt: string | null;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    return globalThis.localStorage?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}
async function secureSet(key: string, value: string) {
  if (Platform.OS === "web") {
    globalThis.localStorage?.setItem(key, value);
    return;
  }
  return SecureStore.setItemAsync(key, value);
}
async function secureDel(key: string) {
  if (Platform.OS === "web") {
    globalThis.localStorage?.removeItem(key);
    return;
  }
  return SecureStore.deleteItemAsync(key);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [t, u, ls] = await Promise.all([
          secureGet(TOKEN_KEY),
          secureGet(USER_KEY),
          secureGet(LAST_SYNC_KEY),
        ]);
        if (t) {
          setToken(t);
          setAuthToken(t);
        }
        if (u) setUser(JSON.parse(u) as User);
        if (ls) setLastSyncAt(ls);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const recordSync = useCallback(async () => {
    const now = new Date().toISOString();
    setLastSyncAt(now);
    await secureSet(LAST_SYNC_KEY, now);
  }, []);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const res = await sgsApi.login(username, password);
      setAuthToken(res.token);
      setToken(res.token);
      setUser(res.user);
      await Promise.all([
        secureSet(TOKEN_KEY, res.token),
        secureSet(USER_KEY, JSON.stringify(res.user)),
      ]);
      await recordSync();
    },
    [recordSync],
  );

  const refreshSession = useCallback(async (): Promise<boolean> => {
    // Refresh uses the HTTP-only cookie set by /api/auth/login, so there is
    // no client-held refresh token. Returns null when the cookie is missing
    // or expired.
    const res = await sgsApi.refresh();
    if (!res) return false;
    setAuthToken(res.token);
    setToken(res.token);
    if (res.user.id) setUser(res.user);
    await Promise.all([
      secureSet(TOKEN_KEY, res.token),
      res.user.id ? secureSet(USER_KEY, JSON.stringify(res.user)) : Promise.resolve(),
    ]);
    await recordSync();
    return true;
  }, [recordSync]);

  // Silent refresh on foreground. Try the refresh endpoint first; if that
  // succeeds the token rotation is recorded. On 401/403 we sign out so the
  // agent gets a fresh login prompt instead of a dead UI.
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (state) => {
      if (state !== "active" || !token) return;
      const ok = await refreshSession();
      if (ok) return;
      try {
        await sgsApi.flights();
        await recordSync();
      } catch (err) {
        const code = (err as { status?: number }).status;
        if (code === 401 || code === 403) {
          setAuthToken(null);
          setToken(null);
          setUser(null);
          await Promise.all([
            secureDel(TOKEN_KEY),
            secureDel(USER_KEY),
            secureDel(LEGACY_REFRESH_KEY),
          ]);
        }
      }
    });
    return () => sub.remove();
  }, [token, refreshSession, recordSync]);

  const signOut = useCallback(async () => {
    setAuthToken(null);
    setToken(null);
    setUser(null);
    await Promise.all([
      secureDel(TOKEN_KEY),
      secureDel(USER_KEY),
      secureDel(LEGACY_REFRESH_KEY),
    ]);
  }, []);

  const value = useMemo(
    () => ({
      ready,
      user,
      token,
      lastSyncAt,
      signIn,
      signOut,
      refreshSession,
    }),
    [ready, user, token, lastSyncAt, signIn, signOut, refreshSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
