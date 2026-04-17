import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { sgsApi, type ScanRequest } from "@/lib/api/sgs";
import {
  enqueueScan,
  getQueue,
  moveToDeadLetter,
  setQueue,
  type QueuedScan,
} from "@/lib/db/storage";

const MAX_ATTEMPTS = 5;

type ScanQueueContextValue = {
  queueSize: number;
  online: boolean;
  syncing: boolean;
  enqueue: (scan: ScanRequest) => Promise<void>;
  syncNow: () => Promise<void>;
};

const Ctx = createContext<ScanQueueContextValue | null>(null);

export function ScanQueueProvider({ children }: { children: React.ReactNode }) {
  const [queueSize, setQueueSize] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    const q = await getQueue();
    setQueueSize(q.length);
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
        const res = await fetch(
          `${process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : "https://sgshajj.semicolon.sa"}/api/healthz`,
          { method: "GET" },
        );
        if (!cancelled) setOnline(res.ok || res.status < 500);
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
      for (const item of queue) {
        try {
          await sgsApi.submitScan(item);
          // success — drop from queue (do not re-add to remaining)
        } catch (err) {
          item.attempts += 1;
          item.lastError = (err as Error).message;
          if (item.attempts < MAX_ATTEMPTS) {
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

  const enqueue = useCallback(
    async (scan: ScanRequest) => {
      await enqueueScan(scan);
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
    () => ({ queueSize, online, syncing, enqueue, syncNow }),
    [queueSize, online, syncing, enqueue, syncNow],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScanQueue() {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useScanQueue must be used within ScanQueueProvider");
  return ctx;
}
