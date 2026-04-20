import { Feather } from "@expo/vector-icons";
import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useState } from "react";
import { AppState, Platform, StyleSheet, Text, View } from "react-native";

import { PrimaryButton } from "@/components/PrimaryButton";
import { SGSLogo } from "@/components/SGSLogo";
import { APP_NAME, FONTS } from "@/constants/branding";
import colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";
import { useLocale } from "@/contexts/LocaleContext";

const BIOMETRIC_PREF_KEY = "sgs.biometricEnabled";
// Set by LocaleContext before an RTL-triggered reload so the very next cold
// start skips the biometric prompt — otherwise changing language would always
// re-lock the app even though the user never actually left.
const SKIP_NEXT_KEY = "sgs.skipNextBiometric";

export async function setBiometricEnabled(enabled: boolean) {
  await AsyncStorage.setItem(BIOMETRIC_PREF_KEY, enabled ? "1" : "0");
}

export async function isBiometricEnabled(): Promise<boolean> {
  const v = await AsyncStorage.getItem(BIOMETRIC_PREF_KEY);
  return v === "1";
}

export async function isBiometricAvailable(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const compat = await LocalAuthentication.hasHardwareAsync();
    if (!compat) return false;
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return enrolled;
  } catch {
    return false;
  }
}

/**
 * Locks the app behind a biometric prompt when:
 *   - the user has an active session token, AND
 *   - biometric quick-unlock is enabled, AND
 *   - the device supports biometrics.
 *
 * Triggers on cold start and whenever the app returns to the foreground after
 * a meaningful background period (≥30s) so an agent stepping away briefly
 * isn't pestered with prompts.
 */
export function BiometricLockGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const { t } = useLocale();
  const [locked, setLocked] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Cold-start gate: check once after auth is ready.
  useEffect(() => {
    if (!auth.ready) return;
    (async () => {
      if (!auth.token) {
        setLocked(false);
        setChecked(true);
        return;
      }
      const skip = await AsyncStorage.getItem(SKIP_NEXT_KEY);
      if (skip === "1") {
        // Consume the flag and pass through — this cold start was caused by
        // an RTL-triggered reload, not a real app relaunch.
        await AsyncStorage.removeItem(SKIP_NEXT_KEY);
        setChecked(true);
        return;
      }
      const [enabled, available] = await Promise.all([
        isBiometricEnabled(),
        isBiometricAvailable(),
      ]);
      if (enabled && available) {
        setLocked(true);
      }
      setChecked(true);
    })();
  }, [auth.ready, auth.token]);

  // Re-lock when returning from background after >30s.
  useEffect(() => {
    let backgroundedAt: number | null = null;
    const sub = AppState.addEventListener("change", async (state) => {
      if (state === "background" || state === "inactive") {
        backgroundedAt = Date.now();
      }
      if (state === "active" && backgroundedAt && auth.token) {
        const away = Date.now() - backgroundedAt;
        backgroundedAt = null;
        if (away >= 30_000) {
          const [enabled, available] = await Promise.all([
            isBiometricEnabled(),
            isBiometricAvailable(),
          ]);
          if (enabled && available) setLocked(true);
        }
      }
    });
    return () => sub.remove();
  }, [auth.token]);

  const tryUnlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: t("unlockPrompt"),
        cancelLabel: t("signInDifferent"),
        disableDeviceFallback: false,
      });
      if (res.success) {
        setLocked(false);
      } else if (res.error && res.error !== "user_cancel") {
        setError(res.error);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [t]);

  // Auto-prompt the first time the lock screen appears.
  useEffect(() => {
    if (locked) tryUnlock().catch(() => undefined);
  }, [locked, tryUnlock]);

  if (!checked) return null;

  if (!locked) return <>{children}</>;

  return (
    <View style={styles.wrap}>
      <SGSLogo size={84} />
      <Text style={styles.appName}>{APP_NAME}</Text>
      <Text style={styles.user}>{auth.user?.name ?? ""}</Text>
      <View style={{ height: 24 }} />
      <PrimaryButton
        label={t("useBiometric")}
        onPress={tryUnlock}
        loading={busy}
      />
      <View style={{ height: 8 }} />
      <PrimaryButton
        label={t("signInDifferent")}
        variant="ghost"
        onPress={async () => {
          await auth.signOut();
          setLocked(false);
        }}
      />
      {error ? <Text style={styles.errTxt}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.sgs.black,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 8,
  },
  appName: {
    fontFamily: FONTS.bodyBold,
    color: colors.sgs.textPrimary,
    fontSize: 24,
    marginTop: 12,
  },
  user: {
    fontFamily: FONTS.body,
    color: colors.sgs.textMuted,
    fontSize: 14,
  },
  errTxt: {
    fontFamily: FONTS.body,
    color: colors.sgs.flashRed,
    fontSize: 13,
    marginTop: 12,
    textAlign: "center",
  },
});
