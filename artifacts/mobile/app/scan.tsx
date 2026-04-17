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
import { useScanQueue } from "@/contexts/ScanQueueContext";
import { useSession } from "@/contexts/SessionContext";
import { useFlashFeedback } from "@/hooks/useFlashFeedback";
import { useIsZebraDevice, useZebraScanner } from "@/hooks/useScanner";
import { decideScan } from "@/lib/scanLogic";
import {
  getCachedManifest,
  getScannedTags,
  markTagScanned,
} from "@/lib/db/storage";

const DEBOUNCE_MS = 1500;

export default function ScanScreen() {
  const router = useRouter();
  const auth = useAuth();
  const session = useSession();
  const queue = useScanQueue();
  const isZebra = useIsZebraDevice();
  const { flash, trigger } = useFlashFeedback();
  const insets = useSafeAreaInsets();

  const [permission, requestPermission] = useCameraPermissions();
  const [scannedCount, setScannedCount] = useState(0);
  const [expected, setExpected] = useState(0);
  const lastScan = useRef<{ tag: string; at: number } | null>(null);

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
      const tag = raw.trim();
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
      trigger(
        { color: decision.flash, title: decision.title, subtitle: decision.subtitle },
        decision.hapticKey,
      );

      if (decision.flash === "green") {
        await markTagScanned(groupId, tag);
        setScannedCount(scannedTags.size + 1);
      }

      // Always queue the scan for server-side reconciliation (server is source of truth)
      await queue.enqueue({
        tagNumber: tag,
        groupId,
        flightId,
        scannedAt: new Date(now).toISOString(),
        source: isZebra ? "zebra" : "camera",
      });
    },
    [isZebra, queue, session.session, trigger],
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
        title={`${session.session.flight.flightNumber} · Group ${session.session.group.groupNumber}`}
        subtitle={`${scannedCount}/${expected} bags · ${pct}%`}
        right={
          <StatusPill
            online={queue.online}
            queueSize={queue.queueSize}
            syncing={queue.syncing}
          />
        }
      />

      <View style={styles.body}>
        {isZebra ? (
          <ZebraIdleView />
        ) : permission?.granted ? (
          cameraActive ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{
                barcodeTypes: [
                  "code128",
                  "code39",
                  "ean13",
                  "ean8",
                  "qr",
                  "pdf417",
                  "datamatrix",
                ],
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
            <Text style={styles.reticleHint}>Align bag tag inside the frame</Text>
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
            label="Exception"
            onPress={() => router.push("/exception")}
          />
          <FooterButton
            icon="edit-3"
            label="No Tag"
            onPress={() => router.push("/no-tag")}
          />
          <FooterButton
            icon="x-circle"
            label="End Session"
            onPress={async () => {
              await session.setSession(null);
              router.replace("/session-setup");
            }}
          />
        </View>
        <Text style={styles.footerAgent}>
          {auth.user?.name} · {isZebra ? "Zebra DataWedge" : "Camera mode"}
        </Text>
      </View>
    </View>
  );
}

function ZebraIdleView() {
  return (
    <View style={styles.zebraWrap}>
      <Feather name="maximize" size={72} color={colors.sgs.green} />
      <Text style={styles.zebraTitle}>Ready to Scan</Text>
      <Text style={styles.zebraSub}>
        Press the trigger to scan a luggage tag
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
  return (
    <View style={styles.permWrap}>
      <Feather name="camera-off" size={48} color={colors.sgs.textMuted} />
      <Text style={styles.permTitle}>Camera access needed</Text>
      <Text style={styles.permSub}>
        Grant camera permission to scan bag tags on this device.
      </Text>
      {canAsk ? (
        <PrimaryButton label="Allow camera" onPress={onRequest} />
      ) : (
        <Text style={styles.permSub}>Enable camera access in system settings.</Text>
      )}
    </View>
  );
}

function FooterButton({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.fbtn, pressed && { opacity: 0.6 }]}
    >
      <Feather name={icon} size={18} color={colors.sgs.textPrimary} />
      <Text style={styles.fbtnTxt}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  body: { flex: 1, position: "relative", overflow: "hidden" },
  reticle: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticleBox: {
    width: "78%",
    aspectRatio: 1.6,
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
