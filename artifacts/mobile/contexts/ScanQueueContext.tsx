import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { SGS_BASE_URL, sgsApi, type ScanRequest } from "@/lib/api/sgs";
import {
  enqueueScan,
  getDeadLetter,
  getOrCreateDeviceId,
  getQueue,
  moveToDeadLetter,
  setQueue,
  type QueuedScan,
} from "@/lib/db/storage";
import AsyncStorage from "@react-native-async-storage/async-storage";

const MAX_ATTEMPTS = 5;
// Per-attempt backoff in milliseconds: 2s, 4s, 8s, 16s, 32s.
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 32_000];

type ScanQueueContextValue = {
  queueSize: number;
  deadLetterSize: number;
  online: boolean;
  syncing: boolean;
  enqueue: (scan: ScanRequest) => Promise<void>;
  syncNow: () => Promise<void>;
  retryDeadLetter: () => Promise<void>;
  discardDeadLetter: () => Promise<void>;
};

const Ctx = createContext<ScanQueueContextValue | null>(null);

export function ScanQueueProvider({ children }: { children: React.ReactNode }) {
  const [queueSize, setQueueSize] = useState(0);
  const [deadLetterSize, setDeadLetterSize] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    const [q, dl] = await Promise.all([getQueue(), getDeadLetter()]);
    setQueueSize(q.length);
    setDeadLetterSize(dl.length);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Heuristic online check: ping our base URL periodically. NetInfo would be
  // ideal but isn't required for Expo Go and avoids an extra native dep.
  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      try {
        // The SGS backend exposes /api/health (not /api/healthz). The old
        // /api/healthz path was masked by `res.status < 500` accepting the
        // 404 — which meant we were reporting "online" anytime the API was
        // reachable, even if the rest of it was actually broken. Hit the
        // real health endpoint and require a 2xx.
        const res = await fetch(`${SGS_BASE_URL}/api/health`, {
          method: "GET",
        });
        if (!cancelled) setOnline(res.ok);
      } catch {
        if (!cancelled) setOnline(false);
      }
    };
    ping();
    const id = setInterval(ping, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const syncNow = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    setSyncing(true);
    try {
      const queue = await getQueue();
      const remaining: QueuedScan[] = [];
      const now = Date.now();
      for (const item of queue) {
        // Honour exponential backoff before retrying
        if (item.attempts > 0 && item.nextAttemptAt && item.nextAttemptAt > now) {
          remaining.push(item);
          continue;
        }
        try {
          await sgsApi.submitScan(item);
          // success — drop from queue (do not re-add to remaining)
        } catch (err) {
          item.attempts += 1;
          item.lastError = (err as Error).message;
          if (item.attempts < MAX_ATTEMPTS) {
            const wait = BACKOFF_MS[Math.min(item.attempts - 1, BACKOFF_MS.length - 1)];
            item.nextAttemptAt = now + wait;
            remaining.push(item);
          } else {
            // Park exhausted retries in dead-letter for manual review
            await moveToDeadLetter(item);
          }
        }
      }
      // Re-read queue and merge any items enqueued during the sync window so
      // we don't drop scans that arrived mid-flight.
      const currentQueue = await getQueue();
      const seen = new Set(queue.map((q) => q.localId));
      const arrivedDuringSync = currentQueue.filter((q) => !seen.has(q.localId));
      await setQueue([...remaining, ...arrivedDuringSync]);
      await refresh();
    } finally {
      setSyncing(false);
      refreshing.current = false;
    }
  }, [refresh]);

  const retryDeadLetter = useCallback(async () => {
    const dl = await getDeadLetter();
    if (dl.length === 0) return;
    const reset = dl.map((item) => ({
      ...item,
      attempts: 0,
      nextAttemptAt: undefined,
      lastError: undefined,
    }));
    const queue = await getQueue();
    await setQueue([...queue, ...reset]);
    await AsyncStorage.removeItem("sgs:scanDeadLetter");
    await refresh();
    syncNow().catch(() => undefined);
  }, [refresh, syncNow]);

  const discardDeadLetter = useCallback(async () => {
    await AsyncStorage.removeItem("sgs:scanDeadLetter");
    await refresh();
  }, [refresh]);

  const enqueue = useCallback(
    async (scan: ScanRequest) => {
      // Backstop: every persisted scan MUST carry the stable per-install
      // deviceId so the backend can dedupe across devices. Callers may
      // pre-fill it (scan.tsx caches it on mount); if they don't (or if
      // the cache hadn't resolved before the first scan), hydrate it
      // here. AsyncStorage round-trip is ~1ms in practice and only
      // happens on the very first scan after launch.
      const withDeviceId: ScanRequest = scan.deviceId
        ? scan
        : { ...scan, deviceId: await getOrCreateDeviceId() };
      await enqueueScan(withDeviceId);
      await refresh();
      if (online) syncNow().catch(() => undefined);
    },
    [online, refresh, syncNow],
  );

  // Auto-sync when coming online
  useEffect(() => {
    if (online && queueSize > 0) syncNow().catch(() => undefined);
  }, [online, queueSize, syncNow]);

  // Periodic sync every 30s
  useEffect(() => {
    const id = setInterval(() => {
      if (online) syncNow().catch(() => undefined);
    }, 30000);
    return () => clearInterval(id);
  }, [online, syncNow]);

  const value = useMemo(
    () => ({
      queueSize,
      deadLetterSize,
      online,
      syncing,
      enqueue,
      syncNow,
      retryDeadLetter,
      discardDeadLetter,
    }),
    [
      queueSize,
      deadLetterSize,
      online,
      syncing,
      enqueue,
      syncNow,
      retryDeadLetter,
      discardDeadLetter,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScanQueue() {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useScanQueue must be used within ScanQueueProvider");
  return ctx;
}
