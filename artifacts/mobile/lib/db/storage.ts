/**
 * Local persistence for offline manifest cache and scan queue.
 *
 * Uses AsyncStorage (Expo Go compatible). For production at scale, swap the
 * storage adapter to expo-sqlite without changing the public API surface.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ManifestBag, ScanRequest } from "@/lib/api/sgs";

const KEYS = {
  manifest: (groupId: string) => `sgs:manifest:${groupId}`,
  scanned: (groupId: string) => `sgs:scanned:${groupId}`,
  queue: "sgs:scanQueue",
  deadLetter: "sgs:scanDeadLetter",
  // Two parallel ops queues — per-kind so parallel drains can't race on
  // shared storage, and per-kind counts / dead-letter buckets are
  // trivially derivable for the UI.
  opQueueException: "sgs:opsExceptionQueue",
  opDeadLetterException: "sgs:opsExceptionDeadLetter",
  opQueueNoTag: "sgs:opsNoTagQueue",
  opDeadLetterNoTag: "sgs:opsNoTagDeadLetter",
  lastSync: (groupId: string) => `sgs:lastSync:${groupId}`,
  flightsCache: "sgs:flightsCache",
  flightsCacheAt: "sgs:flightsCacheAt",
  assignmentsCache: "sgs:assignmentsCache",
  groupsCache: (flightId: string) => `sgs:groupsCache:${flightId}`,
  groupsCacheAt: (flightId: string) => `sgs:groupsCacheAt:${flightId}`,
  deviceId: "sgs:deviceId",
  // Diagnostic toggle — when on, the scan screen surfaces every raw
  // barcode payload it receives (including those rejected by the
  // validator) so the next "scan shows nothing" report is one tap
  // away from a useful repro.
  debugRawScan: "sgs:debug:rawScan",
  // User-selected scanner mode override. "auto" defers to device
  // detection (Zebra hardware → trigger; otherwise → camera). Explicit
  // "zebra" / "camera" forces that source regardless of detection — used
  // when an agent is on a Zebra device but the trigger is busted, or
  // when QA needs to test the camera path on a TC57.
  scannerMode: "sgs:scannerMode",
};

export const STORAGE_KEYS = KEYS;

// ---------- Stable per-install device id ----------

let _deviceIdCache: string | null = null;

/**
 * Returns a stable UUID for this install, generating one on first call and
 * persisting it to AsyncStorage. Sent on every scan request so the backend
 * can dedupe identical scans coming from the same device (e.g. after an
 * app restart) without conflating them with scans from other devices.
 *
 * Falls back to a freshly generated id if storage is unavailable so callers
 * never see a missing value mid-flow.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  if (_deviceIdCache) return _deviceIdCache;
  try {
    const existing = await AsyncStorage.getItem(KEYS.deviceId);
    if (existing) {
      _deviceIdCache = existing;
      return existing;
    }
  } catch {
    // fall through to generation
  }
  const fresh = generateUuidV4();
  try {
    await AsyncStorage.setItem(KEYS.deviceId, fresh);
  } catch {
    // best-effort persistence; in-memory cache still applies for this session
  }
  _deviceIdCache = fresh;
  return fresh;
}

function generateUuidV4(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else if (i === 19) out += hex[(Math.random() * 4) | 0 | 8];
    else out += hex[(Math.random() * 16) | 0];
  }
  return out;
}

// ---------- Diagnostic settings ----------

/**
 * "Show raw scan" diagnostic toggle. When on, the scan screen briefly
 * surfaces every detected barcode (including ones rejected by the
 * validator) with its raw payload so a field issue like "scan shows
 * nothing" can be triaged in seconds. Default off so the production
 * UX stays clean.
 */
export async function getDebugRawScan(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEYS.debugRawScan);
    return v === "1";
  } catch {
    return false;
  }
}

export async function setDebugRawScan(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS.debugRawScan, on ? "1" : "0");
  } catch {
    // best-effort — not worth crashing the settings screen for
  }
}

export type ScannerMode = "auto" | "zebra" | "camera";

const SCANNER_MODES: readonly ScannerMode[] = ["auto", "zebra", "camera"];

export async function getScannerMode(): Promise<ScannerMode> {
  try {
    const v = await AsyncStorage.getItem(KEYS.scannerMode);
    return (SCANNER_MODES as readonly string[]).includes(v ?? "")
      ? (v as ScannerMode)
      : "auto";
  } catch {
    return "auto";
  }
}

export async function setScannerMode(mode: ScannerMode): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS.scannerMode, mode);
  } catch {
    // best-effort — UI already updated optimistically
  }
}

// ---------- Flights / groups offline cache ----------

export async function cacheFlights<T>(flights: T) {
  await AsyncStorage.multiSet([
    [KEYS.flightsCache, JSON.stringify(flights)],
    [KEYS.flightsCacheAt, new Date().toISOString()],
  ]);
}

export async function getCachedFlights<T>(): Promise<{
  data: T | null;
  cachedAt: string | null;
}> {
  const [[, raw], [, at]] = await AsyncStorage.multiGet([
    KEYS.flightsCache,
    KEYS.flightsCacheAt,
  ]);
  return {
    data: raw ? (JSON.parse(raw) as T) : null,
    cachedAt: at ?? null,
  };
}

export async function cacheAssignments<T>(assignments: T) {
  await AsyncStorage.setItem(KEYS.assignmentsCache, JSON.stringify(assignments));
}

export async function getCachedAssignments<T>(): Promise<T | null> {
  const raw = await AsyncStorage.getItem(KEYS.assignmentsCache);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function cacheGroups<T>(flightId: string, groups: T) {
  await AsyncStorage.multiSet([
    [KEYS.groupsCache(flightId), JSON.stringify(groups)],
    [KEYS.groupsCacheAt(flightId), new Date().toISOString()],
  ]);
}

export async function getCachedGroups<T>(
  flightId: string,
): Promise<{ data: T | null; cachedAt: string | null }> {
  const [[, raw], [, at]] = await AsyncStorage.multiGet([
    KEYS.groupsCache(flightId),
    KEYS.groupsCacheAt(flightId),
  ]);
  return {
    data: raw ? (JSON.parse(raw) as T) : null,
    cachedAt: at ?? null,
  };
}

export async function cacheManifest(groupId: string, bags: ManifestBag[]) {
  await AsyncStorage.multiSet([
    [KEYS.manifest(groupId), JSON.stringify(bags)],
    [KEYS.lastSync(groupId), new Date().toISOString()],
  ]);
}

export async function getCachedManifest(
  groupId: string,
): Promise<ManifestBag[] | null> {
  const raw = await AsyncStorage.getItem(KEYS.manifest(groupId));
  return raw ? (JSON.parse(raw) as ManifestBag[]) : null;
}

export async function getLastSync(groupId: string): Promise<string | null> {
  return AsyncStorage.getItem(KEYS.lastSync(groupId));
}

export async function getScannedTags(groupId: string): Promise<Set<string>> {
  const raw = await AsyncStorage.getItem(KEYS.scanned(groupId));
  return new Set(raw ? (JSON.parse(raw) as string[]) : []);
}

export async function markTagScanned(groupId: string, tagNumber: string) {
  const set = await getScannedTags(groupId);
  set.add(tagNumber);
  await AsyncStorage.setItem(
    KEYS.scanned(groupId),
    JSON.stringify(Array.from(set)),
  );
}

// ---------- Offline scan queue ----------

export interface QueuedScan extends ScanRequest {
  localId: string;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number; // epoch ms; honored by the sync loop's backoff
}

export async function enqueueScan(scan: ScanRequest): Promise<QueuedScan> {
  const queue = await getQueue();
  const item: QueuedScan = {
    ...scan,
    localId: Date.now().toString() + Math.random().toString(36).slice(2, 8),
    attempts: 0,
  };
  queue.push(item);
  await AsyncStorage.setItem(KEYS.queue, JSON.stringify(queue));
  return item;
}

export async function getQueue(): Promise<QueuedScan[]> {
  const raw = await AsyncStorage.getItem(KEYS.queue);
  return raw ? (JSON.parse(raw) as QueuedScan[]) : [];
}

export async function setQueue(queue: QueuedScan[]) {
  await AsyncStorage.setItem(KEYS.queue, JSON.stringify(queue));
}

export async function removeFromQueue(localId: string) {
  const queue = await getQueue();
  await setQueue(queue.filter((q) => q.localId !== localId));
}

export async function moveToDeadLetter(item: QueuedScan) {
  const raw = await AsyncStorage.getItem(KEYS.deadLetter);
  const dl = raw ? (JSON.parse(raw) as QueuedScan[]) : [];
  dl.push(item);
  await AsyncStorage.setItem(KEYS.deadLetter, JSON.stringify(dl));
}

export async function getDeadLetter(): Promise<QueuedScan[]> {
  const raw = await AsyncStorage.getItem(KEYS.deadLetter);
  return raw ? (JSON.parse(raw) as QueuedScan[]) : [];
}

// ---------- Generic ops queue (exceptions + no-tag) ----------
//
// Parallel to the scan queue. Same retry / backoff / dead-letter shape, but
// the payload is one of two discriminated kinds so we can route to the right
// API call when draining. Keeping it separate from the scan queue avoids
// destabilising a critical, well-tested code path.

export type OpKind = "exception" | "noTag";

export interface ExceptionOpPayload {
  tagNumber: string;
  groupId: string;
  flightId: string;
  reason: string;
  notes?: string;
  stage?: "BELT" | "LOADING" | "TRANSIT" | "DELIVERY";
}

export interface NoTagOpPayload {
  pilgrimName: string;
  description: string;
  /**
   * Optional in the new flight-only mobile flow. When omitted the
   * backend resolves the bag onto the flight and lets supervisors
   * route it to the correct group later.
   */
  groupId?: string;
  flightId: string;
  stationCode?: string;
  /**
   * Local placeholder tag (e.g. NOTAG-JED-LOCAL-a3f2b1) generated when the
   * agent submits offline. Affixed to the bag immediately so the bag is
   * trackable; replaced by the backend-issued tag once sync succeeds.
   */
  placeholderTag: string;
}

export type QueuedOp =
  | {
      localId: string;
      kind: "exception";
      attempts: number;
      lastError?: string;
      nextAttemptAt?: number;
      createdAt: string;
      payload: ExceptionOpPayload;
    }
  | {
      localId: string;
      kind: "noTag";
      attempts: number;
      lastError?: string;
      nextAttemptAt?: number;
      createdAt: string;
      payload: NoTagOpPayload;
    };

function makeLocalId(): string {
  return Date.now().toString() + Math.random().toString(36).slice(2, 8);
}

function queueKeyFor(kind: OpKind): string {
  return kind === "exception" ? KEYS.opQueueException : KEYS.opQueueNoTag;
}

function deadLetterKeyFor(kind: OpKind): string {
  return kind === "exception"
    ? KEYS.opDeadLetterException
    : KEYS.opDeadLetterNoTag;
}

export async function enqueueOp(
  op:
    | { kind: "exception"; payload: ExceptionOpPayload }
    | { kind: "noTag"; payload: NoTagOpPayload },
): Promise<QueuedOp> {
  const queue = await getOpQueue(op.kind);
  const item = {
    localId: makeLocalId(),
    kind: op.kind,
    attempts: 0,
    createdAt: new Date().toISOString(),
    payload: op.payload,
  } as QueuedOp;
  queue.push(item);
  await AsyncStorage.setItem(queueKeyFor(op.kind), JSON.stringify(queue));
  return item;
}

export async function getOpQueue(kind: OpKind): Promise<QueuedOp[]> {
  const raw = await AsyncStorage.getItem(queueKeyFor(kind));
  return raw ? (JSON.parse(raw) as QueuedOp[]) : [];
}

export async function setOpQueue(kind: OpKind, queue: QueuedOp[]) {
  await AsyncStorage.setItem(queueKeyFor(kind), JSON.stringify(queue));
}

export async function moveOpToDeadLetter(item: QueuedOp) {
  const key = deadLetterKeyFor(item.kind);
  const raw = await AsyncStorage.getItem(key);
  const dl = raw ? (JSON.parse(raw) as QueuedOp[]) : [];
  dl.push(item);
  await AsyncStorage.setItem(key, JSON.stringify(dl));
}

export async function getOpDeadLetter(kind: OpKind): Promise<QueuedOp[]> {
  const raw = await AsyncStorage.getItem(deadLetterKeyFor(kind));
  return raw ? (JSON.parse(raw) as QueuedOp[]) : [];
}

export async function clearOpDeadLetter(kind?: OpKind) {
  if (kind) {
    await AsyncStorage.removeItem(deadLetterKeyFor(kind));
  } else {
    await AsyncStorage.multiRemove([
      KEYS.opDeadLetterException,
      KEYS.opDeadLetterNoTag,
    ]);
  }
}

/**
 * Builds a human-readable, locally-unique placeholder tag for a no-tag bag
 * raised offline. Format: `NOTAG-<STATION>-LOCAL-<6char>`. The 6-char
 * suffix is randomised so two agents working the same station can't collide
 * even before the backend issues a real tag.
 */
export function buildPlaceholderTag(stationCode: string | undefined): string {
  const station = (stationCode || "XXX").toUpperCase().slice(0, 3);
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `NOTAG-${station}-LOCAL-${suffix}`;
}

/**
 * Swap a tag in the per-group scanned set. Used after a queued no-tag op
 * drains successfully so local counts stay correct: the placeholder we
 * marked scanned at enqueue time is replaced with the backend-issued tag.
 */
export async function replaceScannedTag(
  groupId: string,
  oldTag: string,
  newTag: string,
) {
  const set = await getScannedTags(groupId);
  if (!set.has(oldTag) && set.has(newTag)) return;
  set.delete(oldTag);
  set.add(newTag);
  await AsyncStorage.setItem(
    KEYS.scanned(groupId),
    JSON.stringify(Array.from(set)),
  );
}

/**
 * Swap a tag in the cached manifest for a group. The manifest is the
 * source-of-truth bag list shown to the agent; if a no-tag op was logged
 * offline and we wrote the placeholder anywhere in it, point those
 * entries at the backend-issued tag once sync succeeds. Best-effort —
 * the next manifest fetch will reconcile authoritatively.
 */
export async function replaceManifestTag(
  groupId: string,
  oldTag: string,
  newTag: string,
) {
  const raw = await AsyncStorage.getItem(KEYS.manifest(groupId));
  if (!raw) return;
  try {
    const manifest = JSON.parse(raw) as ManifestBag[];
    let touched = false;
    for (const bag of manifest) {
      if (bag.tagNumber === oldTag) {
        bag.tagNumber = newTag;
        touched = true;
      }
    }
    if (touched) {
      await AsyncStorage.setItem(KEYS.manifest(groupId), JSON.stringify(manifest));
    }
  } catch {
    // Malformed cache — leave it alone; the next manifest fetch will
    // overwrite with fresh server data.
  }
}

/**
 * Rewrite a placeholder tag to the backend-issued tag everywhere it may
 * appear locally: scanned set, cached manifest, queued scans, scan
 * dead-letter, and the exception ops queue / dead-letter (a previously
 * raised exception against the placeholder must retry against the real
 * tag, otherwise the backend would 404 on retry).
 *
 * No-op when `oldTag === newTag`. All updates happen in parallel — they
 * touch independent storage keys.
 */
export async function reconcilePlaceholderTag(
  /**
   * Optional in the flight-only no-tag flow. When undefined we skip the
   * per-group scanned-tags / cached-manifest rewrites (those were never
   * written for groupless no-tag bags) and only rewrite tag references
   * inside queued ops by tag identity.
   */
  groupId: string | undefined,
  oldTag: string,
  newTag: string,
): Promise<void> {
  if (!oldTag || !newTag || oldTag === newTag) return;

  const rewriteScans = async (key: string) => {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return;
    try {
      const list = JSON.parse(raw) as QueuedScan[];
      let touched = false;
      for (const s of list) {
        if (s.tagNumber === oldTag && (!groupId || s.groupId === groupId)) {
          s.tagNumber = newTag;
          touched = true;
        }
      }
      if (touched) await AsyncStorage.setItem(key, JSON.stringify(list));
    } catch {
      // Skip malformed payloads.
    }
  };

  const rewriteOps = async (key: string) => {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return;
    try {
      const list = JSON.parse(raw) as QueuedOp[];
      let touched = false;
      for (const op of list) {
        if (
          op.kind === "exception" &&
          op.payload.tagNumber === oldTag &&
          (!groupId || op.payload.groupId === groupId)
        ) {
          op.payload.tagNumber = newTag;
          touched = true;
        }
      }
      if (touched) await AsyncStorage.setItem(key, JSON.stringify(list));
    } catch {
      // Skip malformed payloads.
    }
  };

  await Promise.all([
    // The per-group caches only exist when we actually have a groupId
    // (legacy pinned-group flow). For groupless no-tag bags those
    // caches were never written, so there's nothing to rewrite.
    groupId ? replaceScannedTag(groupId, oldTag, newTag) : Promise.resolve(),
    groupId ? replaceManifestTag(groupId, oldTag, newTag) : Promise.resolve(),
    rewriteScans(KEYS.queue),
    rewriteScans(KEYS.deadLetter),
    rewriteOps(KEYS.opQueueException),
    rewriteOps(KEYS.opDeadLetterException),
  ]);
}

export async function clearAll() {
  const keys = await AsyncStorage.getAllKeys();
  const ours = keys.filter((k) => k.startsWith("sgs:"));
  if (ours.length) await AsyncStorage.multiRemove(ours);
}
