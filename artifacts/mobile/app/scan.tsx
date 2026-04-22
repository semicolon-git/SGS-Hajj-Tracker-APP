import { Feather } from "@expo/vector-icons";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  ToastAndroid,
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
import { useSession } from "@/contexts/SessionContext";
import { useFlashFeedback } from "@/hooks/useFlashFeedback";
import {
  isDataWedgeAvailable,
  useScannerMode,
  useZebraScanRaw,
  useZebraScanner,
} from "@/hooks/useScanner";
import { decideScan, normalizeTag, parseBtpPdf417 } from "@/lib/scanLogic";
import { sgsApi, type BagGroup, type ManifestBag } from "@/lib/api/sgs";
import {
  cacheGroups,
  cacheManifest,
  getCachedGroups,
  getCachedManifest,
  getDebugRawScan,
  getLastSync,
  getOrCreateDeviceId,
  getScannedTags,
  markTagScanned,
  updateCachedManifestBagStatus,
} from "@/lib/db/storage";
import { Linking } from "react-native";

type StringKeyT = Parameters<ReturnType<typeof useLocale>["t"]>[0];

function statusForGroup(g: BagGroup): "PENDING" | "IN_PROGRESS" | "COMPLETE" {
  if (g.expectedBags > 0 && g.scannedBags >= g.expectedBags) return "COMPLETE";
  if (g.scannedBags > 0) return "IN_PROGRESS";
  return "PENDING";
}

const DEBOUNCE_MS = 1500;
const DEBOUNCE_RED_MS = 2000;
// Receiving-screen result hold. Per duty-manager feedback the flash
// panel needs to dwell long enough for an agent reading from across
// the cart to register colour + tag/pilgrim before the next scan
// fires. Overrides the per-colour `FLASH_DURATIONS` defaults at the
// callsite so other screens (Rapid Scan, Bulk Receive) keep their
// own dwell tuning.
const RECEIVING_FLASH_MS = 3000;

/**
 * Render an ISO timestamp as a short, locale-friendly time-of-day string
 * (e.g. "14:32") for the stale-manifest banner. Falls back to a relative
 * "Xm ago" if the cached timestamp is from a different calendar day so an
 * agent reopening the app the next morning sees how stale the cache is.
 */
function formatCachedAt(iso: string): string {
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

export default function ScanScreen() {
  const router = useRouter();
  const auth = useAuth();
  const session = useSession();
  const queue = useScanQueue();
  const { effective: scannerSource } = useScannerMode();
  // Keep `isZebra` as the local boolean used through this screen so the
  // existing render branches don't churn — it now reflects the *effective*
  // source (auto-detect + manual override) rather than raw device
  // detection.
  const isZebra = scannerSource === "zebra";
  const { flash, trigger } = useFlashFeedback();
  const insets = useSafeAreaInsets();
  const { t, isRTL } = useLocale();

  const queryClient = useQueryClient();

  const [permission, requestPermission] = useCameraPermissions();
  const [lastTag, setLastTag] = useState<string | null>(null);
  // Per-group local scan deltas keyed by groupId. The server-authoritative
  // counter lives in the groups query (refetched after each green scan);
  // this local map gives an instant tick + pulse before the network
  // round-trip lands.
  const [scanDelta, setScanDelta] = useState<Record<string, number>>({});
  const [pulseGroupId, setPulseGroupId] = useState<string | null>(null);
  const pulseAnim = useRef(new Animated.Value(0)).current;
  // "Show raw scan" diagnostic banner — opt-in from Settings. Holds the
  // most recent raw barcode payload + symbology so the agent can confirm
  // the camera is actually seeing tags. Auto-clears after ~2s.
  const [debugRawScan, setDebugRawScanState] = useState(false);
  const [rawBanner, setRawBanner] = useState<{ data: string; type: string } | null>(null);
  const rawBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track when the most recent Zebra scan event arrived. If the screen
  // has been focused for >30s on a Zebra device with no scan events at
  // all, show a soft warning ribbon pointing the agent at Reconfigure
  // scanner. `null` means the screen has not been focused yet (or has
  // been blurred), so we suppress the ribbon until the agent is
  // actively trying to scan.
  const [zebraFocusedAt, setZebraFocusedAt] = useState<number | null>(null);
  const [lastZebraScanAt, setLastZebraScanAt] = useState<number | null>(null);
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  // DataWedge presence probe: when the native bridge reports the package
  // isn't installed at all, surface the trigger-health banner immediately
  // (no 30s wait) with a clearer subtitle. Re-checked on every focus so
  // sideloading DataWedge mid-shift recovers the moment the screen comes
  // back. `null` while we wait for the first probe to resolve.
  const [dataWedgeMissing, setDataWedgeMissing] = useState<boolean | null>(null);
  // Per-session dismiss for the trigger-health banner. The agent can hide
  // it after acknowledging — no point in nagging during slow belt
  // periods. Resets on screen blur so reopening the scan screen surfaces
  // it again if the device is still misconfigured.
  const [triggerBannerDismissed, setTriggerBannerDismissed] = useState(false);
  // Tracks the last tag that produced a red flash (unknown / wrong-group /
  // duplicate). Used as the prefill source when the agent taps "Exception"
  // so the form is seeded with the tag that actually needs an exception
  // raised against it, not just the most recent successful scan.
  const [lastFailedTag, setLastFailedTag] = useState<string | null>(null);
  const lastScan = useRef<{ tag: string; at: number; flash?: string } | null>(null);
  const deviceIdRef = useRef<string | null>(null);

  // Resolve the stable per-install device id once on mount so every scan
  // can include it on the wire without an awaited storage round-trip in
  // the hot path.
  useEffect(() => {
    getOrCreateDeviceId().then((id) => {
      deviceIdRef.current = id;
    });
  }, []);

  // Live group list for the active flight. Powers the cards grid and the
  // flight-level totals shown in the header. Falls back to the disk cache
  // when the network call fails so a flaky link doesn't blank the screen,
  // and tracks `fromCache` so the manifest banner can warn the operator
  // they're working off stale data.
  const flightId = session.session?.flight.id ?? null;
  const groupsQ = useQuery({
    queryKey: ["groups", flightId],
    queryFn: async () => {
      const fid = flightId as string;
      try {
        const fresh = await sgsApi.groups(fid);
        await cacheGroups(fid, fresh);
        return { groups: fresh, fromCache: false };
      } catch (err) {
        const cached = await getCachedGroups<BagGroup[]>(fid);
        if (cached.data) return { groups: cached.data, fromCache: true };
        throw err;
      }
    },
    enabled: !!flightId,
    staleTime: 30_000,
  });
  const groups = groupsQ.data?.groups ?? [];

  // Reset optimistic per-group deltas every time the server's `groups`
  // payload refreshes — the new `scannedBags` already incorporates any
  // scans we previously bumped locally. Without this reset, every
  // queue-drained scan would be double-counted (delta + server) once
  // the invalidate-triggered refetch landed.
  useEffect(() => {
    setScanDelta({});
  }, [groupsQ.dataUpdatedAt]);

  // Parallel-fetch every group's manifest so `decideScan` can match a
  // tag locally to *any* group on this flight (not just a single pinned
  // one). Each manifest is also written through to the offline cache so
  // a poor link mid-shift still resolves scans correctly.
  const manifestQs = useQueries({
    queries: groups.map((g) => ({
      queryKey: ["manifest", g.id],
      queryFn: async () => {
        try {
          const fresh = await sgsApi.manifest(g.id);
          await cacheManifest(g.id, fresh);
          return { bags: fresh, fromCache: false, cachedAt: null as string | null };
        } catch (err) {
          const cached = await getCachedManifest(g.id);
          if (cached) {
            const cachedAt = await getLastSync(g.id);
            return { bags: cached, fromCache: true, cachedAt };
          }
          // No cache to fall back to — surface as a hard failure so the
          // banner appears instead of letting the scanner accept tags
          // against an empty manifest (which flashes red on every scan).
          throw err;
        }
      },
      enabled: !!flightId,
      staleTime: 60_000,
      retry: 0,
    })),
  });

  // Merged tag → ManifestBag lookup across every group on this flight.
  // Built once per render from the manifest queries' resolved data.
  // Includes IATA license-plate aliases so an agent scanning the airline
  // tag still resolves to the correct bag + group.
  const mergedManifest = useMemo(() => {
    const out = new Map<string, ManifestBag>();
    manifestQs.forEach((q) => {
      for (const bag of q.data?.bags ?? []) {
        out.set(bag.tagNumber, bag);
        if (bag.iataTag) out.set(bag.iataTag, bag);
      }
    });
    return out;
  }, [manifestQs]);

  // ---------------------------------------------------------------
  // Manifest health (drives the load-failure / stale-cache banners).
  //   - manifestErrorHard : the live fetch failed AND no usable cache
  //     exists for at least one source (groups or any per-group
  //     manifest). Operator must retry or change device.
  //   - manifestStale    : at least one source fell back to cached
  //     data successfully. Scans still work but the operator should
  //     know they're on stale data.
  //   - oldestCachedAt   : earliest cache timestamp across stale
  //     sources, used to render a single "last updated" string.
  // ---------------------------------------------------------------
  const manifestErrorHard =
    !!flightId && (groupsQ.isError || manifestQs.some((q) => q.isError));
  const groupsFromCache = groupsQ.data?.fromCache ?? false;
  const staleManifestQs = manifestQs.filter((q) => q.data?.fromCache);
  const manifestStale =
    !!flightId &&
    !manifestErrorHard &&
    (groupsFromCache || staleManifestQs.length > 0);
  const oldestCachedAt = useMemo(() => {
    if (!manifestStale) return null;
    const stamps: string[] = [];
    for (const q of staleManifestQs) {
      if (q.data?.cachedAt) stamps.push(q.data.cachedAt);
    }
    if (!stamps.length) return null;
    stamps.sort();
    return stamps[0] ?? null;
  }, [manifestStale, staleManifestQs]);

  // Refetch every manifest query unconditionally on Retry — both
  // hard-failure and stale-cache states need a fresh network attempt,
  // and stale queries report `isSuccess` (not `isError`), so a guard
  // on `isError` would silently no-op the stale-banner Retry button.
  const retryManifest = useCallback(() => {
    groupsQ.refetch();
    manifestQs.forEach((q) => q.refetch());
  }, [groupsQ, manifestQs]);

  // Flight-level totals shown in the header. Server-authoritative
  // `scannedBags` from the groups query, plus any local deltas that
  // haven't been refetched yet.
  const flightExpected = groups.reduce((s, g) => s + g.expectedBags, 0);
  const flightScannedServer = groups.reduce((s, g) => s + g.scannedBags, 0);
  const flightDelta = Object.values(scanDelta).reduce((s, n) => s + n, 0);
  const flightScanned = Math.min(
    flightExpected || flightScannedServer + flightDelta,
    flightScannedServer + flightDelta,
  );

  // Auto-request camera permission on consumer phones
  useEffect(() => {
    if (!isZebra && permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [isZebra, permission, requestPermission]);

  // Re-read the diagnostic toggle every time the scan screen is focused
  // so flipping it in Settings takes effect on the next return without
  // needing to remount the app.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      getDebugRawScan().then((on) => {
        if (alive) setDebugRawScanState(on);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  useEffect(() => {
    return () => {
      if (rawBannerTimer.current) clearTimeout(rawBannerTimer.current);
    };
  }, []);

  // Surface every Zebra trigger pull through the same diagnostic banner
  // the camera uses, AND track the timestamp so we can warn the agent
  // when the trigger appears dead. The cleaned-tag handler
  // (useZebraScanner above) still owns the green/red flash + queueing
  // logic — this listener is purely observational.
  useZebraScanRaw(
    useCallback(
      (event) => {
        const now = Date.now();
        setLastZebraScanAt(now);
        if (debugRawScan) {
          setRawBanner({ data: event.data ?? "", type: event.symbology ?? "zebra" });
          if (rawBannerTimer.current) clearTimeout(rawBannerTimer.current);
          rawBannerTimer.current = setTimeout(() => setRawBanner(null), 2000);
        }
      },
      [debugRawScan],
    ),
  );

  // Mark the focus moment for the trigger-health timer, and run a 1s
  // tick while focused so the warning ribbon can appear once the
  // 30s threshold is crossed. The tick stops when the screen blurs
  // so we don't burn battery on a backgrounded scan screen.
  // Resets `lastZebraScanAt` on every focus so each visit to this
  // screen gets its own 30-second observation window — otherwise a
  // single scan from a prior session would suppress the trigger-health
  // warning forever, even after the agent navigates away and comes
  // back to a scanner that has since stopped firing.
  useFocusEffect(
    useCallback(() => {
      if (!isZebra) return;
      setZebraFocusedAt(Date.now());
      setLastZebraScanAt(null);
      setTickNow(Date.now());
      setTriggerBannerDismissed(false);
      // Probe DataWedge presence on every focus — if it isn't installed,
      // we want to show the banner immediately rather than waiting 30s.
      let cancelled = false;
      isDataWedgeAvailable().then((ok) => {
        if (!cancelled) setDataWedgeMissing(!ok);
      });
      const interval = setInterval(() => setTickNow(Date.now()), 1000);
      return () => {
        cancelled = true;
        clearInterval(interval);
        setZebraFocusedAt(null);
        setDataWedgeMissing(null);
      };
    }, [isZebra]),
  );

  const handleScan = useCallback(
    async (raw: string) => {
      if (!session.session) return;
      const sFlightId = session.session.flight.id;
      const tag = normalizeTag(raw);
      if (!tag) return;
      // Manifest hard-failure guard. Without a usable manifest every
      // scan would resolve to NOT IN MANIFEST and quietly enqueue
      // against an empty group set. Block the scan and flash so the
      // agent realises the banner above isn't optional — they need to
      // Retry (or change device) before the trigger does anything
      // useful. Mirrors `rapid-scan.tsx`'s `manifestReady` gate.
      if (manifestErrorHard) {
        trigger(
          {
            color: "red",
            title: t("manifestErrorTitle"),
            subtitle: tag,
            hint: t("manifestErrorBody"),
          },
          "error",
          RECEIVING_FLASH_MS,
        );
        return;
      }
      const now = Date.now();
      const debounceWindow =
        lastScan.current?.flash === "red" ? DEBOUNCE_RED_MS : DEBOUNCE_MS;
      if (
        lastScan.current &&
        lastScan.current.tag === tag &&
        now - lastScan.current.at < debounceWindow
      ) {
        return;
      }
      lastScan.current = { tag, at: now, flash: undefined };

      // Resolve the tag against the merged flight-wide manifest. The
      // matched bag's own `groupId` becomes the authoritative group for
      // this scan — this is what lets one screen drive scans across
      // every group on the flight without forcing the agent to drill
      // down first.
      const matched = mergedManifest.get(tag);
      const matchedGroupId = matched?.groupId;
      const flatManifest = Array.from(
        new Set(Array.from(mergedManifest.values())),
      );

      // Per-group scanned set. Without a known groupId we fall back to
      // an empty set — duplicate detection across groups is best-effort
      // for unmatched tags and doesn't affect the queued payload.
      const scannedTags = matchedGroupId
        ? await getScannedTags(matchedGroupId)
        : new Set<string>();

      // Pass `groupId: undefined` to skip the wrong-group check — the
      // merged manifest already encodes group membership, so any tag
      // present in `flatManifest` is by definition in the right group
      // for this flight.
      let decision = decideScan({
        tagNumber: tag,
        groupId: undefined,
        manifest: flatManifest,
        scannedTags,
      });
      // Group id we'll credit on a green hit. Starts as the cached
      // manifest match; the same-flight rescue below promotes it to
      // the server-resolved group when we manage to look up an
      // off-manifest bag.
      let acceptGroupId = matchedGroupId;
      // Pilgrim name for the subtitle when we resolve a bag via the
      // rescue path (cached manifest already has it on the bag).
      let rescuedPilgrim: string | undefined;

      // ---- Same-flight rescue ----------------------------------------
      // Per the duty-manager feedback: at receiving the only condition
      // for accepting a bag is that it belongs to this flight. If the
      // tag wasn't in the cached manifest but the SGS server confirms
      // it on this flight, treat it as a green COLLECTED and credit
      // the bag's real group automatically. A bag belonging to a
      // different flight (or a tag the server can't resolve at all)
      // keeps the existing red NOT IN MANIFEST behaviour.
      if (decision.title === "NOT IN MANIFEST" && queue.online) {
        const rescued = await sgsApi.findBagByTag(tag, {
          flightId: sFlightId,
        });
        if (
          rescued &&
          rescued.flightId === sFlightId &&
          rescued.flightGroupId
        ) {
          const rescuedGroupId = rescued.flightGroupId;
          acceptGroupId = rescuedGroupId;
          rescuedPilgrim = rescued.pilgrimName;
          // Re-check duplicate against the rescued group's scanned set
          // — without this an agent re-scanning a rescued bag would
          // get a misleading second green/COLLECTED.
          const rescuedScanned = await getScannedTags(rescuedGroupId);
          if (rescuedScanned.has(tag)) {
            decision = {
              flash: "amber",
              title: "Already Scanned",
              subtitle: tag,
              hapticKey: "duplicate",
            };
          } else {
            decision = {
              flash: "green",
              title: "COLLECTED",
              subtitle: rescued.pilgrimName ?? tag,
              hapticKey: "success",
            };
          }
        }
      }
      // ----------------------------------------------------------------

      lastScan.current = { tag, at: now, flash: decision.flash };

      // For green hits, replace the bare "COLLECTED" with a title that
      // carries the destination accommodation so the agent can confirm
      // the bag is heading to the right hotel without needing to drill
      // into the group card. Falls back to "Collected — No Nusuk data"
      // when the accepting group has no accommodation assigned (those
      // bags have no nusuk record bound to them yet on the server).
      if (decision.flash === "green" && acceptGroupId) {
        const acceptingGroup = groups.find((g) => g.id === acceptGroupId);
        const accommodation = acceptingGroup?.accommodationName?.trim();
        decision = {
          ...decision,
          title: accommodation
            ? `${t("collected")} — ${accommodation}`
            : `${t("collected")} — ${t("noNusukData")}`,
        };
      }

      // Localize the receiving red/orange "Bag not found in this flight"
      // title (set in scanLogic.ts) so Arabic agents see the same
      // wording the Rapid Scan red title uses (#56).
      if (decision.title === "Bag not found in this flight") {
        decision = { ...decision, title: t("rxRedNotInFlight") };
      }

      // When offline, override a green match to yellow to communicate
      // "queued offline — will sync when SGS network returns".
      const offlineQueued = decision.flash === "green" && !queue.online;
      const flashColor = offlineQueued ? "yellow" : decision.flash;
      const title = offlineQueued ? "QUEUED OFFLINE" : decision.title;

      const isNotInManifest = decision.title === "NOT IN MANIFEST";
      const subtitle = isNotInManifest
        ? tag
        : decision.subtitle ?? rescuedPilgrim;
      const hint = isNotInManifest ? t("notInManifestHint") : undefined;

      trigger(
        { color: flashColor, title, subtitle, hint },
        decision.hapticKey,
        RECEIVING_FLASH_MS,
      );
      setLastTag(tag);
      if (decision.flash === "red") setLastFailedTag(tag);

      if (decision.flash === "green" && acceptGroupId) {
        await markTagScanned(acceptGroupId, tag);
        // Optimistically flip the per-bag cached status from pending
        // to scanned so subsequent reads (Rapid Scan, manifest list)
        // show the bag as collected even before the next manifest
        // refetch — and even before the backend ships the
        // MANIFESTED→COLLECTED_FROM_BELT transition we requested.
        await updateCachedManifestBagStatus(acceptGroupId, tag, "scanned").catch(
          () => undefined,
        );
        // Mirror the same patch into the React Query in-memory cache so
        // a screen mounted *after* this scan (e.g. Rapid Scan) reads the
        // already-scanned status without an AsyncStorage round-trip.
        queryClient.setQueryData<{
          bags: ManifestBag[];
          fromCache: boolean;
          cachedAt: string | null;
        }>(["manifest", acceptGroupId], (old) => {
          if (!old) return old;
          let mutated = false;
          const nextBags = old.bags.map((b) => {
            if ((b.tagNumber === tag || b.iataTag === tag) && b.status !== "scanned") {
              mutated = true;
              return { ...b, status: "scanned" as const };
            }
            return b;
          });
          return mutated ? { ...old, bags: nextBags } : old;
        });
        setScanDelta((prev) => ({
          ...prev,
          [acceptGroupId]: (prev[acceptGroupId] ?? 0) + 1,
        }));
        // Pulse the matching card so the agent sees which group ticked.
        setPulseGroupId(acceptGroupId);
        pulseAnim.setValue(0);
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 600,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start(() => setPulseGroupId(null));
        // Refetch the server-authoritative counter so the card converges
        // to the true value within ~1s of the scan.
        queryClient.invalidateQueries({ queryKey: ["groups", sFlightId] });
      }

      if (decision.title === "NOT IN MANIFEST" && flatManifest.length > 0) {
        return;
      }

      // Always queue the scan for server-side reconciliation. `groupId`
      // may be undefined for unmatched tags — the server resolves the
      // group from the bag record at sync time.
      await queue.enqueue({
        tagNumber: tag,
        // Omit when unmatched — server resolves the group at sync time.
        groupId: acceptGroupId ?? undefined,
        flightId: sFlightId,
        scannedAt: new Date(now).toISOString(),
        source: isZebra ? "zebra" : "camera",
        deviceId: deviceIdRef.current ?? undefined,
      });
    },
    [isZebra, queue, session.session, trigger, mergedManifest, pulseAnim, queryClient, t, manifestErrorHard],
    // queue.online is captured via closure each render; safe.
  );

  useZebraScanner(handleScan);

  // Show the "trigger appears dead" ribbon only on Zebra hardware after
  // the agent has been on the scan screen for at least 30s with zero
  // scan events received. Once any scan event lands the ribbon hides
  // permanently for this session — we don't want to nag during slow
  // belt periods.
  // Two triggers for the "your scanner isn't reaching us" banner:
  //   1. DataWedge isn't installed at all → show immediately on focus.
  //   2. DataWedge is present but no scan event has arrived in 30s →
  //      treat as a misconfigured profile / dead trigger.
  // Either way the agent gets one actionable banner with a Setup Guide
  // CTA and a Dismiss escape hatch.
  const triggerTimedOut =
    isZebra &&
    lastZebraScanAt === null &&
    zebraFocusedAt !== null &&
    tickNow - zebraFocusedAt > 30_000;
  const showNoScansWarning =
    isZebra &&
    !triggerBannerDismissed &&
    (dataWedgeMissing === true || triggerTimedOut);
  const triggerBannerKind: "missing" | "timeout" =
    dataWedgeMissing === true ? "missing" : "timeout";

  const [cameraActive, setCameraActive] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setCameraActive(true);
      return () => setCameraActive(false);
    }, []),
  );

  if (!session.session) return null;

  const pct = flightExpected
    ? Math.min(100, Math.round((flightScanned / flightExpected) * 100))
    : 0;
  const role = auth.user?.role ?? "";
  const showBulkOnCard = role !== "driver";

  return (
    <View style={styles.flex}>
      <ScreenHeader
        title={session.session.flight.flightNumber}
        subtitle={
          isRTL
            ? `${pct}% · ${flightScanned}/${flightExpected} ${t("bags")}`
            : `${flightScanned}/${flightExpected} ${t("bags")} · ${pct}%`
        }
        onBack={async () => {
          // Switch flight: drop the session and return to flight pick.
          await session.setSession(null);
          router.replace("/session-setup");
        }}
        right={
          <View style={styles.headerRight}>
            <StatusPill
              online={queue.online}
              queueSize={queue.queueSize}
              syncing={queue.syncing}
            />
            <Pressable
              onPress={() => router.push("/settings")}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t("settings")}
              style={styles.headerSettingsBtn}
            >
              <Feather
                name="settings"
                size={20}
                color={colors.sgs.textPrimary}
              />
            </Pressable>
          </View>
        }
      />

      {queue.deadLetterTotal > 0 ? (
        <View style={styles.dlBanner}>
          <Feather name="alert-circle" size={16} color={colors.sgs.black} />
          <Text style={[styles.dlText, isRTL && { writingDirection: "rtl" }]}>
            {queue.deadLetterTotal} {t("itemsFailed")}
          </Text>
          <Pressable onPress={queue.retryDeadLetter} style={styles.dlBtn}>
            <Text style={styles.dlBtnTxt}>{t("retry")}</Text>
          </Pressable>
          <Pressable onPress={queue.discardDeadLetter} style={styles.dlBtn}>
            <Text style={styles.dlBtnTxt}>{t("discard")}</Text>
          </Pressable>
        </View>
      ) : null}

      {queue.pendingExceptions > 0 || queue.pendingNoTag > 0 ? (
        // Surface a breakdown of pending non-scan work so the agent can
        // see at a glance whether their exceptions / no-tag entries are
        // still waiting for the network. The status pill in the header
        // already reflects scan-queue depth.
        <View style={styles.opsBanner}>
          <Feather name="upload-cloud" size={14} color={colors.sgs.textMuted} />
          <Text style={[styles.opsBannerText, isRTL && { writingDirection: "rtl" }]}>
            {queue.pendingExceptions > 0
              ? `${queue.pendingExceptions} ${t("exceptionsQueued")}`
              : ""}
            {queue.pendingExceptions > 0 && queue.pendingNoTag > 0 ? " · " : ""}
            {queue.pendingNoTag > 0
              ? `${queue.pendingNoTag} ${t("noTagQueued")}`
              : ""}
          </Text>
        </View>
      ) : null}

      {manifestErrorHard ? (
        <View style={styles.manifestErrorBanner}>
          <Feather name="alert-octagon" size={16} color="#FFF" />
          <View style={styles.noScanText}>
            <Text style={[styles.manifestErrorTitle, isRTL && { writingDirection: "rtl" }]}>
              {t("manifestErrorTitle")}
            </Text>
            <Text style={[styles.manifestErrorBody, isRTL && { writingDirection: "rtl" }]}>
              {t("manifestErrorBody")}
            </Text>
          </View>
          <Pressable
            onPress={retryManifest}
            style={styles.manifestRetryBtn}
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
          >
            <Text style={styles.manifestRetryBtnTxt}>{t("retry")}</Text>
          </Pressable>
        </View>
      ) : manifestStale ? (
        <View style={styles.manifestStaleBanner}>
          <Feather name="cloud-off" size={14} color={colors.sgs.black} />
          <Text style={[styles.manifestStaleText, isRTL && { writingDirection: "rtl" }]}>
            <Text style={styles.manifestStaleTitle}>{t("manifestStaleTitle")}</Text>
            {oldestCachedAt
              ? ` · ${t("manifestStaleBody").replace("{time}", formatCachedAt(oldestCachedAt))}`
              : ""}
          </Text>
          <Pressable
            onPress={retryManifest}
            style={styles.manifestStaleRetry}
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
          >
            <Text style={styles.manifestStaleRetryTxt}>{t("retry")}</Text>
          </Pressable>
        </View>
      ) : null}

      {showNoScansWarning ? (
        <View style={styles.noScanBanner}>
          <Feather name="alert-triangle" size={16} color={colors.sgs.black} />
          <View style={styles.noScanText}>
            <Text style={[styles.noScanTitle, isRTL && { writingDirection: "rtl" }]}>
              {triggerBannerKind === "missing" ? t("noDataWedgeTitle") : t("noScansYet")}
            </Text>
            <Text style={[styles.noScanBody, isRTL && { writingDirection: "rtl" }]}>
              {triggerBannerKind === "missing" ? t("noDataWedgeBody") : t("noScansYetBody")}
            </Text>
          </View>
          <View style={styles.noScanActions}>
            <Pressable
              onPress={() => router.push("/settings")}
              style={styles.noScanBtn}
              accessibilityRole="button"
              accessibilityLabel={t("openSetupGuide")}
            >
              <Text style={styles.noScanBtnTxt}>{t("openSetupGuide")}</Text>
            </Pressable>
            <Pressable
              onPress={() => setTriggerBannerDismissed(true)}
              style={styles.noScanDismissBtn}
              accessibilityRole="button"
              accessibilityLabel={t("dismiss")}
            >
              <Text style={styles.noScanDismissBtnTxt}>{t("dismiss")}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <GroupCardsStrip
        groups={groups}
        loading={groupsQ.isLoading}
        scanDelta={scanDelta}
        pulseGroupId={pulseGroupId}
        pulseAnim={pulseAnim}
        showBulkReceive={showBulkOnCard}
        onBulkReceive={(g) =>
          router.push({ pathname: "/bulk-receive", params: { groupId: g.id } })
        }
        t={t}
      />

      <View style={styles.body}>
        {isZebra ? (
          <ZebraIdleView
            lastTag={lastTag}
            scanned={flightScanned}
            expected={flightExpected}
          />
        ) : permission?.granted ? (
          cameraActive ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{
                // Bag-tag symbology set:
                //   - code128 / GS1-128: SGS-printed Hajj tags
                //   - itf14: IATA Resolution 740 airline bag tags
                //     (Saudia, Emirates, BA, etc. — the long ITF
                //     license plate)
                //   - code39, pdf417: defensive — appear on some
                //     airline tags and SGS staff badges, no false-
                //     positive cost in baggage halls.
                // QR / EAN / UPC are intentionally OFF so food-
                // packaging barcodes don't trigger spurious scans.
                barcodeTypes: ["code128", "itf14", "code39", "pdf417"],
              }}
              onBarcodeScanned={(r) => {
                if (debugRawScan) {
                  setRawBanner({ data: r.data, type: r.type });
                  if (rawBannerTimer.current) clearTimeout(rawBannerTimer.current);
                  rawBannerTimer.current = setTimeout(() => setRawBanner(null), 2000);
                }
                // For PDF417 camera scans, parse BTP fields and surface them
                // as a native toast so the agent can confirm every field was
                // read correctly before the scan enters the queue.
                if (r.type === "pdf417" && Platform.OS === "android") {
                  const btp = parseBtpPdf417(r.data);
                  if (btp) {
                    const lines = ["PDF417 decoded:"];
                    lines.push(`Tag:     ${btp.tagNumber}`);
                    if (btp.pilgrimName) lines.push(`Pilgrim: ${btp.pilgrimName}`);
                    if (btp.flight)      lines.push(`Flight:  ${btp.flight}`);
                    if (btp.station)     lines.push(`Station: ${btp.station}`);
                    if (btp.pnr)         lines.push(`PNR:     ${btp.pnr}`);
                    if (btp.bagSequence) lines.push(`BN:      ${btp.bagSequence}`);
                    ToastAndroid.show(lines.join("\n"), ToastAndroid.SHORT);
                  }
                }
                handleScan(r.data);
              }}
            />
          ) : null
        ) : (
          <CameraPermissionView
            canAsk={permission?.canAskAgain ?? true}
            onRequest={requestPermission}
          />
        )}

        {!isZebra && permission?.granted ? (
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

        {debugRawScan && rawBanner ? (
          <View pointerEvents="none" style={styles.rawBanner}>
            <Text style={styles.rawBannerLabel}>
              {t("rawScanBanner")} · {rawBanner.type}
            </Text>
            <Text style={styles.rawBannerValue} numberOfLines={1}>
              {rawBanner.data || "(empty)"}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.footerRow}>
          <FooterButton
            icon="alert-triangle"
            label={t("exception")}
            onPress={() => {
              // Pre-fill the failed tag (red flash) so the agent doesn't
              // have to re-key it. Only red-flash tags qualify — green
              // matches are already in the system and shouldn't seed an
              // exception form. The screen stays editable for any
              // override case.
              // If the failed tag is a known bag in another group on
              // this flight (wrong-group case), forward that group id so
              // the exception is routed to the bag's actual group
              // without forcing the user through the picker.
              const params: Record<string, string> = {};
              if (lastFailedTag) {
                params.tag = lastFailedTag;
                const matched = mergedManifest.get(lastFailedTag);
                if (matched?.groupId) {
                  params.groupId = matched.groupId;
                }
              }
              router.push({
                pathname: "/exception",
                params: Object.keys(params).length ? params : undefined,
              });
            }}
          />
          {/* No Tag entry point hidden per client request (2026-04-22).
              Re-enable by restoring the FooterButton below. The /no-tag
              route, screen, and queue handling all remain intact.
          <FooterButton
            icon="edit-3"
            label={t("noTag")}
            onPress={() => router.push("/no-tag")}
          />
          */}
          <FooterButton
            icon="refresh-cw"
            label={t("syncNow")}
            onPress={async () => {
              // Manual Sync Now is the natural end-of-shift action:
              // include the dead letter (one fresh attempt at any
              // stuck items) and, when everything drains cleanly,
              // clear the session and bounce back to flight pick so
              // the agent doesn't have to also tap End → End shift.
              const totals = await queue.syncNow({ includeDeadLetter: true });
              if (
                totals.pendingRemaining === 0 &&
                totals.deadLetterRemaining === 0
              ) {
                if (Platform.OS === "android") {
                  ToastAndroid.show(
                    t("allUploadedReturning"),
                    ToastAndroid.SHORT,
                  );
                }
                await session.setSession(null);
                setScanDelta({});
                router.replace("/session-setup");
              }
            }}
            disabled={
              queue.syncing ||
              (queue.pendingTotal === 0 && queue.deadLetterTotal === 0)
            }
          />
          <FooterButton
            icon="x-circle"
            label={t("end")}
            onPress={() => router.push("/shift-summary")}
          />
        </View>
        <Pressable
          onPress={() => router.push("/settings")}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open settings and version info"
        >
          <Text style={[styles.footerAgent, isRTL && { writingDirection: "rtl" }]}>
            {isRTL
              ? `${isZebra ? t("zebraMode") : t("cameraMode")} · ${auth.user?.name}`
              : `${auth.user?.name} · ${isZebra ? t("zebraMode") : t("cameraMode")}`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function GroupCardsStrip({
  groups,
  loading,
  scanDelta,
  pulseGroupId,
  pulseAnim,
  showBulkReceive,
  onBulkReceive,
  t,
}: {
  groups: BagGroup[];
  loading: boolean;
  scanDelta: Record<string, number>;
  pulseGroupId: string | null;
  pulseAnim: Animated.Value;
  showBulkReceive: boolean;
  onBulkReceive: (g: BagGroup) => void;
  t: (k: StringKeyT) => string;
}) {
  // Collapsed by default to keep the scanner viewfinder dominant. Reset
  // to collapsed every time the screen regains focus so coming back from
  // a sub-screen (exception/settings/etc.) starts the agent in the
  // distraction-free state. The summary row pulses when a green scan
  // lands while collapsed so the agent still gets visual confirmation
  // that the totals updated.
  const [expanded, setExpanded] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setExpanded(false);
      return undefined;
    }, []),
  );

  if (loading && groups.length === 0) {
    return (
      <View style={cardStripStyles.skeletonRow}>
        <ActivityIndicator color={colors.sgs.green} />
        <Text style={cardStripStyles.skeletonTxt}>{t("loadingGroups")}</Text>
      </View>
    );
  }
  if (!loading && groups.length === 0) {
    return (
      <View style={cardStripStyles.skeletonRow}>
        <Text style={cardStripStyles.skeletonTxt}>
          {t("noGroupsForFlight")}
        </Text>
      </View>
    );
  }

  const totalScanned = groups.reduce(
    (s, g) => s + g.scannedBags + (scanDelta[g.id] ?? 0),
    0,
  );
  const totalExpected = groups.reduce((s, g) => s + g.expectedBags, 0);
  const pct = totalExpected
    ? Math.min(100, Math.round((totalScanned / totalExpected) * 100))
    : 0;

  // Pulse the summary row itself when collapsed so the agent still sees
  // a heartbeat for each green scan without needing the cards visible.
  const summaryPulseStyle =
    !expanded && pulseGroupId
      ? {
          opacity: pulseAnim.interpolate({
            inputRange: [0, 0.5, 1],
            outputRange: [0.55, 1, 1],
          }),
        }
      : null;

  return (
    <View style={cardStripStyles.collapsibleWrap}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={
          expanded ? t("collapseGroups") : t("expandGroups")
        }
        style={({ pressed }) => [pressed && { opacity: 0.7 }]}
      >
        <Animated.View
          style={[cardStripStyles.summaryRow, summaryPulseStyle]}
        >
          <Feather name="grid" size={13} color={colors.sgs.textMuted} />
          <Text style={cardStripStyles.summaryTxt}>
            {t("groups")} ({groups.length}) · {totalScanned}/{totalExpected}
            {totalExpected ? ` · ${pct}%` : ""}
          </Text>
          <View style={cardStripStyles.summarySpacer} />
          <Feather
            name={expanded ? "chevron-up" : "chevron-down"}
            size={16}
            color={colors.sgs.textMuted}
          />
        </Animated.View>
      </Pressable>
      {expanded ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={cardStripStyles.grid}
          style={cardStripStyles.strip}
        >
          {groups.map((g) => (
            <GroupCard
              key={g.id}
              group={g}
              delta={scanDelta[g.id] ?? 0}
              pulse={pulseGroupId === g.id}
              pulseAnim={pulseAnim}
              showBulkReceive={showBulkReceive}
              onBulkReceive={() => onBulkReceive(g)}
              t={t}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function GroupCard({
  group,
  delta,
  pulse,
  pulseAnim,
  showBulkReceive,
  onBulkReceive,
  t,
}: {
  group: BagGroup;
  delta: number;
  pulse: boolean;
  pulseAnim: Animated.Value;
  showBulkReceive: boolean;
  onBulkReceive: () => void;
  t: (k: StringKeyT) => string;
}) {
  const scanned = group.scannedBags + delta;
  const expected = group.expectedBags;
  const pct = expected ? Math.min(100, Math.round((scanned / expected) * 100)) : 0;
  const status = statusForGroup({
    ...group,
    scannedBags: scanned,
  });
  const statusLabel =
    status === "COMPLETE"
      ? t("groupStatusComplete")
      : status === "IN_PROGRESS"
        ? t("groupStatusInProgress")
        : t("groupStatusPending");
  const statusColor =
    status === "COMPLETE"
      ? colors.sgs.green
      : status === "IN_PROGRESS"
        ? colors.sgs.flashAmber
        : colors.sgs.textMuted;
  // Pulse: brief border-color/opacity sweep on the card whose group just
  // matched a green scan. Driven by a shared 0→1 Animated.Value owned
  // by the screen so we don't spawn an animation per card.
  const pulseStyle = pulse
    ? {
        opacity: pulseAnim.interpolate({
          inputRange: [0, 0.5, 1],
          outputRange: [0.6, 1, 1],
        }),
        transform: [
          {
            scale: pulseAnim.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: [1.04, 1.02, 1],
            }),
          },
        ],
      }
    : null;
  return (
    <Animated.View
      style={[
        cardStripStyles.card,
        pulse && { borderColor: colors.sgs.green },
        pulseStyle,
      ]}
    >
      <View style={cardStripStyles.cardHead}>
        <Text style={cardStripStyles.cardTitle} numberOfLines={1}>
          {group.groupNumber}
        </Text>
        <View
          style={[
            cardStripStyles.statusBadge,
            { borderColor: statusColor },
          ]}
        >
          <Text style={[cardStripStyles.statusTxt, { color: statusColor }]}>
            {statusLabel}
          </Text>
        </View>
      </View>
      <Text style={cardStripStyles.cardCounter}>
        {scanned}/{expected}
      </Text>
      <View style={cardStripStyles.progressTrack}>
        <View
          style={[
            cardStripStyles.progressFill,
            { width: `${pct}%`, backgroundColor: statusColor },
          ]}
        />
      </View>
      {/* Bulk Receive entry point hidden per client request
          (2026-04-22). Re-enable by uncommenting the Pressable below.
          The /bulk-receive route, screen, and queue handling all remain
          intact, and the `showBulkReceive` prop chain is preserved.
      {showBulkReceive && status === "PENDING" ? (
        <Pressable
          onPress={onBulkReceive}
          style={({ pressed }) => [
            cardStripStyles.bulkBtn,
            pressed && { opacity: 0.6 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("bulkReceive")}
        >
          <Feather name="layers" size={12} color={colors.sgs.textPrimary} />
          <Text style={cardStripStyles.bulkBtnTxt}>{t("bulkReceive")}</Text>
        </Pressable>
      ) : null}
      */}
    </Animated.View>
  );
}

const cardStripStyles = StyleSheet.create({
  collapsibleWrap: {
    backgroundColor: colors.sgs.surface,
    borderBottomColor: colors.sgs.border,
    borderBottomWidth: 1,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  summaryTxt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
    letterSpacing: 0.2,
  },
  summarySpacer: { flex: 1 },
  strip: {
    maxHeight: 280,
    backgroundColor: colors.sgs.surface,
  },
  grid: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "stretch",
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.sgs.surface,
    borderBottomColor: colors.sgs.border,
    borderBottomWidth: 1,
  },
  skeletonTxt: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 13,
  },
  card: {
    flexBasis: "48%",
    flexGrow: 1,
    minWidth: 140,
    backgroundColor: colors.sgs.surfaceElevated,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  cardTitle: {
    flex: 1,
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 14,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusTxt: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 9,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  cardCounter: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 18,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.sgs.black,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
  },
  bulkBtn: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: colors.sgs.black,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
  },
  bulkBtnTxt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 11,
  },
});

function ZebraIdleView({
  lastTag,
  scanned,
  expected,
}: {
  lastTag: string | null;
  scanned: number;
  expected: number;
}) {
  const { t } = useLocale();
  const pct = expected ? Math.min(1, scanned / expected) : 0;
  // Conic-ish ring built from two halves rotated by progress.
  const angle = pct * 360;
  return (
    <View style={styles.zebraWrap}>
      <View style={styles.ring}>
        <View
          style={[
            styles.ringFill,
            { transform: [{ rotate: `${Math.min(180, angle)}deg` }] },
          ]}
        />
        {angle > 180 ? (
          <View
            style={[
              styles.ringFill,
              styles.ringFillBack,
              { transform: [{ rotate: `${angle - 180}deg` }] },
            ]}
          />
        ) : null}
        <View style={styles.ringInner}>
          <Text style={styles.ringPct}>{Math.round(pct * 100)}%</Text>
          <Text style={styles.ringSub}>
            {scanned}/{expected}
          </Text>
        </View>
      </View>
      <Text style={styles.zebraTitle}>{lastTag ?? t("zebraIdle")}</Text>
      <Text style={styles.zebraSub}>
        {lastTag ? t("lastScannedTag") : t("zebraIdleSub")}
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
        // The user previously tapped "Don't ask again" — the in-app prompt
        // is dead. Linking.openSettings() is the only recovery short of a
        // reinstall, so surface it as a primary action instead of leaving
        // the agent stuck on a static hint string.
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

function FooterButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.fbtn,
        pressed && { opacity: 0.6 },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Feather name={icon} size={18} color={colors.sgs.textPrimary} />
      <Text style={styles.fbtnTxt} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  body: { flex: 1, position: "relative", overflow: "hidden" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerSettingsBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  dlBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.sgs.flashAmber,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dlText: {
    flex: 1,
    color: colors.sgs.black,
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
  },
  dlBtn: {
    backgroundColor: colors.sgs.black,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  dlBtnTxt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 12,
  },
  noScanBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.sgs.flashAmber,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  noScanText: { flex: 1 },
  noScanTitle: {
    color: colors.sgs.black,
    fontFamily: FONTS.bodyBold,
    fontSize: 13,
  },
  noScanBody: {
    color: colors.sgs.black,
    fontFamily: FONTS.body,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 1,
  },
  noScanBtn: {
    backgroundColor: colors.sgs.black,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
  },
  noScanBtnTxt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 11,
  },
  noScanActions: {
    alignItems: "flex-end",
    gap: 6,
  },
  noScanDismissBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  noScanDismissBtnTxt: {
    color: colors.sgs.black,
    fontFamily: FONTS.bodyMedium,
    fontSize: 11,
    textDecorationLine: "underline",
  },
  manifestErrorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.sgs.flashRed,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  manifestErrorTitle: {
    color: "#FFF",
    fontFamily: FONTS.bodyBold,
    fontSize: 13,
  },
  manifestErrorBody: {
    color: "#FFF",
    fontFamily: FONTS.body,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 1,
    opacity: 0.95,
  },
  manifestRetryBtn: {
    backgroundColor: "#FFF",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
  },
  manifestRetryBtnTxt: {
    color: colors.sgs.flashRed,
    fontFamily: FONTS.bodyBold,
    fontSize: 11,
  },
  manifestStaleBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.sgs.flashAmber,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  manifestStaleText: {
    flex: 1,
    color: colors.sgs.black,
    fontFamily: FONTS.body,
    fontSize: 12,
  },
  manifestStaleTitle: {
    fontFamily: FONTS.bodyBold,
  },
  manifestStaleRetry: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  manifestStaleRetryTxt: {
    color: colors.sgs.black,
    fontFamily: FONTS.bodyBold,
    fontSize: 11,
    textDecorationLine: "underline",
  },
  opsBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.sgs.surface,
    borderBottomColor: colors.sgs.border,
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  opsBannerText: {
    flex: 1,
    color: colors.sgs.textMuted,
    fontFamily: FONTS.bodyMedium,
    fontSize: 12,
  },
  reticle: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticleBox: {
    // Square reticle so both vertically held airline (IATA) tags and
    // horizontally held SGS-printed tags frame naturally without the
    // agent having to rotate the bag.
    width: "70%",
    aspectRatio: 1,
    maxHeight: "60%",
    borderColor: colors.sgs.green,
    borderWidth: 3,
    borderRadius: 14,
  },
  rawBanner: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: "rgba(0,0,0,0.78)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderColor: colors.sgs.green,
    borderWidth: 1,
  },
  rawBannerLabel: {
    color: colors.sgs.green,
    fontFamily: FONTS.bodyBold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  rawBannerValue: {
    color: "#FFF",
    fontFamily: FONTS.body,
    fontSize: 14,
    marginTop: 2,
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
  zebraWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 32,
  },
  ring: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: colors.sgs.surface,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginBottom: 12,
  },
  ringFill: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: colors.sgs.green,
    transformOrigin: "100% 50%" as unknown as string,
    // First half rotates from the right edge (0-180deg).
    // We mask the left half with absolute positioning so only the rotated
    // sweep is visible.
  },
  ringFillBack: {
    transformOrigin: "0% 50%" as unknown as string,
  },
  ringInner: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: colors.sgs.black,
    alignItems: "center",
    justifyContent: "center",
  },
  ringPct: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 36,
  },
  ringSub: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 14,
    marginTop: 4,
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
  footer: {
    backgroundColor: colors.sgs.black,
    borderTopWidth: 1,
    borderTopColor: colors.sgs.border,
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 10,
  },
  footerRow: { flexDirection: "row", gap: 10 },
  fbtn: {
    flex: 1,
    backgroundColor: colors.sgs.surfaceElevated,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    gap: 6,
  },
  fbtnTxt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 12,
    letterSpacing: 0.2,
    textAlign: "center",
  },
  footerAgent: {
    color: colors.sgs.textDim,
    fontFamily: FONTS.body,
    fontSize: 11,
    textAlign: "center",
  },
});
