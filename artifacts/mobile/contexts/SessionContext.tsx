import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { BagGroup, Flight } from "@/lib/api/sgs";

const SESSION_KEY = "sgs.session";

type Session = {
  flight: Flight;
  group: BagGroup;
  startedAt: string;
};

type SessionContextValue = {
  ready: boolean;
  session: Session | null;
  setSession: (s: Session | null) => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSessionState] = useState<Session | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (raw) setSessionState(JSON.parse(raw) as Session);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const setSession = useCallback(async (s: Session | null) => {
    setSessionState(s);
    if (s) await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else await AsyncStorage.removeItem(SESSION_KEY);
  }, []);

  const value = useMemo(
    () => ({ ready, session, setSession }),
    [ready, session, setSession],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
