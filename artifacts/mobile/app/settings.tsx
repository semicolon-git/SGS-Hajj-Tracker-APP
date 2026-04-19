import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import * as Updates from "expo-updates";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { FONTS } from "@/constants/branding";
import colors from "@/constants/colors";
import { useLocale } from "@/contexts/LocaleContext";
import { useOtaUpdater, type OtaCheckPhase } from "@/hooks/useOtaUpdater";
import {
  reconfigureZebraProfile,
  useIsZebraDevice,
} from "@/hooks/useScanner";
import { getDebugRawScan, setDebugRawScan } from "@/lib/db/storage";
import type { StringKey } from "@/lib/i18n";

type T = (k: StringKey) => string;

const COPIED_FEEDBACK_MS = 1500;

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useLocale();
  const { phase, error, check, apply } = useOtaUpdater();

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rawScanOn, setRawScanOn] = useState(false);

  const isZebra = useIsZebraDevice();
  // The reconfigure button is rendered for any Zebra device. The
  // missing-DataWedge case is reported by reconfigureZebraProfile()
  // itself (result.dataWedgeMissing → t("reconfigureNoDataWedge")) so
  // the operator always gets explicit feedback rather than a silently
  // hidden control.
  const [reconfigState, setReconfigState] = useState<{
    phase: "idle" | "running" | "done" | "error";
    message?: string;
  }>({ phase: "idle" });
  const reconfigTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (reconfigTimer.current) clearTimeout(reconfigTimer.current);
    };
  }, []);

  const runReconfigure = useCallback(async () => {
    setReconfigState({ phase: "running" });
    const result = await reconfigureZebraProfile();
    if (reconfigTimer.current) clearTimeout(reconfigTimer.current);
    if (!result.ok) {
      setReconfigState({
        phase: "error",
        message: `${t("reconfigureFailed")} ${result.error}`.trim(),
      });
    } else if (result.dataWedgeMissing) {
      setReconfigState({
        phase: "done",
        message: t("reconfigureNoDataWedge"),
      });
    } else {
      setReconfigState({
        phase: "done",
        message: t("reconfigureOk"),
      });
    }
    // Auto-clear the result line after 6s so it doesn't linger on the
    // settings screen forever.
    reconfigTimer.current = setTimeout(
      () => setReconfigState({ phase: "idle" }),
      6000,
    );
  }, [t]);

  useEffect(() => {
    let alive = true;
    getDebugRawScan().then((on) => {
      if (alive) setRawScanOn(on);
    });
    return () => {
      alive = false;
    };
  }, []);

  const toggleRawScan = useCallback(
    (next: boolean) => {
      // Optimistic local update so the switch never feels laggy; the
      // AsyncStorage write is fire-and-forget and non-blocking.
      setRawScanOn(next);
      void setDebugRawScan(next);
    },
    [],
  );

  // Read OTA fields directly off the Updates module so the values reflect
  // whatever bundle is actually executing right now (not what was bundled
  // at build time).
  const appVersion = Constants.expoConfig?.version ?? "unknown";
  const runtimeVersion =
    typeof Updates.runtimeVersion === "string" && Updates.runtimeVersion
      ? Updates.runtimeVersion
      : "—";
  const channel = Updates.channel || "—";
  const updateId = Updates.updateId || "embedded";
  const isEmbedded = Updates.isEmbeddedLaunch;

  const buildLabel = useMemo(() => {
    return runtimeVersion && runtimeVersion !== "—"
      ? `v${appVersion} · runtime ${runtimeVersion}`
      : `v${appVersion}`;
  }, [appVersion, runtimeVersion]);

  const diagnostic = [
    `app: SGS BagScan ${appVersion}`,
    `runtime: ${runtimeVersion}`,
    `channel: ${channel}`,
    `updateId: ${updateId}`,
    `embedded: ${isEmbedded ? "yes" : "no"}`,
  ].join("\n");

  const copy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(diagnostic);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      // best-effort; swallow so the screen never crashes from clipboard
    }
  }, [diagnostic]);

  return (
    <View style={styles.flex}>
      <ScreenHeader title={t("settings")} onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("appUpdates")}</Text>
          <Text style={styles.sectionBody}>{t("appUpdatesBody")}</Text>

          <UpdateButton
            phase={phase}
            onCheck={check}
            onApply={apply}
            t={t}
          />

          <Text style={styles.statusLine}>
            <StatusText phase={phase} t={t} />
          </Text>
          {error ? <Text style={styles.errorLine}>{error}</Text> : null}
          <Text style={styles.metaLine}>{buildLabel}</Text>
        </View>

        <Text style={styles.sectionLabel}>App version</Text>
        <Pressable
          onPress={copy}
          accessibilityRole="button"
          accessibilityLabel="Copy diagnostic info to clipboard"
          accessibilityHint="Copies the app version and update id so you can paste it into a support chat"
          style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
        >
          <Row label="App" value={formatValue(appVersion)} />
          <Row label="Runtime" value={formatValue(runtimeVersion)} />
          <Row label="Channel" value={formatValue(channel)} />
          <Row label="Update ID" value={formatValue(updateId)} mono />
          <Row label="Source" value={isEmbedded ? "Embedded build" : "OTA update"} />
          <View style={styles.copyRow}>
            <Feather
              name={copied ? "check" : "copy"}
              size={14}
              color={copied ? colors.sgs.green : colors.sgs.textMuted}
            />
            <Text style={[styles.copyHint, copied && styles.copyHintCopied]}>
              {copied ? "Copied to clipboard" : "Tap to copy for support"}
            </Text>
          </View>
        </Pressable>
        <Text style={styles.helpText}>
          Share this with the SGS BagScan team when reporting an issue so they
          can confirm exactly which build your device is on.
        </Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("diagnostics")}</Text>
          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <Text style={styles.toggleLabel}>{t("showRawScan")}</Text>
              <Text style={styles.toggleBody}>{t("showRawScanBody")}</Text>
            </View>
            <Switch
              value={rawScanOn}
              onValueChange={toggleRawScan}
              accessibilityRole="switch"
              accessibilityLabel={t("showRawScan")}
              trackColor={{ false: colors.sgs.borderStrong, true: colors.sgs.green }}
              thumbColor={rawScanOn ? colors.sgs.black : colors.sgs.textPrimary}
            />
          </View>

          {/* Render the Zebra reconfigure block whenever we're on Zebra
              hardware, even if DataWedge isn't installed. The button
              itself reports the missing-DataWedge case via the
              reconfigureZebraProfile() result so the operator gets
              explicit feedback instead of a silently hidden control. */}
          {isZebra ? (
            <View style={styles.diagBlock}>
              <Text style={styles.toggleLabel}>{t("reconfigureScanner")}</Text>
              <Text style={styles.toggleBody}>
                {t("reconfigureScannerBody")}
              </Text>
              <Pressable
                onPress={runReconfigure}
                disabled={reconfigState.phase === "running"}
                accessibilityRole="button"
                accessibilityLabel={t("reconfigureScannerCta")}
                style={({ pressed }) => [
                  styles.diagBtn,
                  {
                    opacity:
                      reconfigState.phase === "running"
                        ? 0.7
                        : pressed
                          ? 0.85
                          : 1,
                  },
                ]}
              >
                <View style={styles.btnRow}>
                  {reconfigState.phase === "running" ? (
                    <ActivityIndicator color={colors.sgs.textPrimary} />
                  ) : (
                    <Feather
                      name="zap"
                      size={16}
                      color={colors.sgs.textPrimary}
                    />
                  )}
                  <Text style={styles.diagBtnTxt}>
                    {reconfigState.phase === "running"
                      ? t("reconfigureRunning")
                      : t("reconfigureScannerCta")}
                  </Text>
                </View>
              </Pressable>
              {reconfigState.message ? (
                <Text
                  style={
                    reconfigState.phase === "error"
                      ? styles.diagError
                      : styles.diagOk
                  }
                >
                  {reconfigState.message}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function UpdateButton({
  phase,
  onCheck,
  onApply,
  t,
}: {
  phase: OtaCheckPhase;
  onCheck: () => void;
  onApply: () => void;
  t: T;
}) {
  const busy =
    phase === "checking" || phase === "downloading" || phase === "applying";
  const isReady = phase === "ready";
  const onPress = isReady ? onApply : onCheck;
  const label = isReady
    ? t("applyUpdateNow")
    : phase === "checking"
      ? t("checking")
      : phase === "downloading"
        ? t("downloading")
        : phase === "applying"
          ? t("applying")
          : t("checkForUpdates");

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy, busy }}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: isReady ? colors.sgs.green : colors.sgs.surfaceElevated,
          borderColor: isReady ? colors.sgs.green : colors.sgs.borderStrong,
          opacity: busy ? 0.7 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.btnRow}>
        {busy ? (
          <ActivityIndicator
            color={isReady ? colors.sgs.black : colors.sgs.textPrimary}
          />
        ) : (
          <Feather
            name={isReady ? "download" : "refresh-cw"}
            size={18}
            color={isReady ? colors.sgs.black : colors.sgs.textPrimary}
          />
        )}
        <Text
          style={[
            styles.btnLabel,
            { color: isReady ? colors.sgs.black : colors.sgs.textPrimary },
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

function StatusText({
  phase,
  t,
}: {
  phase: OtaCheckPhase;
  t: T;
}) {
  switch (phase) {
    case "checking":
      return <>{t("checking")}</>;
    case "downloading":
      return <>{t("downloading")}</>;
    case "ready":
      return <>{t("updateReady")}</>;
    case "applying":
      return <>{t("applying")}</>;
    case "upToDate":
      return <>{t("upToDate")}</>;
    case "idle":
    default:
      return <>{t("checkForUpdatesHint")}</>;
  }
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[styles.rowValue, mono && styles.rowValueMono]}
        numberOfLines={2}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  content: { padding: 16, gap: 16 },
  section: {
    backgroundColor: colors.sgs.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.sgs.border,
    padding: 16,
    gap: 10,
  },
  sectionTitle: {
    fontFamily: FONTS.bodyBold,
    fontSize: 16,
    color: colors.sgs.textPrimary,
  },
  sectionBody: {
    fontFamily: FONTS.body,
    fontSize: 13,
    color: colors.sgs.textMuted,
    lineHeight: 18,
  },
  btn: {
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    marginTop: 4,
  },
  btnRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  btnLabel: {
    fontFamily: FONTS.bodyBold,
    fontSize: 15,
    letterSpacing: 0.2,
  },
  statusLine: {
    fontFamily: FONTS.body,
    fontSize: 13,
    color: colors.sgs.textMuted,
    marginTop: 4,
  },
  errorLine: {
    fontFamily: FONTS.body,
    fontSize: 13,
    color: colors.sgs.flashRed,
  },
  metaLine: {
    fontFamily: FONTS.body,
    fontSize: 12,
    color: colors.sgs.textDim,
    marginTop: 4,
  },
  sectionLabel: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 12,
    color: colors.sgs.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 4,
  },
  card: {
    backgroundColor: colors.sgs.surfaceElevated,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.sgs.border,
    padding: 16,
    gap: 10,
  },
  cardPressed: { opacity: 0.7 },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  rowLabel: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
    color: colors.sgs.textMuted,
    minWidth: 80,
  },
  rowValue: {
    flex: 1,
    fontFamily: FONTS.body,
    fontSize: 14,
    color: colors.sgs.textPrimary,
    textAlign: "right",
  },
  rowValueMono: {
    fontSize: 12,
    fontFamily: FONTS.body,
  },
  copyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.sgs.border,
  },
  copyHint: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 12,
    color: colors.sgs.textMuted,
  },
  copyHintCopied: { color: colors.sgs.green },
  helpText: {
    fontFamily: FONTS.body,
    fontSize: 12,
    color: colors.sgs.textMuted,
    lineHeight: 18,
    paddingHorizontal: 4,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 4,
  },
  toggleText: { flex: 1 },
  toggleLabel: {
    fontFamily: FONTS.bodyBold,
    fontSize: 14,
    color: colors.sgs.textPrimary,
  },
  toggleBody: {
    fontFamily: FONTS.body,
    fontSize: 12,
    color: colors.sgs.textMuted,
    lineHeight: 17,
    marginTop: 2,
  },
  diagBlock: {
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.sgs.border,
    gap: 8,
  },
  diagBtn: {
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.sgs.borderStrong,
    backgroundColor: colors.sgs.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    marginTop: 4,
  },
  diagBtnTxt: {
    fontFamily: FONTS.bodyBold,
    fontSize: 14,
    color: colors.sgs.textPrimary,
    letterSpacing: 0.2,
  },
  diagOk: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 12,
    color: colors.sgs.green,
  },
  diagError: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 12,
    color: colors.sgs.flashRed,
  },
});
