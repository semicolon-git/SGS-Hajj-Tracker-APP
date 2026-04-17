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
import { useIsZebraDevice, useZebraScanner } from "@/hooks/useScanner";
import { decideScan, normalizeTag } from "@/lib/scanLogic";
import {
  getCachedManifest,
  getOrCreateDeviceId,
  getScannedTags,
  markTagScanned,
} from "@/lib/db/storage";
import { Linking } from "react-native";

const DEBOUNCE_MS = 1500;

export default function ScanScreen() {
  const router = useRouter();
  const auth = useAuth();
  const session = useSession();
  const queue = useScanQueue();
  const isZebra = useIsZebraDevice();
  const { flash, trigger } = useFlashFeedback();
  const insets = useSafeAreaInsets();
  const { t } = useLocale();

  const [permission, requestPermission] = useCameraPermissions();
  const [scannedCount, setScannedCount] = useState(0);
  const [expected, setExpected] = useState(0);
  const [lastTag, setLastTag] = useState<string | null>(null);
  // Tracks the last tag that produced a red flash (unknown / wrong-group /
  // duplicate). Used as the prefill source when the agent taps "Exception"
  // so the form is seeded with the tag that actually needs an exception
  // raised against it, not just the most recent successful scan.
  const [lastFailedTag, setLastFailedTag] = useState<string | null>(null);
  const lastScan = useRef<{ tag: string; at: number } | null>(null);
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

  const handleScan = useCallback(
    async (raw: string) => {
      if (!session.session) return;
      const tag = normalizeTag(raw);
      if (!tag) return;
      const now = Date.now();
      if (
        lastScan.current &&
        lastScan.current.tag === tag &&
        now - lastScan.current.at < DEBOUNCE_MS
      ) {
        return;
      }
      lastScan.current = { tag, at: now };

      const groupId = session.session.group.id;
      const flightId = session.session.flight.id;
      const manifest = (await getCachedManifest(groupId)) ?? [];
      const scannedTags = await getScannedTags(groupId);

      const decision = decideScan({ tagNumber: tag, groupId, manifest, scannedTags });
      // When offline, override a green match to yellow to communicate
      // "queued offline — will sync when SGS network returns".
      const offlineQueued = decision.flash === "green" && !queue.online;
      const flashColor = offlineQueued ? "yellow" : decision.flash;
      const title = offlineQueued ? "QUEUED OFFLINE" : decision.title;
      trigger(
        { color: flashColor, title, subtitle: decision.subtitle },
        decision.hapticKey,
      );
      setLastTag(tag);
      if (decision.flash === "red") setLastFailedTag(tag);

      if (decision.flash === "green") {
        await markTagScanned(groupId, tag);
        setScannedCount(scannedTags.size + 1);
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
        title={`${session.session.flight.flightNumber} · ${t("groupLabel")} ${session.session.group.groupNumber}`}
        subtitle={`${scannedCount}/${expected} ${t("bags")} · ${pct}%`}
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
          <Text style={styles.dlText}>
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
          <Text style={styles.opsBannerText}>
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
                // Spec: bag tags are CODE_128 only — restrict to avoid
                // false positives from other symbologies in baggage areas.
                barcodeTypes: ["code128"],
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

        {!isZebra && permission?.granted ? (
          <View pointerEvents="none" style={styles.reticle}>
            <View style={styles.reticleBox} />
            <Text style={styles.reticleHint}>{t("alignTag")}</Text>
          </View>
        ) : null}

        {flash ? (
          <FlashOverlay
            color={flash.color}
            title={flash.title}
            subtitle={flash.subtitle}
          />
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
          <Text style={styles.footerAgent}>
            {auth.user?.name} · {isZebra ? t("zebraMode") : t("cameraMode")}
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
      <Text style={styles.fbtnTxt}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  body: { flex: 1, position: "relative", overflow: "hidden" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerSettingsBtn: {
    width: 32,
    height: 32,
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
    width: "85%",
    height: 110,
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
    letterSpacing: 0.4,
  },
  footerAgent: {
    color: colors.sgs.textDim,
    fontFamily: FONTS.body,
    fontSize: 11,
    textAlign: "center",
  },
});
