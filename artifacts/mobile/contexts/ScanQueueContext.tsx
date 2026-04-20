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
  buildPlaceholderTag,
  clearOpDeadLetter,
  enqueueOp,
  enqueueScan,
  getDeadLetter,
  getOpDeadLetter,
  getOpQueue,
  getOrCreateDeviceId,
  getQueue,
  markTagScanned,
  moveOpToDeadLetter,
  moveToDeadLetter,
  reconcilePlaceholderTag,
  setOpQueue,
  setQueue,
  type ExceptionOpPayload,
  type NoTagOpPayload,
  type OpKind,
  type QueuedOp,
  type QueuedScan,
} from "@/lib/db/storage";
import AsyncStorage from "@react-native-async-storage/async-storage";

const MAX_ATTEMPTS = 5;
// Per-attempt backoff in milliseconds: 2s, 4s, 8s, 16s, 32s.
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 32_000];

export type ExceptionEnqueueResult =
  | { status: "submitted"; id: string }
  | { status: "queued"; lastError?: string };

export type NoTagEnqueueResult =
  | { status: "submitted"; placeholderTag: string; finalTag: string; id: string }
  | { status: "queued"; placeholderTag: string; lastError?: string };

type ScanQueueContextValue = {
  // Scan queue (kept name for backwards compat — header pill / scan-screen
  // counters consume these).
  queueSize: number;
  deadLetterSize: number;
  // Per-kind op queue counts so the UI can render a clear breakdown
  // ("3 exceptions queued · 1 no-tag queued") rather than an opaque total.
  pendingExceptions: number;
  pendingNoTag: number;
  failedExceptions: number;
  failedNoTag: number;
  // Convenience aggregates.
  opsQueueSize: number;
  opsDeadLetterSize: number;
  pendingTotal: number;
  deadLetterTotal: number;
  online: boolean;
  syncing: boolean;
  enqueue: (scan: ScanRequest) => Promise<void>;
  /**
   * Persists the exception. When online, also performs the API call inline
   * and resolves with `{ status: "submitted", id }` on success so the UI
   * can show "Logged" with confidence. On API failure or when offline,
   * resolves with `{ status: "queued" }` and the entry remains in the
   * queue for periodic retry.
   */
  enqueueException: (
    payload: ExceptionOpPayload,
  ) => Promise<ExceptionEnqueueResult>;
  /**
   * Mints a local placeholder tag, persists the no-tag entry, and (when
   * online) attempts the API call inline. On success, the placeholder is
   * swapped for the backend-issued tag in the local scanned set and
   * cached manifest, and the resolved value carries the real `finalTag`.
   * Otherwise, resolves with the placeholder so the agent can affix
   * something readable to the bag immediately.
   */
  enqueueNoTag: (
    payload: Omit<NoTagOpPayload, "placeholderTag">,
  ) => Promise<NoTagEnqueueResult>;
  syncNow: () => Promise<void>;
  retryDeadLetter: () => Promise<void>;
  discardDeadLetter: () => Promise<void>;
};

const Ctx = createContext<ScanQueueContextValue | null>(null);

export function ScanQueueProvider({ children }: { children: React.ReactNode }) {
  const [queueSize, setQueueSize] = useState(0);
  const [deadLetterSize, setDeadLetterSize] = useState(0);
  const [pendingExceptions, setPendingExceptions] = useState(0);
  const [pendingNoTag, setPendingNoTag] = useState(0);
  const [failedExceptions, setFailedExceptions] = useState(0);
  const [failedNoTag, setFailedNoTag] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    const [q, dl, oqEx, oqNt, odlEx, odlNt] = await Promise.all([
      getQueue(),
      getDeadLetter(),
      getOpQueue("exception"),
      getOpQueue("noTag"),
      getOpDeadLetter("exception"),
      getOpDeadLetter("noTag"),
    ]);
    setQueueSize(q.length);
    setDeadLetterSize(dl.length);
    setPendingExceptions(oqEx.length);
    setPendingNoTag(oqNt.length);
    setFailedExceptions(odlEx.length);
    setFailedNoTag(odlNt.length);
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
        // The SGS backend exposes /api/health (not /api/healthz). Require a
        // 2xx — a 404 would otherwise be wrongly treated as "online".
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

  // Drain the scan queue once. Mirrors the original logic.
  const drainScans = useCallback(async () => {
    const queue = await getQueue();
    if (queue.length === 0) return;
    const remaining: QueuedScan[] = [];
    const now = Date.now();
    for (const item of queue) {
      if (item.attempts > 0 && item.nextAttemptAt && item.nextAttemptAt > now) {
        remaining.push(item);
        continue;
      }
      try {
        const result = await sgsApi.submitScan(item);
        if (result.result === "unknown") {
          // The server confirmed the bag doesn't exist — retrying will never
          // succeed. Move straight to dead-letter so the queue drains cleanly
          // and the agent sees an accurate failed-scan count.
          item.lastError = result.message ?? "Bag not found on server (404)";
          await moveToDeadLetter(item);
        }
      } catch (err) {
        item.attempts += 1;
        item.lastError = (err as Error).message;
        if (item.attempts < MAX_ATTEMPTS) {
          const wait =
            BACKOFF_MS[Math.min(item.attempts - 1, BACKOFF_MS.length - 1)];
          item.nextAttemptAt = now + wait;
          remaining.push(item);
        } else {
          await moveToDeadLetter(item);
        }
      }
    }
    // Merge anything enqueued during the drain so we don't lose mid-flight scans.
    const currentQueue = await getQueue();
    const seen = new Set(queue.map((q) => q.localId));
    const arrived = currentQueue.filter((q) => !seen.has(q.localId));
    await setQueue([...remaining, ...arrived]);
  }, []);

  // Performs a single op's API call. Used both by the inline-submit fast
  // path on enqueue (online) and by the periodic drain. On no-tag success
  // returns the backend-issued tag so callers can show it to the agent.
  const submitOpOnce = useCallback(
    async (
      item: QueuedOp,
    ): Promise<
      | { ok: true; finalTag?: string; id?: string }
      | { ok: false; err: Error }
    > => {
      try {
        if (item.kind === "exception") {
          const res = await sgsApi.submitException({
            tagNumber: item.payload.tagNumber,
            groupId: item.payload.groupId,
            flightId: item.payload.flightId,
            reason: item.payload.reason,
            notes: item.payload.notes,
            stage: item.payload.stage,
          });
          return { ok: true, id: res.id };
        }
        const res = await sgsApi.registerNoTag({
          pilgrimName: item.payload.pilgrimName,
          description: item.payload.description,
          groupId: item.payload.groupId,
          flightId: item.payload.flightId,
          stationCode: item.payload.stationCode,
        });
        // Reconcile every local store that may hold the placeholder so
        // post-sync queries / counts reference the canonical backend tag.
        // This includes scanned set, cached manifest, queued scans,
        // scan dead-letter, and any pending / failed exception ops
        // raised against the placeholder — without this, retries would
        // hit the backend with a tag it never issued.
        if (res.tagNumber && res.tagNumber !== item.payload.placeholderTag) {
          await reconcilePlaceholderTag(
            item.payload.groupId,
            item.payload.placeholderTag,
            res.tagNumber,
          );
        }
        return { ok: true, finalTag: res.tagNumber, id: res.id };
      } catch (err) {
        return { ok: false, err: err as Error };
      }
    },
    [],
  );

  // Drain a single op queue (per kind). Each kind has its own storage key
  // so two drains can run in parallel without racing on shared state.
  const drainOpsKind = useCallback(
    async (kind: OpKind) => {
      const queue = await getOpQueue(kind);
      if (queue.length === 0) return;
      const remaining: QueuedOp[] = [];
      const now = Date.now();
      for (const item of queue) {
        if (
          item.attempts > 0 &&
          item.nextAttemptAt &&
          item.nextAttemptAt > now
        ) {
          remaining.push(item);
          continue;
        }
        const res = await submitOpOnce(item);
        if (res.ok) continue;
        item.attempts += 1;
        item.lastError = res.err.message;
        if (item.attempts < MAX_ATTEMPTS) {
          const wait =
            BACKOFF_MS[Math.min(item.attempts - 1, BACKOFF_MS.length - 1)];
          item.nextAttemptAt = now + wait;
          remaining.push(item);
        } else {
          await moveOpToDeadLetter(item);
        }
      }
      const currentQueue = await getOpQueue(kind);
      const seen = new Set(queue.map((o) => o.localId));
      const arrived = currentQueue.filter((o) => !seen.has(o.localId));
      await setOpQueue(kind, [...remaining, ...arrived]);
    },
    [submitOpOnce],
  );

  const syncNow = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    setSyncing(true);
    try {
      // Drain all three queues concurrently. Each targets a separate
      // storage key, so there is no shared-state race; the SGS backend
      // is fine with a few concurrent requests at a time.
      await Promise.all([
        drainScans(),
        drainOpsKind("exception"),
        drainOpsKind("noTag"),
      ]);
      await refresh();
    } finally {
      setSyncing(false);
      refreshing.current = false;
    }
  }, [drainOpsKind, drainScans, refresh]);

  const retryDeadLetter = useCallback(async () => {
    const [scanDl, exDl, ntDl] = await Promise.all([
      getDeadLetter(),
      getOpDeadLetter("exception"),
      getOpDeadLetter("noTag"),
    ]);
    if (scanDl.length === 0 && exDl.length === 0 && ntDl.length === 0) return;
    const resetItem = <T extends { attempts: number }>(item: T): T => ({
      ...item,
      attempts: 0,
      nextAttemptAt: undefined,
      lastError: undefined,
    } as T);
    if (scanDl.length > 0) {
      const queue = await getQueue();
      await setQueue([...queue, ...scanDl.map(resetItem)]);
      await AsyncStorage.removeItem("sgs:scanDeadLetter");
    }
    if (exDl.length > 0) {
      const queue = await getOpQueue("exception");
      await setOpQueue("exception", [...queue, ...exDl.map(resetItem)]);
      await clearOpDeadLetter("exception");
    }
    if (ntDl.length > 0) {
      const queue = await getOpQueue("noTag");
      await setOpQueue("noTag", [...queue, ...ntDl.map(resetItem)]);
      await clearOpDeadLetter("noTag");
    }
    await refresh();
    syncNow().catch(() => undefined);
  }, [refresh, syncNow]);

  const discardDeadLetter = useCallback(async () => {
    await Promise.all([
      AsyncStorage.removeItem("sgs:scanDeadLetter"),
      clearOpDeadLetter(),
    ]);
    await refresh();
  }, [refresh]);

  const enqueue = useCallback(
    async (scan: ScanRequest) => {
      // Backstop: every persisted scan MUST carry the stable per-install
      // deviceId so the backend can dedupe across devices. Hydrate here
      // if the caller didn't pre-fill it (one-time AsyncStorage hit).
      const withDeviceId: ScanRequest = scan.deviceId
        ? scan
        : { ...scan, deviceId: await getOrCreateDeviceId() };
      await enqueueScan(withDeviceId);
      await refresh();
      if (online) syncNow().catch(() => undefined);
    },
    [online, refresh, syncNow],
  );

  // ----- Inline-submit helpers for ops queues -----
  //
  // These persist first (durability), then attempt the API call inline
  // when online so the screen can show a "drain-confirmed" success
  // message instead of optimistically claiming success. On failure, the
  // entry is left in the queue with attempts++ for the periodic retry.
  const submitInline = useCallback(
    async (
      item: QueuedOp,
    ): Promise<
      | { ok: true; finalTag?: string; id?: string }
      | { ok: false; err: Error }
    > => {
      const res = await submitOpOnce(item);
      const now = Date.now();
      const queue = await getOpQueue(item.kind);
      if (res.ok) {
        await setOpQueue(
          item.kind,
          queue.filter((o) => o.localId !== item.localId),
        );
      } else {
        // Increment attempts on the persisted record so periodic retries
        // honor the global cap and backoff, and so the UI count reflects
        // a recent failure.
        const idx = queue.findIndex((o) => o.localId === item.localId);
        if (idx >= 0) {
          queue[idx].attempts += 1;
          queue[idx].lastError = res.err.message;
          if (queue[idx].attempts < MAX_ATTEMPTS) {
            const wait =
              BACKOFF_MS[
                Math.min(queue[idx].attempts - 1, BACKOFF_MS.length - 1)
              ];
            queue[idx].nextAttemptAt = now + wait;
            await setOpQueue(item.kind, queue);
          } else {
            await moveOpToDeadLetter(queue[idx]);
            await setOpQueue(
              item.kind,
              queue.filter((o) => o.localId !== item.localId),
            );
          }
        }
      }
      return res;
    },
    [submitOpOnce],
  );

  const enqueueException = useCallback(
    async (payload: ExceptionOpPayload): Promise<ExceptionEnqueueResult> => {
      const item = (await enqueueOp({
        kind: "exception",
        payload,
      })) as Extract<QueuedOp, { kind: "exception" }>;
      // If we're offline, don't even attempt — caller wants a fast
      // "queued" confirmation rather than a slow timeout.
      if (!online) {
        await refresh();
        return { status: "queued" };
      }
      const res = await submitInline(item);
      await refresh();
      if (res.ok) {
        return { status: "submitted", id: res.id ?? item.localId };
      }
      return { status: "queued", lastError: res.err.message };
    },
    [online, refresh, submitInline],
  );

  const enqueueNoTag = useCallback(
    async (
      payload: Omit<NoTagOpPayload, "placeholderTag">,
    ): Promise<NoTagEnqueueResult> => {
      const placeholderTag = buildPlaceholderTag(payload.stationCode);
      const full: NoTagOpPayload = { ...payload, placeholderTag };
      // Mark the placeholder scanned BEFORE attempting the API so the
      // per-group count reflects the bag instantly. If the API succeeds
      // inline, submitOpOnce will swap placeholder→real tag before this
      // returns; if it fails, the placeholder stays and gets reconciled
      // on a later drain.
      // Skipped in the new flight-only flow when no groupId is provided
      // — the bag will appear in flight totals once the server resolves
      // it onto a group.
      if (payload.groupId) {
        await markTagScanned(payload.groupId, placeholderTag);
      }
      const item = (await enqueueOp({
        kind: "noTag",
        payload: full,
      })) as Extract<QueuedOp, { kind: "noTag" }>;
      if (!online) {
        await refresh();
        return { status: "queued", placeholderTag };
      }
      const res = await submitInline(item);
      await refresh();
      if (res.ok) {
        return {
          status: "submitted",
          placeholderTag,
          // submitOpOnce returns the backend-issued tag from the response.
          // Fall back to placeholder only if the server somehow echoed
          // nothing (defensive — registerNoTag would have thrown).
          finalTag: res.finalTag ?? placeholderTag,
          id: res.id ?? item.localId,
        };
      }
      return {
        status: "queued",
        placeholderTag,
        lastError: res.err.message,
      };
    },
    [online, refresh, submitInline],
  );

  // Auto-sync when coming online — drain whichever queue has work.
  useEffect(() => {
    if (
      online &&
      (queueSize > 0 || pendingExceptions > 0 || pendingNoTag > 0)
    ) {
      syncNow().catch(() => undefined);
    }
  }, [online, queueSize, pendingExceptions, pendingNoTag, syncNow]);

  // Periodic sync every 30s
  useEffect(() => {
    const id = setInterval(() => {
      if (online) syncNow().catch(() => undefined);
    }, 30000);
    return () => clearInterval(id);
  }, [online, syncNow]);

  const opsQueueSize = pendingExceptions + pendingNoTag;
  const opsDeadLetterSize = failedExceptions + failedNoTag;
  const pendingTotal = queueSize + opsQueueSize;
  const deadLetterTotal = deadLetterSize + opsDeadLetterSize;

  const value = useMemo(
    () => ({
      queueSize,
      deadLetterSize,
      pendingExceptions,
      pendingNoTag,
      failedExceptions,
      failedNoTag,
      opsQueueSize,
      opsDeadLetterSize,
      pendingTotal,
      deadLetterTotal,
      online,
      syncing,
      enqueue,
      enqueueException,
      enqueueNoTag,
      syncNow,
      retryDeadLetter,
      discardDeadLetter,
    }),
    [
      queueSize,
      deadLetterSize,
      pendingExceptions,
      pendingNoTag,
      failedExceptions,
      failedNoTag,
      opsQueueSize,
      opsDeadLetterSize,
      pendingTotal,
      deadLetterTotal,
      online,
      syncing,
      enqueue,
      enqueueException,
      enqueueNoTag,
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
