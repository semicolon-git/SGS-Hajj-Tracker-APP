import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
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

import { Field } from "@/components/Field";
import { PrimaryButton } from "@/components/PrimaryButton";
import { ScreenHeader } from "@/components/ScreenHeader";
import { FONTS } from "@/constants/branding";
import colors from "@/constants/colors";
import { useSession } from "@/contexts/SessionContext";
import { sgsApi } from "@/lib/api/sgs";

const REASONS = [
  "Damaged tag",
  "Wrong destination",
  "Damaged bag",
  "Hazardous content",
  "Excess weight",
  "Other",
] as const;

export default function ExceptionScreen() {
  const router = useRouter();
  const session = useSession();
  const insets = useSafeAreaInsets();

  const [tag, setTag] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  if (!session.session) return null;

  const submit = async () => {
    if (!tag.trim() || !reason) {
      Alert.alert("Missing info", "Enter a tag number and select a reason.");
      return;
    }
    setBusy(true);
    try {
      await sgsApi.submitException({
        tagNumber: tag.trim(),
        groupId: session.session!.group.id,
        flightId: session.session!.flight.id,
        reason,
        notes: notes.trim() || undefined,
      });
      Alert.alert("Logged", "Exception recorded.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err) {
      Alert.alert("Failed", (err as Error).message);
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
                const active = r === reason;
                return (
                  <Pressable
                    key={r}
                    onPress={() => setReason(r)}
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
                      {r}
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
});
