import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
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
  getCachedFlights,
  getOrCreateDeviceId,
} from "@/lib/db/storage";
import { sgsApi, type Flight, type HajjCheckResult } from "@/lib/api/sgs";
import { classifyHajjCheck, normalizeTag } from "@/lib/scanLogic";

const DEBOUNCE_MS = 1500;

type Counts = { green: number; amber: number; red: number };

type LastScan = {
  tag: string;
  status: "green" | "amber" | "red";
  pilgrimName?: string;
  accommodationName?: string;
  accommodationAddress?: string;
  reasonText?: string;
  at: number;
};

/**
 * Rapid Scan — distraction-free belt-clearing screen for admin / duty
 * manager / airport ops staff. Bypasses session-setup: every scan hits
 * `/api/bags/hajj-check` directly and renders one of three full-screen
 * results (green / amber / red). Greens + ambers enqueue through the
 * regular ScanQueueContext (event type COLLECTED_FROM_BELT). Reds call
 * the dedicated red-scan logger.
 */
export default function RapidScanScreen() {
  const router = useRouter();
  const auth = useAuth();
  const queue = useScanQueue();
  const { effective: scannerSource } = useScannerMode();
  const isZebra = scannerSource === "zebra";
  const insets = useSafeAreaInsets();
  const { t, isRTL } = useLocale();
  const { flash, trigger } = useFlashFeedback();

  const [permission, requestPermission] = useCameraPermissions();
  const [counts, setCounts] = useState<Counts>({ green: 0, amber: 0, red: 0 });
  const [last, setLast] = useState<LastScan | null>(null);
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

  // Lazily load flight list the first time the picker opens. Cache hit
  // makes repeat opens instant and keeps the screen useful offline.
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

  // Auto-request camera permission on consumer phones when the camera
  // mode is active.
  useEffect(() => {
    if (!isZebra && permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [isZebra, permission, requestPermission]);

  const handleScan = useCallback(
    async (raw: string) => {
      const tag = normalizeTag(raw);
      if (!tag) return;
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
      // Hard guard against parallel runs. The tag-debounce above stops
      // duplicate-tag re-fires; this guard stops the Zebra from
      // interleaving *different* tags while a network lookup is still
      // in flight (which would race setLast/setCounts/queue.enqueue).
      if (busy) return;
      lastScan.current = { tag, at: now };
      setBusy(true);

      let result: HajjCheckResult;
      try {
        result = await sgsApi.hajjCheck(tag);
      } catch (err) {
        // Network failure → treat as red but don't burn a count, since
        // we can't be sure whether the bag is actually unrecognized or
        // just unreachable. Show the lookup-failed toast via the flash.
        trigger(
          {
            color: "red",
            title: t("rapidLookupFailed"),
            subtitle: tag,
          },
          "error",
        );
        setBusy(false);
        return;
      }

      const decision = classifyHajjCheck(result, t as (k: string) => string);
      // Rapid Scan dwells the flash for a fixed 1.5s on every outcome —
      // the spec calls for "every scan flashes full-screen for 1.5s" so
      // operators don't have to learn that green is shorter than red.
      trigger(
        {
          color: decision.flash,
          title: decision.title,
          subtitle: decision.subtitle,
          hint: decision.hint,
        },
        decision.hapticKey,
        1500,
      );
      setLast({
        tag: result.bagTag,
        status: result.status,
        pilgrimName: result.pilgrimName,
        accommodationName: result.accommodationName,
        accommodationAddress: result.accommodationAddress,
        // Always carry the human-readable headline forward so the
        // last-scan card can render an explicit reason for amber
        // ("Manifested — Not Assigned") and red, not just a tag.
        reasonText: decision.title,
        at: now,
      });
      setCounts((c) => ({ ...c, [result.status]: c[result.status] + 1 }));

      if (result.status === "green" || result.status === "amber") {
        // Greens/ambers are persisted as COLLECTED_FROM_BELT events.
        // The flight selector is optional in Rapid Scan, so we send
        // empty groupId/flightId when the supervisor hasn't pinned a
        // flight — `submitScan` translates those to `null` on the
        // wire so the server can derive the manifest from the tag.
        await queue.enqueue({
          tagNumber: result.bagTag,
          groupId: flight?.id ?? "",
          flightId: flight?.id ?? "",
          scannedAt: new Date(now).toISOString(),
          source: isZebra ? "zebra" : "camera",
          deviceId: deviceIdRef.current ?? undefined,
        });
      } else {
        // Red scans never enter the regular queue — fire-and-forget log
        // to the dedicated red-scan endpoint. Best-effort: a network
        // failure or 404 is non-blocking.
        sgsApi
          .logRedScan({
            tagNumber: result.bagTag,
            reason: result.reason ?? "unknown_tag",
            flightId: flight?.id,
          })
          .catch(() => undefined);
      }
      setBusy(false);
    },
    [busy, flight, isZebra, queue, t, trigger],
  );

  useZebraScanner(handleScan);

  const [cameraActive, setCameraActive] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setCameraActive(true);
      return () => setCameraActive(false);
    }, []),
  );

  if (!auth.user) return null;

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
          {flight ? (
            <Pressable onPress={() => setFlight(null)} hitSlop={10}>
              <Feather name="x" size={14} color={colors.sgs.textMuted} />
            </Pressable>
          ) : null}
        </Pressable>
        <Pressable
          onPress={() => setCounts({ green: 0, amber: 0, red: 0 })}
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

      <View style={styles.body}>
        {isZebra ? (
          <ZebraIdleView last={last} />
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

        {busy ? (
          <View style={styles.busyDot}>
            <ActivityIndicator color={colors.sgs.green} />
          </View>
        ) : null}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <LastScanCard last={last} />
      </View>

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
                ListHeaderComponent={
                  <Pressable
                    onPress={() => {
                      setFlight(null);
                      setPickerOpen(false);
                    }}
                    style={({ pressed }) => [
                      styles.flightRow,
                      pressed && { backgroundColor: colors.sgs.surfaceElevated },
                    ]}
                  >
                    <Text style={styles.flightRowTitle}>{t("noFlight")}</Text>
                    <Text style={styles.flightRowSub}>
                      {t("rapidScanNoFlightHint")}
                    </Text>
                  </Pressable>
                }
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => {
                      setFlight(item);
                      setPickerOpen(false);
                    }}
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

function ZebraIdleView({ last }: { last: LastScan | null }) {
  const { t } = useLocale();
  return (
    <View style={styles.zebraWrap}>
      <Feather
        name="zap"
        size={48}
        color={colors.sgs.green}
        style={{ opacity: 0.85 }}
      />
      <Text style={styles.zebraTitle}>
        {last ? last.tag : t("rapidScanIdle")}
      </Text>
      <Text style={styles.zebraSub}>
        {last ? t("lastScannedTag") : t("zebraIdleSub")}
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

function LastScanCard({ last }: { last: LastScan | null }) {
  const { t, isRTL } = useLocale();
  if (!last) {
    return (
      <Text style={[styles.lastEmpty, isRTL && { writingDirection: "rtl" }]}>
        {t("rapidScanIdle")}
      </Text>
    );
  }
  const accent =
    last.status === "green"
      ? colors.sgs.flashGreen
      : last.status === "amber"
        ? colors.sgs.flashAmber
        : colors.sgs.flashRed;
  return (
    <View style={[styles.lastCard, { borderLeftColor: accent }]}>
      <Text style={[styles.lastLabel, isRTL && { writingDirection: "rtl" }]}>
        {t("lastScan")}
      </Text>
      <Text style={[styles.lastTag, isRTL && { writingDirection: "rtl" }]}>
        {last.tag}
      </Text>
      {last.pilgrimName ? (
        <Text style={[styles.lastLine, isRTL && { writingDirection: "rtl" }]}>
          {t("pilgrim")}: {last.pilgrimName}
        </Text>
      ) : null}
      {last.accommodationName ? (
        <Text style={[styles.lastLine, isRTL && { writingDirection: "rtl" }]}>
          {t("hotel")}: {last.accommodationName}
        </Text>
      ) : null}
      {last.accommodationAddress ? (
        <Text style={[styles.lastSub, isRTL && { writingDirection: "rtl" }]}>
          {last.accommodationAddress}
        </Text>
      ) : null}
      {last.reasonText ? (
        <Text
          style={[
            styles.lastLine,
            { color: accent, fontFamily: FONTS.bodyMedium },
            isRTL && { writingDirection: "rtl" },
          ]}
        >
          {last.reasonText}
        </Text>
      ) : null}
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
  footer: {
    backgroundColor: colors.sgs.black,
    borderTopWidth: 1,
    borderTopColor: colors.sgs.border,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  lastEmpty: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 12,
  },
  lastCard: {
    backgroundColor: colors.sgs.surface,
    borderLeftWidth: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 4,
  },
  lastLabel: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  lastTag: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 18,
  },
  lastLine: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.body,
    fontSize: 13,
  },
  lastSub: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 12,
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
