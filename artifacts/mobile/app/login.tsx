import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Field } from "@/components/Field";
import { PrimaryButton } from "@/components/PrimaryButton";
import { SGSLogo } from "@/components/SGSLogo";
import { APP_NAME, FONTS, ORG } from "@/constants/branding";
import colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";

export default function LoginScreen() {
  const router = useRouter();
  const auth = useAuth();
  const insets = useSafeAreaInsets();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    if (!username.trim() || !password) {
      setError("Enter your agent ID and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.signIn(username.trim(), password);
      router.replace("/session-setup");
    } catch (err) {
      setError((err as Error).message || "Login failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <SGSLogo size={84} />
          <Text style={styles.appName}>{APP_NAME}</Text>
          <Text style={styles.org}>{ORG}</Text>
        </View>

        <View style={styles.form}>
          <Field
            label="Agent ID"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="e.g. SGS-1042"
            returnKeyType="next"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            returnKeyType="go"
            onSubmitEditing={onSubmit}
          />
          {error ? <Text style={styles.errorTxt}>{error}</Text> : null}
          <PrimaryButton label="Sign in" onPress={onSubmit} loading={busy} />
        </View>

        <Text style={styles.footer}>
          Hajj Luggage Operations · v1.0
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    gap: 32,
  },
  brand: { alignItems: "center", gap: 14 },
  appName: {
    fontFamily: FONTS.bodyBold,
    fontSize: 28,
    color: colors.sgs.textPrimary,
    letterSpacing: -0.5,
    marginTop: 4,
  },
  org: {
    fontFamily: FONTS.body,
    fontSize: 13,
    color: colors.sgs.textMuted,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  form: { gap: 18 },
  errorTxt: {
    fontFamily: FONTS.bodyMedium,
    color: colors.sgs.flashRed,
    fontSize: 14,
  },
  footer: {
    fontFamily: FONTS.body,
    color: colors.sgs.textDim,
    fontSize: 12,
    textAlign: "center",
    marginTop: "auto",
  },
});
