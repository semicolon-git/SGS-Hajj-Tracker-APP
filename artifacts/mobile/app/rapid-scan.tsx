import { Feather } from "@expo/vector-icons";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FlashOverlay } from "@/components/FlashOverlay";
import { PrimaryButton } from "@/components/PrimaryButton";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatusPill } from "@/components/StatusPill";
import { FONTS } from "@/constants/branding";
import colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";
import { useLocale } from "@/contexts/LocaleContext";
import { useScanQueue } from "@/contexts/ScanQueueContext";
import { useFlashFeedback } from "@/hooks/useFlashFeedback";
import { useScannerMode, useZebraScanner } from "@/hooks/useScanner";
import {
  cacheFlights,
  cacheGroups,
  cacheManifest,
  getCachedFlights,
  getCachedGroups,
  getCachedManifest,
  getLastSync,
  getOrCreateDeviceId,
} from "@/lib/db/storage";
import {
  sgsApi,
  type BagGroup,
  type Flight,
  type HajjCheckResult,
  type ManifestBag,
} from "@/lib/api/sgs";
import { classifyHajjCheck, normalizeTag } from "@/lib/scanLogic";

const DEBOUNCE_MS = 1500;

/** Same logic as scan.tsx's formatCachedAt — kept local to avoid forcing
 * a shared util just for two callsites. Renders a same-day timestamp as
 * HH:MM and prior-day timestamps as relative ("Xh ago"). */
function formatRapidCachedAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const minutes = Math.max(1, Math.floor((now.getTime() - d.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type Counts = { green: number; amber: number; red: number };

/**
 * Rapid Scan — distraction-free belt-clearing screen for admin / duty
 * manager / airport ops staff. Flight-pinned: the operator picks a
 * flight up front, the screen pre-fetches that flight's full manifest
 * (groups + per-group bags) into memory + offline cache, and then
 * resolves every subsequent scan against the cached manifest first
 * (`isHajjBag === true` → green if accommodation present, amber if
 * not). Tags not on the cached manifest fall through to the existing
 * `/api/bags/hajj-check` path. Greens + ambers enqueue through the
 * regular ScanQueueContext (event type COLLECTED_FROM_BELT). Reds are
 * fire-and-forget logged to the dedicated red-scan endpoint.
 */
export default function RapidScanScreen() {
  const router = useRouter();
  const auth = useAuth();
  const queue = useScanQueue();
  const { effective: scannerSource } = useScannerMode();
  const isZebra = scannerSource === "zebra";
  const insets = useSafeAreaInsets();
  const { t, isRTL } = useLocale();
  const { flash, trigger, clearFlash } = useFlashFeedback();

  const [permission, requestPermission] = useCameraPermissions();
  const [counts, setCounts] = useState<Counts>({ green: 0, amber: 0, red: 0 });
  const [busy, setBusy] = useState(false);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [flightsLoading, setFlightsLoading] = useState(false);
  const lastScan = useRef<{ tag: string; at: number } | null>(null);
  const deviceIdRef = useRef<string | null>(null);

  useEffect(() => {
    getOrCreateDeviceId().then((id) => {
      deviceIdRef.current = id;
    });
  }, []);

  // ---------------------------------------------------------------
  // Flight list (lazy: only fetched when the picker is opened).
  // ---------------------------------------------------------------
  const loadFlights = useCallback(async () => {
    setFlightsLoading(true);
    try {
      try {
        const fresh = await sgsApi.flights();
        setFlights(fresh);
        await cacheFlights(fresh);
      } catch {
        const cached = await getCachedFlights<Flight[]>();
        if (cached.data) setFlights(cached.data);
      }
    } finally {
      setFlightsLoading(false);
    }
  }, []);

  // ---------------------------------------------------------------
  // Flight-pinned manifest pre-fetch. Mirrors `app/scan.tsx`:
  // groups query → parallel per-group manifest queries → merged
  // tag→ManifestBag lookup. Each manifest is also written through to
  // the offline cache so the next session opens instantly even on a
  // weak airport link.
  // ---------------------------------------------------------------
  const flightId = flight?.id ?? null;
  const groupsQ = useQuery({
    queryKey: ["rapid-scan", "groups", flightId],
    queryFn: async () => {
      try {
        const fresh = await sgsApi.groups(flightId as string);
        await cacheGroups(flightId as string, fresh);
        return { groups: fresh, fromCache: false };
      } catch {
        const cached = await getCachedGroups<BagGroup[]>(flightId as string);
        if (cached.data) return { groups: cached.data, fromCache: true };
        throw new Error("groups_unavailable");
      }
    },
    enabled: !!flightId,
    staleTime: 60_000,
  });
  const groups = groupsQ.data?.groups ?? [];

  const manifestQs = useQueries({
    queries: groups.map((g) => ({
      queryKey: ["rapid-scan", "manifest", g.id],
      queryFn: async () => {
        try {
          const fresh = await sgsApi.manifest(g.id);
          await cacheManifest(g.id, fresh);
          return { bags: fresh, fromCache: false, cachedAt: null as string | null };
        } catch (err) {
          // Offline fallback. Rethrow if the cache is also empty so
          // the screen surfaces a retry instead of running with a
          // partial manifest.
          const cached = await getCachedManifest(g.id);
          if (cached) {
            const cachedAt = await getLastSync(g.id);
            return { bags: cached, fromCache: true, cachedAt };
          }
          throw err;
        }
      },
      enabled: !!flightId,
      staleTime: 60_000,
      retry: 0,
    })),
  });

  // Merged tag → ManifestBag lookup across every group on this flight,
  // plus IATA license-plate aliases so an agent scanning the airline
  // tag still resolves correctly. Built once per render from the
  // manifest queries' resolved data.
  const mergedManifest = useMemo(() => {
    const out = new Map<string, ManifestBag>();
    manifestQs.forEach((q) => {
      for (const bag of q.data?.bags ?? []) {
        out.set(bag.tagNumber, bag);
        if (bag.iataTag) out.set(bag.iataTag, bag);
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestQs.map((q) => q.dataUpdatedAt).join("|")]);

  // ---------------------------------------------------------------
  // Stale-cache surface (mirrors `app/scan.tsx`). Hard failures still
  // route to <ManifestErrorView/>; `manifestStale` only fires when the
  // live fetch failed but cached data carried us through.
  // ---------------------------------------------------------------
  const groupsFromCache = groupsQ.data?.fromCache ?? false;
  const staleManifestQs = manifestQs.filter((q) => q.data?.fromCache);
  const oldestCachedAt = useMemo(() => {
    const stamps: string[] = [];
    for (const q of staleManifestQs) {
      if (q.data?.cachedAt) stamps.push(q.data.cachedAt);
    }
    if (!stamps.length) return null;
    stamps.sort();
    return stamps[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staleManifestQs.length, staleManifestQs.map((q) => q.data?.cachedAt).join("|")]);

  // groupId → accommodationName. Uses ONLY the explicit field, never
  // the `groupNumber` display fallback — otherwise the amber bucket
  // (Hajj bag with missing accommodation) would never fire.
  const groupAccommodation = useMemo(() => {
    const out = new Map<string, string | undefined>();
    for (const g of groups) {
      out.set(g.id, g.accommodationName);
    }
    return out;
  }, [groups]);

  // Readiness/error guards derived from query state. A flight with
  // zero groups is valid — operator just sees the idle surface.
  const manifestLoading =
    !!flightId &&
    (groupsQ.isLoading ||
      groupsQ.isFetching ||
      manifestQs.some((q) => q.isLoading || q.isFetching));
  // Any failed manifest query is a hard failure (queryFn already
  // tried the disk cache).
  const manifestError =
    !!flightId &&
    (groupsQ.isError || manifestQs.some((q) => q.isError));
  const manifestReady =
    !!flightId && groupsQ.isSuccess && !manifestLoading && !manifestError;

  const totalManifestSize = mergedManifest.size;

  // ---------------------------------------------------------------
  // Camera permission (consumer phones only) — only request once a
  // flight is pinned + manifest is ready, so the camera doesn't
  // light up before the operator can do anything with it.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (
      !isZebra &&
      manifestReady &&
      permission &&
      !permission.granted &&
      permission.canAskAgain
    ) {
      requestPermission();
    }
  }, [isZebra, manifestReady, permission, requestPermission]);

  // ---------------------------------------------------------------
  // Scan handler.
  // ---------------------------------------------------------------
  const handleScan = useCallback(
    async (raw: string) => {
      const tag = normalizeTag(raw);
      if (!tag) return;
      // Manifest must be loaded before we accept scans. The empty
      // state hides the camera/Zebra surface, but defensive guard
      // here so a stray scan event during the load can't slip through.
      if (!flight || !manifestReady) return;

      const now = Date.now();
      // Same debounce window as the regular scan screen — prevents the
      // Zebra trigger from re-firing the same payload twice in a row
      // and avoids double-counting an amber/red.
      if (
        lastScan.current &&
        lastScan.current.tag === tag &&
        now - lastScan.current.at < DEBOUNCE_MS
      ) {
        return;
      }
      // Hard guard against parallel runs.
      if (busy) return;
      lastScan.current = { tag, at: now };
      setBusy(true);
      try {
        // ---------- Local-first resolution ----------
        const cached = mergedManifest.get(tag);
        if (cached) {
          // A match against the flight's cached manifest. The bag is
          // by construction on a manifested Hajj flight; treat
          // `isHajjBag === false` as the only explicit way to flip
          // it red (older API builds omit the field, in which case
          // we trust the manifest).
          const isHajj = cached.isHajjBag !== false;
          const accommodation = groupAccommodation.get(cached.groupId);
          let status: "green" | "amber" | "red";
          let title: string;
          let subtitle: string | undefined;
          let hint: string | undefined;
          let hapticKey: "success" | "warning" | "error";
          if (!isHajj) {
            status = "red";
            title = t("rapidRedNonHajj");
            subtitle = cached.tagNumber;
            hapticKey = "error";
          } else if (accommodation) {
            status = "green";
            title = accommodation;
            subtitle = cached.pilgrimName || cached.tagNumber;
            hapticKey = "success";
          } else {
            status = "amber";
            title = t("rapidAmberTitle");
            subtitle = cached.pilgrimName || cached.tagNumber;
            hapticKey = "warning";
          }

          const flashColor =
            status === "green" ? "green" : status === "amber" ? "yellow" : "red";
          // Sticky flash — duration 0 means the panel stays on screen
          // until the next scan replaces it.
          trigger(
            { color: flashColor, title, subtitle, hint },
            hapticKey,
            0,
          );
          setCounts((c) => ({ ...c, [status]: c[status] + 1 }));

          if (status === "green" || status === "amber") {
            await queue.enqueue({
              tagNumber: cached.tagNumber,
              groupId: cached.groupId,
              flightId: flight.id,
              scannedAt: new Date(now).toISOString(),
              source: isZebra ? "zebra" : "camera",
              deviceId: deviceIdRef.current ?? undefined,
            });
          } else {
            sgsApi
              .logRedScan({
                tagNumber: cached.tagNumber,
                reason: "non_hajj",
                flightId: flight.id,
              })
              .catch(() => undefined);
          }
          return;
        }

        // ---------- Fallback: hajj-check + rescue ----------
        // Tag isn't on this flight's cached manifest. Defer to the
        // existing hajj-check classifier (same path as scan.tsx),
        // then enforce flight membership before promoting to
        // green/amber so a bag belonging to another flight can never
        // increment this flight's counters.
        let result: HajjCheckResult;
        try {
          result = await sgsApi.hajjCheck(tag);
        } catch {
          trigger(
            { color: "red", title: t("rapidLookupFailed"), subtitle: tag },
            "error",
            0,
          );
          return;
        }

        // Existing rescue: hajj-check sometimes returns unknown_tag
        // for bags that genuinely exist on a Hajj manifest. Race a
        // flight-scoped bags lookup against a short timeout to
        // promote those to amber. The lookup is flight-scoped so it
        // also doubles as our cross-flight corroboration check.
        let rescued: Awaited<ReturnType<typeof sgsApi.findBagByTag>> = null;
        if (result.status === "red" && result.reason === "unknown_tag") {
          const FALLBACK_TIMEOUT_MS = 1500;
          const raced = await Promise.race<
            | Awaited<ReturnType<typeof sgsApi.findBagByTag>>
            | "__timeout__"
          >([
            sgsApi.findBagByTag(tag, { flightId: flight.id }),
            new Promise<"__timeout__">((resolve) =>
              setTimeout(() => resolve("__timeout__"), FALLBACK_TIMEOUT_MS),
            ),
          ]);
          if (raced && raced !== "__timeout__") rescued = raced;
          if (rescued && rescued.isHajjBag === true) {
            result = {
              status: "amber",
              bagTag: rescued.bagTag,
              pilgrimName: rescued.pilgrimName,
              message: t("rapidAmberDegradedHint"),
              reason: "lookup_degraded",
            };
          }
        }

        // Cross-flight guard. If hajj-check (or the rescue) classified
        // the bag green/amber, confirm it actually belongs to the
        // selected flight before letting it count. We reuse `rescued`
        // when we already fetched it; otherwise do a flight-scoped
        // lookup now. A null/wrong-flight result downgrades to red
        // unknown_tag rather than polluting this flight's counters.
        if (result.status === "green" || result.status === "amber") {
          if (!rescued) {
            rescued = await sgsApi.findBagByTag(tag, {
              flightId: flight.id,
            });
          }
          if (!rescued || rescued.flightId !== flight.id) {
            result = {
              status: "red",
              bagTag: tag,
              reason: "unknown_tag",
              message: t("rapidRedUnknown"),
            };
            rescued = null;
          }
        }

        const decision = classifyHajjCheck(result, t as (k: string) => string);
        if (result.reason === "lookup_degraded" && decision.flash === "yellow") {
          decision.hint = t("rapidAmberDegradedHint");
        }
        trigger(
          {
            color: decision.flash,
            title: decision.title,
            subtitle: decision.subtitle,
            hint: decision.hint,
          },
          decision.hapticKey,
          0,
        );
        setCounts((c) => ({ ...c, [result.status]: c[result.status] + 1 }));

        if (result.status === "green" || result.status === "amber") {
          await queue.enqueue({
            tagNumber: result.bagTag,
            // Use the corroborated group when we have it; otherwise
            // omit so the server resolves rather than misattributing.
            groupId: rescued?.flightGroupId,
            flightId: flight.id,
            scannedAt: new Date(now).toISOString(),
            source: isZebra ? "zebra" : "camera",
            deviceId: deviceIdRef.current ?? undefined,
          });
        } else {
          sgsApi
            .logRedScan({
              tagNumber: result.bagTag,
              reason: result.reason ?? "unknown_tag",
              flightId: flight.id,
            })
            .catch(() => undefined);
        }
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      flight,
      groupAccommodation,
      isZebra,
      manifestReady,
      mergedManifest,
      queue,
      t,
      trigger,
    ],
  );

  // Only subscribe to the Zebra trigger when a flight + manifest are
  // ready — the empty state shouldn't accept scans.
  useZebraScanner(handleScan, { enabled: manifestReady });

  const [cameraActive, setCameraActive] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setCameraActive(true);
      return () => setCameraActive(false);
    }, []),
  );

  // Defense in depth — the route guard in `_layout.tsx` already blocks
  // ineligible roles, but the screen also short-circuits so a stale
  // render between guard and redirect can't leak the camera.
  const role = auth.user?.role ?? "";
  const canRapidScan =
    role === "admin" || role === "duty_manager" || role === "airport_ops";
  if (!auth.user || !canRapidScan) return null;

  // Switching flights resets the running counters and clears the
  // sticky result panel back to the empty state.
  const onPickFlight = (next: Flight | null) => {
    setFlight(next);
    setCounts({ green: 0, amber: 0, red: 0 });
    clearFlash();
    lastScan.current = null;
    setPickerOpen(false);
  };

  return (
    <View style={styles.flex}>
      <ScreenHeader
        title={t("rapidScan")}
        subtitle={flight ? flight.flightNumber : t("noFlight")}
        onBack={() => router.back()}
        right={
          <View style={styles.headerRight}>
            <StatusPill
              online={queue.online}
              queueSize={queue.queueSize}
              syncing={queue.syncing}
            />
          </View>
        }
      />

      <View style={styles.flightBar}>
        <Pressable
          onPress={() => {
            setPickerOpen(true);
            if (flights.length === 0) loadFlights();
          }}
          style={({ pressed }) => [
            styles.flightChip,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Feather name="navigation" size={14} color={colors.sgs.textPrimary} />
          <Text style={[styles.flightChipText, isRTL && { writingDirection: "rtl" }]}>
            {flight ? flight.flightNumber : t("pickFlight")}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setCounts({ green: 0, amber: 0, red: 0 });
            clearFlash();
          }}
          style={({ pressed }) => [styles.clearBtn, pressed && { opacity: 0.7 }]}
        >
          <Feather name="rotate-ccw" size={14} color={colors.sgs.textMuted} />
          <Text style={styles.clearBtnText}>{t("clearSession")}</Text>
        </Pressable>
      </View>

      <View style={styles.countsRow}>
        <CountTile color={colors.sgs.flashGreen} label={t("greens")} value={counts.green} />
        <CountTile color={colors.sgs.flashAmber} label={t("ambers")} value={counts.amber} />
        <CountTile color={colors.sgs.flashRed} label={t("reds")} value={counts.red} />
      </View>

      {manifestReady && (groupsFromCache || staleManifestQs.length > 0) ? (
        <View style={styles.staleBanner}>
          <Feather name="cloud-off" size={14} color={colors.sgs.black} />
          <Text style={[styles.staleText, isRTL && { writingDirection: "rtl" }]}>
            <Text style={styles.staleTitle}>{t("manifestStaleTitle")}</Text>
            {oldestCachedAt
              ? ` · ${t("manifestStaleBody").replace("{time}", formatRapidCachedAt(oldestCachedAt))}`
              : ""}
          </Text>
          <Pressable
            onPress={() => {
              groupsQ.refetch();
              manifestQs.forEach((q) => q.refetch());
            }}
            style={styles.staleRetry}
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
          >
            <Text style={styles.staleRetryTxt}>{t("retry")}</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.body}>
        {!flight ? (
          <PickFlightEmpty
            onPick={() => {
              setPickerOpen(true);
              if (flights.length === 0) loadFlights();
            }}
          />
        ) : manifestLoading ? (
          <ManifestLoadingView />
        ) : manifestError ? (
          <ManifestErrorView
            onRetry={() => {
              groupsQ.refetch();
              manifestQs.forEach((q) => {
                if (q.isError) q.refetch();
              });
            }}
          />
        ) : !manifestReady ? null : isZebra ? (
          <ZebraIdleView totalManifestSize={totalManifestSize} />
        ) : permission?.granted ? (
          cameraActive ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{
                barcodeTypes: ["code128", "itf14", "code39", "pdf417"],
              }}
              onBarcodeScanned={(r) => handleScan(r.data)}
            />
          ) : null
        ) : (
          <CameraPermissionView
            canAsk={permission?.canAskAgain ?? true}
            onRequest={requestPermission}
          />
        )}

        {flight && manifestReady && !isZebra && permission?.granted ? (
          <View pointerEvents="none" style={styles.reticle}>
            <View style={styles.reticleBox} />
            <Text style={[styles.reticleHint, isRTL && { writingDirection: "rtl" }]}>
              {t("alignTag")}
            </Text>
          </View>
        ) : null}

        {flash ? (
          <FlashOverlay
            color={flash.color}
            title={flash.title}
            subtitle={flash.subtitle}
            hint={flash.hint}
          />
        ) : null}

        {busy ? (
          <View style={styles.busyDot}>
            <ActivityIndicator color={colors.sgs.green} />
          </View>
        ) : null}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]} />

      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t("pickFlight")}</Text>
            {flightsLoading ? (
              <View style={{ padding: 24, alignItems: "center" }}>
                <ActivityIndicator color={colors.sgs.green} />
              </View>
            ) : (
              <FlatList
                data={flights}
                keyExtractor={(f) => f.id}
                ItemSeparatorComponent={() => (
                  <View style={{ height: 1, backgroundColor: colors.sgs.border }} />
                )}
                style={{ maxHeight: 360 }}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => onPickFlight(item)}
                    style={({ pressed }) => [
                      styles.flightRow,
                      pressed && { backgroundColor: colors.sgs.surfaceElevated },
                    ]}
                  >
                    <Text style={styles.flightRowTitle}>{item.flightNumber}</Text>
                    <Text style={styles.flightRowSub}>{item.destination}</Text>
                  </Pressable>
                )}
              />
            )}
            <View style={{ height: 12 }} />
            <PrimaryButton
              variant="ghost"
              label={t("cancel")}
              onPress={() => setPickerOpen(false)}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function CountTile({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <View style={[styles.countTile, { borderColor: color }]}>
      <Text style={[styles.countValue, { color }]}>{value}</Text>
      <Text style={styles.countLabel}>{label}</Text>
    </View>
  );
}

function PickFlightEmpty({ onPick }: { onPick: () => void }) {
  const { t, isRTL } = useLocale();
  return (
    <View style={styles.emptyWrap}>
      <Feather name="navigation" size={48} color={colors.sgs.textMuted} />
      <Text style={[styles.emptyTitle, isRTL && { writingDirection: "rtl" }]}>
        {t("rapidScanPickFlightTitle")}
      </Text>
      <Text style={[styles.emptyBody, isRTL && { writingDirection: "rtl" }]}>
        {t("rapidScanPickFlightBody")}
      </Text>
      <PrimaryButton label={t("rapidScanPickFlightCta")} onPress={onPick} />
    </View>
  );
}

function ManifestLoadingView() {
  const { t, isRTL } = useLocale();
  return (
    <View style={styles.emptyWrap}>
      <ActivityIndicator color={colors.sgs.green} size="large" />
      <Text style={[styles.emptyBody, isRTL && { writingDirection: "rtl" }]}>
        {t("rapidScanLoadingManifest")}
      </Text>
    </View>
  );
}

function ManifestErrorView({ onRetry }: { onRetry: () => void }) {
  const { t, isRTL } = useLocale();
  return (
    <View style={styles.emptyWrap}>
      <Feather name="alert-triangle" size={40} color={colors.sgs.flashRed} />
      <Text style={[styles.emptyBody, isRTL && { writingDirection: "rtl" }]}>
        {t("rapidScanManifestError")}
      </Text>
      <PrimaryButton label={t("retry")} onPress={onRetry} />
    </View>
  );
}

function ZebraIdleView({
  totalManifestSize,
}: {
  totalManifestSize: number;
}) {
  const { t } = useLocale();
  return (
    <View style={styles.zebraWrap}>
      <Feather
        name="zap"
        size={48}
        color={colors.sgs.green}
        style={{ opacity: 0.85 }}
      />
      <Text style={styles.zebraTitle}>{t("rapidScanIdle")}</Text>
      <Text style={styles.zebraSub}>
        {totalManifestSize > 0
          ? `${totalManifestSize} ${t("bags")}`
          : t("zebraIdleSub")}
      </Text>
    </View>
  );
}

function CameraPermissionView({
  canAsk,
  onRequest,
}: {
  canAsk: boolean;
  onRequest: () => void;
}) {
  const { t } = useLocale();
  return (
    <View style={styles.permWrap}>
      <Feather name="camera-off" size={48} color={colors.sgs.textMuted} />
      <Text style={styles.permTitle}>{t("cameraNeeded")}</Text>
      <Text style={styles.permSub}>{t("cameraGrant")}</Text>
      {canAsk ? (
        <PrimaryButton label={t("allowCamera")} onPress={onRequest} />
      ) : (
        <>
          <Text style={styles.permSub}>{t("cameraSettings")}</Text>
          <PrimaryButton
            label={t("openSettings")}
            onPress={() => Linking.openSettings()}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  body: { flex: 1, position: "relative", overflow: "hidden" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  flightBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.sgs.surface,
    borderBottomColor: colors.sgs.border,
    borderBottomWidth: 1,
    gap: 8,
  },
  flightChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.sgs.surfaceElevated,
    borderColor: colors.sgs.border,
    borderWidth: 1,
  },
  flightChipText: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
  },
  clearBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  clearBtnText: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.bodyMedium,
    fontSize: 12,
  },
  countsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.sgs.black,
  },
  countTile: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: colors.sgs.surface,
  },
  countValue: {
    fontFamily: FONTS.bodyBold,
    fontSize: 24,
  },
  countLabel: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 11,
    marginTop: 2,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  staleBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.sgs.flashAmber,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  staleText: {
    flex: 1,
    color: colors.sgs.black,
    fontFamily: FONTS.body,
    fontSize: 12,
  },
  staleTitle: {
    fontFamily: FONTS.bodyBold,
  },
  staleRetry: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  staleRetryTxt: {
    color: colors.sgs.black,
    fontFamily: FONTS.bodyBold,
    fontSize: 11,
    textDecorationLine: "underline",
  },
  reticle: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticleBox: {
    width: "70%",
    aspectRatio: 1,
    maxHeight: "60%",
    borderColor: colors.sgs.green,
    borderWidth: 3,
    borderRadius: 14,
  },
  reticleHint: {
    position: "absolute",
    bottom: 32,
    color: "#FFF",
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  busyDot: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 999,
    padding: 6,
  },
  zebraWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 32,
  },
  zebraTitle: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 26,
  },
  zebraSub: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 15,
    textAlign: "center",
  },
  permWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 32,
  },
  permTitle: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 22,
  },
  permSub: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 14,
    textAlign: "center",
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 22,
    textAlign: "center",
  },
  emptyBody: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 14,
    textAlign: "center",
  },
  footer: {
    backgroundColor: colors.sgs.black,
    borderTopWidth: 1,
    borderTopColor: colors.sgs.border,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  modalTitle: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 18,
    marginBottom: 12,
  },
  flightRow: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  flightRowTitle: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 15,
  },
  flightRowSub: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 12,
    marginTop: 2,
  },
});
