import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { ErrorFallbackProps } from "@/components/ErrorFallback";
import { Field } from "@/components/Field";
import { PrimaryButton } from "@/components/PrimaryButton";
import { ScreenHeader } from "@/components/ScreenHeader";
import { FONTS } from "@/constants/branding";
import colors from "@/constants/colors";
import { useLocale } from "@/contexts/LocaleContext";
import { useScanQueue } from "@/contexts/ScanQueueContext";
import { useSession } from "@/contexts/SessionContext";
import { sgsApi } from "@/lib/api/sgs";

const REASONS = [
  { value: "MISSING", label: "Missing" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "DELAYED", label: "Delayed" },
  { value: "CUSTOMS_HOLD", label: "Customs hold" },
] as const;

/**
 * Screen-local error boundary fallback. When something on this screen
 * throws during render (e.g. an unexpected value from the queue
 * context, a future refactor breaking a hook order, etc.) we no longer
 * blow up to the global "Something went wrong" page. Instead the agent
 * sees a contextual message with a Go back button so they can keep
 * working — the exception itself is logged for the next backend
 * follow-up.
 */
function ExceptionScreenFallback({ error, resetError }: ErrorFallbackProps) {
  const router = useRouter();
  const { t } = useLocale();
  React.useEffect(() => {
    console.error("[exception] screen render crash", {
      error: error?.message,
      stack: error?.stack,
    });
  }, [error]);
  return (
    <View style={fallbackStyles.container}>
      <ScreenHeader
        title="Log Exception"
        onBack={() => {
          resetError();
          router.back();
        }}
      />
      <View style={fallbackStyles.body}>
        <Text style={fallbackStyles.title}>
          {/* Falls back to English if the locale key is missing for any reason. */}
          {t("exceptionScreenCrashTitle") ?? "Exception screen error"}
        </Text>
        <Text style={fallbackStyles.message}>
          {t("exceptionScreenCrashBody") ??
            "Something went wrong on this screen. Try again or go back."}
        </Text>
        {error?.message ? (
          <Text style={fallbackStyles.errorDetail} selectable>
            {error.message}
          </Text>
        ) : null}
        <View style={fallbackStyles.actions}>
          <Pressable
            onPress={() => {
              resetError();
              router.back();
            }}
            style={({ pressed }) => [
              fallbackStyles.btn,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={fallbackStyles.btnTxt}>
              {t("goBack") ?? "Go back"}
            </Text>
          </Pressable>
          <Pressable
            onPress={resetError}
            style={({ pressed }) => [
              fallbackStyles.btnGhost,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={fallbackStyles.btnGhostTxt}>
              {t("tryAgain") ?? "Try again"}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export default function ExceptionScreenWithBoundary() {
  return (
    <ErrorBoundary FallbackComponent={ExceptionScreenFallback}>
      <ExceptionScreen />
    </ErrorBoundary>
  );
}

function ExceptionScreen() {
  const router = useRouter();
  const session = useSession();
  const queue = useScanQueue();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  // Accept ?tag=... and ?groupId=... from the scan screen. The tag
  // pre-fills the form on red flash. The groupId routes the exception
  // to the right group when the agent reached this screen from a
  // group card; otherwise we fall back to a session-pinned group.
  const params = useLocalSearchParams<{
    tag?: string | string[];
    groupId?: string | string[];
  }>();
  const initialTag = Array.isArray(params.tag) ? params.tag[0] : params.tag;
  const paramGroupId = Array.isArray(params.groupId)
    ? params.groupId[0]
    : params.groupId;
  const [pickedGroupId, setPickedGroupId] = useState<string | null>(null);
  const groupId =
    paramGroupId ?? session.session?.group?.id ?? pickedGroupId ?? null;

  // Lazy fetch of groups for the picker fallback. Only enabled when no
  // group has been resolved any other way, so the network call is
  // skipped on the common scan→exception path that already passes
  // ?groupId.
  const groupsQ = useQuery({
    queryKey: ["groups", session.session?.flight.id],
    queryFn: () => sgsApi.groups(session.session!.flight.id),
    enabled: !!session.session && !groupId,
  });

  const [tag, setTag] = useState(initialTag ?? "");
  const [reason, setReason] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  if (!session.session) return null;

  if (!groupId) {
    return (
      <View style={styles.flex}>
        <ScreenHeader
          title="Log Exception"
          subtitle={t("pickGroup")}
          onBack={() => router.back()}
        />
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: insets.bottom + 24 },
          ]}
        >
          <Text style={styles.pickerHint}>{t("pickGroupHint")}</Text>
          {groupsQ.isLoading ? (
            <ActivityIndicator color={colors.sgs.green} />
          ) : (groupsQ.data ?? []).length === 0 ? (
            <Text style={styles.pickerHint}>{t("noGroupsForFlight")}</Text>
          ) : (
            (groupsQ.data ?? []).map((g) => (
              <Pressable
                key={g.id}
                onPress={() => setPickedGroupId(g.id)}
                style={({ pressed }) => [
                  styles.pickerRow,
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Text style={styles.pickerRowTitle}>{g.groupNumber}</Text>
                <Text style={styles.pickerRowSub}>
                  {g.scannedBags}/{g.expectedBags}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    );
  }

  const submit = async () => {
    if (!groupId) {
      Alert.alert(
        "Pick a group",
        "Open this screen from a group card so the exception is routed correctly.",
      );
      return;
    }
    if (!tag.trim() || !reason) {
      Alert.alert("Missing info", "Enter a tag number and select a reason.");
      return;
    }
    setBusy(true);
    const payload = {
      tagNumber: tag.trim(),
      groupId: groupId!,
      flightId: session.session!.flight.id,
      reason,
      notes: notes.trim() || undefined,
    };
    try {
      // Always go through the queue. The queue persists first (durability),
      // then attempts the API call inline when online and resolves with a
      // drain-confirmed status — so we only show "Logged" if the server
      // really accepted it. On failure (timeout, 5xx, offline), the entry
      // remains queued with retry/backoff and we tell the agent it's
      // saved locally and will sync.
      const result = await queue.enqueueException(payload);
      // Defensive: if the queue layer ever returns an unexpected shape
      // (e.g. an upstream contract drift on /api/bags/exception), don't
      // crash the screen — surface a clear error and log the actual
      // value so the next reproduction can be sent to the SGS API team.
      if (!result || (result.status !== "submitted" && result.status !== "queued")) {
        console.error("[exception] unexpected enqueue result", {
          payload,
          result,
        });
        Alert.alert(
          t("exceptionFailedTitle"),
          "Unexpected response from server. The error has been logged.",
        );
        return;
      }
      Alert.alert(
        result.status === "submitted" ? t("logged") : t("queuedOffline"),
        result.status === "submitted"
          ? t("exceptionLoggedBody")
          : t("exceptionQueuedBody"),
        [{ text: "OK", onPress: () => router.back() }],
      );
    } catch (err) {
      // Log the failed payload + raw error so the next reproduction can
      // be captured from the device log and sent to backend. The
      // current contract for /api/bags/exception is documented in the
      // task asks — when this fires in the field, paste the log into
      // the backend ticket.
      const e = err as Error;
      console.error("[exception] submit failed", {
        payload,
        error: e?.message,
        stack: e?.stack,
      });
      Alert.alert(
        t("exceptionFailedTitle"),
        e?.message
          ? `${e.message}\n\nThe full request has been written to the device log.`
          : "Unknown error. The full request has been written to the device log.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.flex}>
      <ScreenHeader title="Log Exception" onBack={() => router.back()} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <Field
            label="Tag Number"
            value={tag}
            onChangeText={setTag}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="e.g. SGS-1923-441"
          />

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Reason</Text>
            <View style={styles.chips}>
              {REASONS.map((r) => {
                const active = r.value === reason;
                return (
                  <Pressable
                    key={r.value}
                    onPress={() => setReason(r.value)}
                    style={[
                      styles.chip,
                      active && {
                        backgroundColor: colors.sgs.green,
                        borderColor: colors.sgs.green,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipTxt,
                        active && { color: colors.sgs.black },
                      ]}
                    >
                      {r.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <Field
            label="Notes (optional)"
            value={notes}
            onChangeText={setNotes}
            placeholder="Describe the issue…"
            multiline
            numberOfLines={4}
            style={{ minHeight: 100, textAlignVertical: "top" }}
          />

          <PrimaryButton label="Log exception" onPress={submit} loading={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  scroll: { padding: 16, gap: 20 },
  section: { gap: 10 },
  sectionLabel: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
    color: colors.sgs.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.sgs.border,
    backgroundColor: colors.sgs.surface,
  },
  chipTxt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
  },
  pickerHint: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 13,
    paddingVertical: 4,
  },
  pickerRow: {
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pickerRowTitle: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 15,
  },
  pickerRowSub: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 13,
  },
});

const fallbackStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.sgs.black },
  body: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 32,
    gap: 16,
  },
  title: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 20,
  },
  message: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 14,
    lineHeight: 20,
  },
  errorDetail: {
    color: colors.sgs.textMuted,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
    fontSize: 12,
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  actions: { flexDirection: "row", gap: 12, marginTop: 8 },
  btn: {
    backgroundColor: colors.sgs.green,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
  },
  btnTxt: {
    color: colors.sgs.black,
    fontFamily: FONTS.bodyBold,
    fontSize: 14,
  },
  btnGhost: {
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
  },
  btnGhostTxt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 14,
  },
});
