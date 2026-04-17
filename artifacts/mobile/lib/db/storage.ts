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
  lastSync: (groupId: string) => `sgs:lastSync:${groupId}`,
};

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

export async function clearAll() {
  const keys = await AsyncStorage.getAllKeys();
  const ours = keys.filter((k) => k.startsWith("sgs:"));
  if (ours.length) await AsyncStorage.multiRemove(ours);
}
