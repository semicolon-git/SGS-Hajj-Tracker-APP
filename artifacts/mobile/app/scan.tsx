import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { useSession } from "@/contexts/SessionContext";
import { useFlashFeedback } from "@/hooks/useFlashFeedback";
import { useScannerMode, useZebraScanRaw, useZebraScanner } from "@/hooks/useScanner";
import { decideScan, normalizeTag } from "@/lib/scanLogic";
import {
  getCachedManifest,
  getDebugRawScan,
  getOrCreateDeviceId,
  getScannedTags,
  markTagScanned,
} from "@/lib/db/storage";
import { Linking } from "react-native";

const DEBOUNCE_MS = 1500;
const DEBOUNCE_RED_MS = 2000;

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

  const [permission, requestPermission] = useCameraPermissions();
  const [scannedCount, setScannedCount] = useState(0);
  const [expected, setExpected] = useState(0);
  const [lastTag, setLastTag] = useState<string | null>(null);
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

  useEffect(() => {
    if (!session.session) return;
    (async () => {
      const tags = await getScannedTags(session.session!.group.id);
      setScannedCount(tags.size);
      setExpected(session.session!.group.expectedBags);
    })();
  }, [session.session]);

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
  useFocusEffect(
    useCallback(() => {
      if (!isZebra) return;
      setZebraFocusedAt(Date.now());
      const interval = setInterval(() => setTickNow(Date.now()), 1000);
      return () => {
        clearInterval(interval);
        setZebraFocusedAt(null);
      };
    }, [isZebra]),
  );

  const handleScan = useCallback(
    async (raw: string) => {
      if (!session.session) return;
      const tag = normalizeTag(raw);
      if (!tag) return;
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

      const groupId = session.session.group.id;
      const flightId = session.session.flight.id;
      const manifest = (await getCachedManifest(groupId)) ?? [];
      const scannedTags = await getScannedTags(groupId);



      const decision = decideScan({ tagNumber: tag, groupId, manifest, scannedTags });



      lastScan.current = { tag, at: now, flash: decision.flash };

      // When offline, override a green match to yellow to communicate
      // "queued offline — will sync when SGS network returns".
      const offlineQueued = decision.flash === "green" && !queue.online;
      const flashColor = offlineQueued ? "yellow" : decision.flash;
      const title = offlineQueued ? "QUEUED OFFLINE" : decision.title;

      // For NOT IN MANIFEST, show a more descriptive subtitle so the
      // agent understands this bag is not registered in this group.
      const isNotInManifest = decision.title === "NOT IN MANIFEST";
      const subtitle = isNotInManifest
        ? tag
        : decision.subtitle;
      const hint = isNotInManifest
        ? t("notInManifestHint")
        : undefined;

      trigger(
        { color: flashColor, title, subtitle, hint },
        decision.hapticKey,
      );
      setLastTag(tag);
      if (decision.flash === "red") setLastFailedTag(tag);

      if (decision.flash === "green") {
        await markTagScanned(groupId, tag);
        setScannedCount(scannedTags.size + 1);
      }

      // Do not queue scans that are already known to be NOT IN MANIFEST
      // offline — the server will always 404 them, filling the queue
      // with noise. The agent can still use Exception for these bags.
      if (decision.title === "NOT IN MANIFEST" && manifest.length > 0) {
        return;
      }

      // Always queue the scan for server-side reconciliation (server is
      // source of truth). `deviceId` lets the backend dedupe across
      // devices and reinstalls.
      await queue.enqueue({
        tagNumber: tag,
        groupId,
        flightId,
        scannedAt: new Date(now).toISOString(),
        source: isZebra ? "zebra" : "camera",
        deviceId: deviceIdRef.current ?? undefined,
      });
    },
    [isZebra, queue, session.session, trigger],
    // queue.online is captured via closure each render; safe.
  );

  useZebraScanner(handleScan);

  // Show the "trigger appears dead" ribbon only on Zebra hardware after
  // the agent has been on the scan screen for at least 30s with zero
  // scan events received. Once any scan event lands the ribbon hides
  // permanently for this session — we don't want to nag during slow
  // belt periods.
  const showNoScansWarning =
    isZebra &&
    lastZebraScanAt === null &&
    zebraFocusedAt !== null &&
    tickNow - zebraFocusedAt > 30_000;

  const [cameraActive, setCameraActive] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setCameraActive(true);
      return () => setCameraActive(false);
    }, []),
  );

  if (!session.session) return null;

  const pct = expected ? Math.min(100, Math.round((scannedCount / expected) * 100)) : 0;

  return (
    <View style={styles.flex}>
      <ScreenHeader
        title={
          // isRTL
          //   ? `${t("groupLabel")} ${session.session.group.groupNumber} · ${session.session.flight.flightNumber}`
          //   : 
            // `${session.session.flight.flightNumber} · ${t("groupLabel")} ${session.session.group.groupNumber}`
            `${session.session.flight.flightNumber} · ${session.session.group.groupNumber}`
        }
        subtitle={
          isRTL
            ? `${pct}% · ${scannedCount}/${expected} ${t("bags")}`
            : `${scannedCount}/${expected} ${t("bags")} · ${pct}%`
        }
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

      {showNoScansWarning ? (
        <View style={styles.noScanBanner}>
          <Feather name="alert-triangle" size={16} color={colors.sgs.black} />
          <View style={styles.noScanText}>
            <Text style={[styles.noScanTitle, isRTL && { writingDirection: "rtl" }]}>{t("noScansYet")}</Text>
            <Text style={[styles.noScanBody, isRTL && { writingDirection: "rtl" }]}>{t("noScansYetBody")}</Text>
          </View>
          <Pressable
            onPress={() => router.push("/settings")}
            style={styles.noScanBtn}
            accessibilityRole="button"
            accessibilityLabel={t("openSettingsAction")}
          >
            <Text style={styles.noScanBtnTxt}>{t("openSettingsAction")}</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.body}>
        {isZebra ? (
          <ZebraIdleView
            lastTag={lastTag}
            scanned={scannedCount}
            expected={expected}
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
            onPress={() =>
              router.push({
                pathname: "/exception",
                // Pre-fill the failed tag (red flash) so the agent doesn't
                // have to re-key it. Only red-flash tags qualify — green
                // matches are already in the system and shouldn't seed an
                // exception form. The screen stays editable for any
                // override case.
                params: lastFailedTag ? { tag: lastFailedTag } : undefined,
              })
            }
          />
          <FooterButton
            icon="edit-3"
            label={t("noTag")}
            onPress={() => router.push("/no-tag")}
          />
          <FooterButton
            icon="layers"
            label={t("bulkReceive")}
            onPress={() => router.push("/bulk-receive")}
          />
          <FooterButton
            icon="refresh-cw"
            label={t("syncNow")}
            onPress={() => queue.syncNow()}
            disabled={queue.syncing || queue.pendingTotal === 0}
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
