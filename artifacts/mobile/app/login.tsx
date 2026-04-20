import { Feather, Ionicons } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isBiometricAvailable,
  isBiometricEnabled,
  setBiometricEnabled,
} from "@/components/BiometricLockGate";
import { Field } from "@/components/Field";
import { PrimaryButton } from "@/components/PrimaryButton";
import { SGSLogo } from "@/components/SGSLogo";
import { APP_NAME, FONTS, ORG } from "@/constants/branding";
import colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";
import { useLocale } from "@/contexts/LocaleContext";
import { SGS_BASE_URL } from "@/lib/api/sgs";

export default function LoginScreen() {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const { t, locale, setLocale, isRTL } = useLocale();
  // Surface the API host so any future base-URL misconfiguration is
  // visible in the field without needing to attach a debugger.
  const apiHost = React.useMemo(() => {
    try {
      return new URL(SGS_BASE_URL).host;
    } catch {
      return SGS_BASE_URL;
    }
  }, []);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);

  useEffect(() => {
    (async () => {
      const [available, enabled] = await Promise.all([
        isBiometricAvailable(),
        isBiometricEnabled(),
      ]);
      setBioAvailable(available);
      setBioEnabled(enabled);
    })();
  }, []);

  const onSubmit = async () => {
    if (!username.trim() || !password) {
      setError(t("enterCredentials"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.signIn(username.trim(), password);
      // Persist biometric preference selected on this screen so the next
      // cold-start uses quick-unlock. The post-login redirect is handled
      // by the root-layout route guard once `auth.token` flips, which
      // avoids a race where the imperative `router.replace` dispatches
      // before the Stack has settled and drops with "route not found".
      await setBiometricEnabled(bioEnabled && bioAvailable);
    } catch (err) {
      const e = err as Error & { message?: string; status?: number };
      const msg = e?.message || "";
      // Network failure → user is offline; show explicit copy per spec.
      if (
        /network/i.test(msg) ||
        /failed to fetch/i.test(msg) ||
        /typeerror/i.test(msg)
      ) {
        setError(t("offlineLogin"));
      } else {
        setError(msg || t("loginFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? insets.top : 0}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.langRow, isRTL && { alignItems: "flex-start" }]}>
          <Pressable
            onPress={() => setLocale(locale === "ar" ? "en" : "ar")}
            hitSlop={12}
            style={styles.langBtn}
          >
            <Text style={styles.langTxt}>{t("language")}</Text>
          </Pressable>
        </View>

        <View style={styles.brand}>
          <SGSLogo size={84} />
          <Text style={styles.appName}>{APP_NAME}</Text>
          <Text style={styles.org}>{t("org")}</Text>
        </View>

        <View style={styles.form}>
          <Field
            label={t("agentId")}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="e.g. SGS-1042"
            returnKeyType="next"
            isRTL={isRTL}
          />
          <Field
            label={t("password")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            placeholder="••••••••"
            returnKeyType="go"
            onSubmitEditing={onSubmit}
            isRTL={isRTL}
            rightElement={
              <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={8}>
                <Feather
                  name={showPassword ? "eye" : "eye-off"}
                  size={20}
                  color={colors.sgs.textMuted}
                />
              </Pressable>
            }
          />
          {bioAvailable ? (
            <Pressable
              onPress={() => setBioEnabled(!bioEnabled)}
              style={({ pressed }) => [
                styles.bioCard,
                bioEnabled && styles.bioCardActive,
                pressed && styles.bioCardPressed,
              ]}
            >
              <View style={styles.bioRow}>
                <View style={[styles.bioIcon, bioEnabled && styles.bioIconActive]}>
                  <Ionicons
                    name="finger-print"
                    size={20}
                    color={bioEnabled ? colors.sgs.green : colors.sgs.textMuted}
                  />
                </View>
                <View style={styles.bioText}>
                  <Text style={[styles.bioTitle, { textAlign: isRTL ? "right" : "left" }]}>{t("unlockBiometric")}</Text>
                  <Text style={[styles.bioSub, { textAlign: isRTL ? "right" : "left" }]}>{t("useBiometric")}</Text>
                </View>
                <View style={styles.toggleIcon}>
                  <Ionicons
                    name={bioEnabled ? "checkmark-circle" : "ellipse-outline"}
                    size={24}
                    color={bioEnabled ? colors.sgs.green : colors.sgs.textDim}
                  />
                </View>
              </View>
            </Pressable>
          ) : null}
          {error ? <Text style={[styles.errorTxt, { textAlign: isRTL ? "right" : "left" }]}>{error}</Text> : null}
          <PrimaryButton label={t("signIn")} onPress={onSubmit} loading={busy} />
        </View>

        <Text style={styles.footer}>
          {t("appTagline")}
          {/* {auth.lastSyncAt
            ? `\n${t("lastSync")} ${new Date(auth.lastSyncAt).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}`
            : ""} */}
          {/* {`\nAPI: ${apiHost}`} */}
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
  langRow: { alignItems: "flex-end" as const },
  langBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.sgs.border,
  },
  langTxt: {
    fontFamily: FONTS.bodyMedium,
    color: colors.sgs.textPrimary,
    fontSize: 13,
  },
  bioCard: {
    backgroundColor: colors.sgs.surface,
    borderWidth: 1,
    borderColor: colors.sgs.border,
    borderRadius: 12,
  },
  bioCardActive: {
    borderColor: colors.sgs.green,
    backgroundColor: colors.sgs.surfaceElevated,
  },
  bioCardPressed: {
    opacity: 0.8,
  },
  bioRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  bioIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.sgs.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  bioIconActive: {
    backgroundColor: "rgba(60, 179, 74, 0.15)",
  },
  toggleIcon: {
    alignItems: "center",
    justifyContent: "center",
  },
  bioText: {
    flex: 1,
  },
  bioTitle: {
    fontFamily: FONTS.bodyMedium,
    color: colors.sgs.textPrimary,
    fontSize: 14,
  },
  bioSub: {
    fontFamily: FONTS.body,
    color: colors.sgs.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
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
