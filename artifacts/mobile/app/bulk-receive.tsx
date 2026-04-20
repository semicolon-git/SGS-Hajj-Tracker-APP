import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PrimaryButton } from "@/components/PrimaryButton";
import { ScreenHeader } from "@/components/ScreenHeader";
import { FONTS } from "@/constants/branding";
import colors from "@/constants/colors";
import { useLocale } from "@/contexts/LocaleContext";
import { useScanQueue } from "@/contexts/ScanQueueContext";
import { useSession } from "@/contexts/SessionContext";
import { useScannerMode, useZebraScanner } from "@/hooks/useScanner";
import { decideScan, isSgsHajjTag, normalizeTag } from "@/lib/scanLogic";
import {
  getCachedManifest,
  getScannedTags,
  markTagScanned,
} from "@/lib/db/storage";

type Row = {
  tag: string;
  state: "pending" | "ok" | "duplicate" | "invalid" | "wrong_group" | "missing";
};

export default function BulkReceiveScreen() {
  const router = useRouter();
  const session = useSession();
  const queue = useScanQueue();
  const { effective: scannerSource } = useScannerMode();
  // `isZebra` here gates the source label on the wire only — when the
  // user has forced camera mode on a Zebra device the bulk-receive
  // screen still falls back to keyboard input (no camera UI here), so
  // the source stays "manual" rather than flipping to "camera".
  const isZebra = scannerSource === "zebra";
  const insets = useSafeAreaInsets();
  const { t } = useLocale();

  const [input, setInput] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ accepted: number; skipped: number } | null>(
    null,
  );

  const addTag = useCallback((raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag) return;
    setRows((prev) => {
      if (prev.some((r) => r.tag === tag)) return prev;
      const state: Row["state"] = isSgsHajjTag(tag) ? "pending" : "invalid";
      return [...prev, { tag, state }];
    });
  }, []);

  // Wire up the Zebra trigger so an agent can sweep many bags into the buffer.
  useZebraScanner((raw) => addTag(raw));

  const onAddPasted = () => {
    const lines = input
      .split(/[\r\n,;]+/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const l of lines) addTag(l);
    setInput("");
  };

  const onClear = () => {
    setRows([]);
    setResult(null);
  };

  const counts = useMemo(() => {
    const pending = rows.filter((r) => r.state === "pending").length;
    const invalid = rows.filter((r) => r.state === "invalid").length;
    return { pending, invalid, total: rows.length };
  }, [rows]);

  const onAcceptAll = async () => {
    if (!session.session) return;
    setBusy(true);
    try {
      const groupId = session.session.group.id;
      const flightId = session.session.flight.id;
      const manifest = (await getCachedManifest(groupId)) ?? [];
      const scanned = await getScannedTags(groupId);

      let accepted = 0;
      let skipped = 0;
      const next: Row[] = [];
      const now = Date.now();
      for (const r of rows) {
        if (r.state === "invalid") {
          skipped += 1;
          next.push(r);
          continue;
        }
        const decision = decideScan({
          tagNumber: r.tag,
          groupId,
          manifest,
          scannedTags: scanned,
        });
        if (decision.flash === "green") {
          await markTagScanned(groupId, r.tag);
          scanned.add(r.tag);
          await queue.enqueue({
            tagNumber: r.tag,
            groupId,
            flightId,
            scannedAt: new Date(now).toISOString(),
            source: isZebra ? "zebra" : "manual",
          });
          accepted += 1;
          next.push({ ...r, state: "ok" });
        } else if (decision.flash === "amber") {
          skipped += 1;
          next.push({ ...r, state: "duplicate" });
        } else if (decision.flash === "red") {
          skipped += 1;
          next.push({
            ...r,
            state:
              decision.title === "Wrong Group" ? "wrong_group" : "missing",
          });
        } else {
          skipped += 1;
          next.push({ ...r, state: "invalid" });
        }
      }
      setRows(next);
      setResult({ accepted, skipped });
    } finally {
      setBusy(false);
    }
  };

  if (!session.session) return null;

  return (
    <View style={styles.flex}>
      <ScreenHeader
        title={t("bulkReceiveTitle")}
        subtitle={`${session.session.flight.flightNumber} · ${t("groupLabel")} ${session.session.group.groupNumber}`}
        onBack={() => router.back()}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: insets.bottom + 100 },
          ]}
        >
          <Text style={styles.intro}>{t("bulkReceiveSub")}</Text>

          <View style={styles.inputCard}>
            <Text style={styles.inputHint}>{t("bulkPasteHint")}</Text>
            <TextInput
              value={input}
              onChangeText={setInput}
              multiline
              numberOfLines={5}
              placeholder="SGS123456789&#10;SGS987654321"
              placeholderTextColor={colors.sgs.textDim}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.textarea}
            />
            <View style={styles.inputBtnRow}>
              <PrimaryButton
                label={t("bulkAdd")}
                onPress={onAddPasted}
                style={{ flex: 1 }}
              />
              <PrimaryButton
                label={t("bulkClear")}
                variant="ghost"
                onPress={onClear}
                style={{ flex: 1 }}
              />
            </View>
          </View>

          <View style={styles.summaryRow}>
            <Text style={styles.summaryTxt}>
              {counts.total} · {counts.pending} ✓ · {counts.invalid} ✗
            </Text>
            {result ? (
              <Text style={styles.summaryTxt}>
                {result.accepted} {t("bulkAccepted")} · {result.skipped}{" "}
                {t("bulkSkipped")}
              </Text>
            ) : null}
          </View>

          <View style={styles.list}>
            {rows.length === 0 ? (
              <Text style={styles.empty}>—</Text>
            ) : (
              rows.map((r) => <RowItem key={r.tag} row={r} />)
            )}
          </View>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <PrimaryButton
            label={t("bulkAccept")}
            onPress={onAcceptAll}
            loading={busy}
            disabled={counts.pending === 0}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function RowItem({ row }: { row: Row }) {
  const { t } = useLocale();
  const meta = (() => {
    switch (row.state) {
      case "ok":
        return { color: colors.sgs.green, icon: "check-circle" as const, txt: "✓" };
      case "duplicate":
        return {
          color: colors.sgs.flashAmber,
          icon: "alert-circle" as const,
          txt: t("bulkDuplicateTag"),
        };
      case "invalid":
        return {
          color: colors.sgs.flashOrange,
          icon: "x-circle" as const,
          txt: t("bulkInvalidTag"),
        };
      case "wrong_group":
        return {
          color: colors.sgs.flashRed,
          icon: "x-circle" as const,
          txt: t("bulkOutOfGroup"),
        };
      case "missing":
        return {
          color: colors.sgs.flashRed,
          icon: "help-circle" as const,
          txt: "—",
        };
      default:
        return {
          color: colors.sgs.textMuted,
          icon: "circle" as const,
          txt: "•",
        };
    }
  })();

  return (
    <View style={styles.rowItem}>
      <Feather name={meta.icon} size={18} color={meta.color} />
      <Text style={styles.rowTag}>{row.tag}</Text>
      <Text style={[styles.rowMeta, { color: meta.color }]}>{meta.txt}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  scroll: { padding: 16, gap: 16 },
  intro: {
    fontFamily: FONTS.body,
    fontSize: 14,
    color: colors.sgs.textMuted,
  },
  inputCard: {
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  inputHint: {
    fontFamily: FONTS.body,
    fontSize: 12,
    color: colors.sgs.textDim,
  },
  textarea: {
    backgroundColor: colors.sgs.black,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.body,
    fontSize: 14,
    minHeight: 100,
    padding: 12,
    textAlignVertical: "top",
  },
  inputBtnRow: { flexDirection: "row", gap: 10 },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  summaryTxt: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
    color: colors.sgs.textMuted,
  },
  list: { gap: 6 },
  empty: {
    fontFamily: FONTS.body,
    color: colors.sgs.textDim,
    textAlign: "center",
    paddingVertical: 24,
  },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowTag: {
    flex: 1,
    fontFamily: FONTS.bodyMedium,
    color: colors.sgs.textPrimary,
    fontSize: 14,
  },
  rowMeta: {
    fontFamily: FONTS.body,
    fontSize: 12,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.sgs.black,
    borderTopColor: colors.sgs.border,
    borderTopWidth: 1,
    padding: 12,
  },
});
