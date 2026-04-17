import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Field } from "@/components/Field";
import { PrimaryButton } from "@/components/PrimaryButton";
import { ScreenHeader } from "@/components/ScreenHeader";
import colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { sgsApi } from "@/lib/api/sgs";

export default function NoTagScreen() {
  const router = useRouter();
  const session = useSession();
  const auth = useAuth();
  const insets = useSafeAreaInsets();

  const [pilgrimName, setPilgrimName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  if (!session.session) return null;

  const submit = async () => {
    if (!pilgrimName.trim() || !description.trim()) {
      Alert.alert(
        "Missing info",
        "Provide both a pilgrim name and a bag description.",
      );
      return;
    }
    setBusy(true);
    try {
      const res = await sgsApi.registerNoTag({
        pilgrimName: pilgrimName.trim(),
        description: description.trim(),
        groupId: session.session!.group.id,
        flightId: session.session!.flight.id,
        // Forward the agent's station code (e.g. "JED") so the backend
        // generates a tag like "NOTAG-JED-006" rather than defaulting to
        // an unknown station segment.
        stationCode: auth.user?.stationCode,
      });
      Alert.alert(
        "Tag generated",
        `New tag: ${res.tagNumber}\n\nAffix to bag and continue scanning.`,
        [{ text: "OK", onPress: () => router.back() }],
      );
    } catch (err) {
      Alert.alert("Failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.flex}>
      <ScreenHeader title="No-Tag Bag" onBack={() => router.back()} />
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
            label="Pilgrim name"
            value={pilgrimName}
            onChangeText={setPilgrimName}
            autoCapitalize="words"
            placeholder="Full name"
          />
          <Field
            label="Bag description"
            value={description}
            onChangeText={setDescription}
            placeholder="Color, size, brand, distinguishing marks…"
            multiline
            numberOfLines={4}
            style={{ minHeight: 100, textAlignVertical: "top" }}
          />
          <PrimaryButton
            label="Generate tag & log"
            onPress={submit}
            loading={busy}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  scroll: { padding: 16, gap: 20 },
});
