import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { Alert, Platform, Share, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PrimaryButton } from "@/components/PrimaryButton";
import { ScreenHeader } from "@/components/ScreenHeader";
import { FONTS } from "@/constants/branding";
import colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";
import { useLocale } from "@/contexts/LocaleContext";
import { useScanQueue } from "@/contexts/ScanQueueContext";
import { useSession } from "@/contexts/SessionContext";
import { sgsApi } from "@/lib/api/sgs";
import {
  getCachedManifest,
  getScannedTags,
} from "@/lib/db/storage";
import { buildShiftReport } from "@/lib/shiftReport";

export default function ShiftSummaryScreen() {
  const router = useRouter();
  const session = useSession();
  const queue = useScanQueue();
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const { t, isRTL } = useLocale();

  const [scanned, setScanned] = useState(0);
  const [expected, setExpected] = useState(0);
  const [exceptionCount, setExceptionCount] = useState(0);
  const [scannedSet, setScannedSet] = useState<Set<string>>(new Set());
  const [manifestCache, setManifestCache] = useState<
    Awaited<ReturnType<typeof getCachedManifest>>
  >(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!session.session) return;
    (async () => {
      const groupId = session.session!.group.id;
      const tags = await getScannedTags(groupId);
      const manifest = (await getCachedManifest(groupId)) ?? [];
      setScanned(tags.size);
      setExpected(session.session!.group.expectedBags);
      setExceptionCount(
        manifest.filter((b) => b.status === "exception").length,
      );
      setScannedSet(tags);
      setManifestCache(manifest);
    })();
  }, [session.session]);

  if (!session.session) {
    return null;
  }

  const remaining = Math.max(0, expected - scanned);
  const matchPct = expected ? Math.round((scanned / expected) * 100) : 0;

  const startedAt = new Date(session.session.startedAt);
  const durationMin = Math.max(
    1,
    Math.round((Date.now() - startedAt.getTime()) / 60000),
  );

  const onEndShift = async () => {
    await session.setSession(null);
    router.replace("/session-setup");
  };

  const onSendToSupervisor = async () => {
    if (sending || !session.session) return;
    setSending(true);
    try {
      const report = buildShiftReport({
        flight: session.session.flight,
        group: session.session.group,
        startedAt: session.session.startedAt,
        endedAt: new Date().toISOString(),
        manifest: manifestCache ?? [],
        scannedTags: scannedSet,
        queue: {
          pending: queue.queueSize,
          failed: queue.deadLetterSize,
          online: queue.online,
          lastSyncAt: auth.lastSyncAt,
        },
        agent: auth.user ? { id: auth.user.id, name: auth.user.name } : null,
      });

      // Step 1: hand the snapshot to the OS share sheet so the agent can
      // pick Mail / Messages / AirDrop / etc. We send plain text in
      // `message` (universally supported) and include the title separately
      // for share targets like Mail.
      let shared = false;
      try {
        if (Platform.OS === "web") {
          // RN-Web's Share polyfill is unreliable; fall through to a
          // mailto: link which always opens the default mail client.
          const subject = `SGS Shift Summary — ${report.flightNumber} / ${report.groupLabel}`;
          const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(report.text)}`;
          if (typeof window !== "undefined") {
            window.location.href = url;
            shared = true;
          }
        } else {
          const result = await Share.share({
            title: `SGS Shift Summary — ${report.flightNumber} / ${report.groupLabel}`,
            message: report.text,
          });
          shared = result.action !== Share.dismissedAction;
        }
      } catch {
        shared = false;
      }

      // Step 2: best-effort audit POST so supervisors see the snapshot in
      // the dashboard. If the backend doesn't have the route yet we do not
      // treat that as a failure — the agent has already shared the report.
      let recorded = false;
      if (queue.online) {
        try {
          const res = await sgsApi.submitShiftReport({
            reportId: report.reportId,
            flightId: report.flightId,
            flightGroupId: report.groupId,
            startedAt: report.startedAt,
            endedAt: report.endedAt,
            totals: report.totals,
            exceptionTags: report.exceptions.map((e) => e.tagNumber),
            queue: {
              pending: report.queue.pending,
              failed: report.queue.failed,
              online: report.queue.online,
            },
            summaryText: report.text,
            summaryHtml: report.html,
            deliveryChannel: "share",
          });
          recorded = res.recorded;
        } catch {
          recorded = false;
        }
      }

      if (!shared && !recorded) {
        Alert.alert(t("shiftSummary"), t("reportFailed"));
      } else if (recorded) {
        Alert.alert(t("shiftSummary"), t("reportSent"));
      } else {
        Alert.alert(t("shiftSummary"), t("reportShared"));
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.flex}>
      <ScreenHeader
        title={t("shiftSummary")}
        subtitle={`${session.session.flight.flightNumber} · ${t("groupLabel")} ${session.session.group.groupNumber}`}
        onBack={() => router.back()}
      />
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.heroCard}>
          <Text style={styles.heroPct}>{matchPct}%</Text>
          <Text style={styles.heroSub}>
            {scanned}/{expected} {t("scanned")}
          </Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.min(100, matchPct)}%` },
              ]}
            />
          </View>
        </View>

        <Text style={styles.sectionLabel}>{t("totals")}</Text>
        <View style={styles.statGrid}>
          <Stat label={t("expectedBags")} value={expected} />
          <Stat label={t("scannedBags")} value={scanned} accent="green" />
          <Stat
            label={t("remainingBags")}
            value={remaining}
            accent={remaining > 0 ? "amber" : undefined}
          />
          <Stat
            label={t("exceptions")}
            value={exceptionCount}
            accent={exceptionCount > 0 ? "red" : undefined}
          />
          <Stat label={t("duration")} value={`${durationMin}m`} />
          <Stat label={t("pendingScans")} value={queue.queueSize} />
        </View>

        <Text style={styles.sectionLabel}>{t("syncStatus")}</Text>
        <View style={styles.syncCard}>
          <View
            style={[
              styles.syncRow,
              isRTL && { flexDirection: "row-reverse" },
            ]}
          >
            <Feather
              name={queue.online ? "wifi" : "wifi-off"}
              size={18}
              color={queue.online ? colors.sgs.green : colors.sgs.flashAmber}
            />
            <Text style={styles.syncTxt}>
              {queue.online ? t("online") : t("offline")}
            </Text>
            {queue.syncing ? (
              <Text style={styles.syncDim}>· {t("loading")}</Text>
            ) : null}
          </View>
          <Text style={styles.syncDim}>
            {t("pendingScans")}: {queue.queueSize}
            {queue.deadLetterSize > 0
              ? ` · ${t("failedScans")}: ${queue.deadLetterSize}`
              : ""}
          </Text>
          {auth.lastSyncAt ? (
            <Text style={styles.syncDim}>
              {t("lastSync")}: {new Date(auth.lastSyncAt).toLocaleTimeString()}
            </Text>
          ) : null}
        </View>

        <View style={{ height: 16 }} />
        <PrimaryButton
          label={sending ? t("sending") : t("sendToSupervisor")}
          onPress={onSendToSupervisor}
          disabled={sending}
        />
        <View style={{ height: 8 }} />
        <PrimaryButton
          label={t("endShift")}
          onPress={onEndShift}
          variant="danger"
        />
        <View style={{ height: 8 }} />
        <PrimaryButton
          label={t("resumeSession")}
          onPress={() => router.replace("/scan")}
          variant="ghost"
        />
      </ScrollView>
    </View>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: "green" | "amber" | "red";
}) {
  const color =
    accent === "green"
      ? colors.sgs.green
      : accent === "amber"
        ? colors.sgs.flashAmber
        : accent === "red"
          ? colors.sgs.flashRed
          : colors.sgs.textPrimary;
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  scroll: { padding: 16, gap: 14 },
  heroCard: {
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 8,
  },
  heroPct: {
    fontFamily: FONTS.bodyBold,
    fontSize: 56,
    color: colors.sgs.textPrimary,
    letterSpacing: -1,
  },
  heroSub: {
    fontFamily: FONTS.body,
    fontSize: 14,
    color: colors.sgs.textMuted,
  },
  progressTrack: {
    width: "100%",
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.sgs.surfaceElevated,
    overflow: "hidden",
    marginTop: 12,
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.sgs.green,
  },
  sectionLabel: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 12,
    color: colors.sgs.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 6,
  },
  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  statCard: {
    flexGrow: 1,
    flexBasis: "30%",
    minWidth: 100,
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  statValue: {
    fontFamily: FONTS.bodyBold,
    fontSize: 22,
  },
  statLabel: {
    fontFamily: FONTS.body,
    fontSize: 12,
    color: colors.sgs.textMuted,
  },
  syncCard: {
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  syncRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  syncTxt: {
    fontFamily: FONTS.bodyMedium,
    color: colors.sgs.textPrimary,
    fontSize: 14,
  },
  syncDim: {
    fontFamily: FONTS.body,
    color: colors.sgs.textMuted,
    fontSize: 12,
  },
});
