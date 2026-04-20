import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Tajawal_400Regular,
  Tajawal_500Medium,
  Tajawal_700Bold,
} from "@expo-google-fonts/tajawal";
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
} from "@expo-google-fonts/dm-sans";
import * as Font from "expo-font";
import * as Updates from "expo-updates";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { DevSettings, I18nManager, Platform } from "react-native";

import { FONTS } from "@/constants/branding";
import { translate, type Locale, type StringKey } from "@/lib/i18n";

const LOCALE_KEY = "sgs.locale";
const SKIP_BIOMETRIC_KEY = "sgs.skipNextBiometric";

type LocaleContextValue = {
  ready: boolean;
  locale: Locale;
  isRTL: boolean;
  t: (key: StringKey) => string;
  setLocale: (l: Locale) => Promise<void>;
  fontFamily: Record<keyof typeof FONTS, string>;
  fontEpoch: number;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * On native we toggle RTL via `I18nManager.forceRTL` so the entire layout
 * mirrors. Returns true iff the native direction flag was actually flipped —
 * callers must then reload the JS bundle, because RN only mirrors layout on
 * startup. Web can't reload the bundle; text alignment still follows the flag.
 */
async function applyRTL(locale: Locale): Promise<boolean> {
  const wantRTL = locale === "ar";
  if (I18nManager.isRTL === wantRTL) return false;
  try {
    I18nManager.allowRTL(wantRTL);
    I18nManager.forceRTL(wantRTL);
    return true;
  } catch {
    return false;
  }
}

async function reloadForRTL() {
  if (Platform.OS === "web") return;
  // Tell BiometricLockGate to let the next cold-start through without a
  // prompt — the reload was our doing, not a real app relaunch.
  try {
    await AsyncStorage.setItem(SKIP_BIOMETRIC_KEY, "1");
  } catch {
    // best-effort; a stray biometric prompt is survivable
  }
  // Production / EAS path: fully restarts the native context so the new RTL
  // flag is picked up. In Expo Go / dev clients this is a stub and will throw.
  try {
    await Updates.reloadAsync();
    return;
  } catch (err) {
    if (!__DEV__) {
      console.warn("[locale] Updates.reloadAsync failed:", err);
    }
  }
  // Dev fallback: reload the JS bundle. On Android this re-creates the RN
  // bridge and picks up the new I18nManager flag. On iOS the native RTL flag
  // is only read at process launch, so a full force-quit is still required.
  try {
    DevSettings.reload();
  } catch (err) {
    console.warn(
      "[locale] Could not reload automatically — fully quit and reopen the app to apply the RTL change.",
      err,
    );
  }
}

/**
 * Remaps the DM Sans font family names to Tajawal glyph files (and back)
 * so every pre-existing StyleSheet that references DMSans_* automatically
 * renders with Tajawal while Arabic is active. This avoids retrofitting
 * every component to look up the locale, and guarantees typography stays
 * in sync with the chosen locale everywhere in the app.
 */
async function applyFontFamily(locale: Locale) {
  try {
    if (locale === "ar") {
      await Font.loadAsync({
        DMSans_400Regular: Tajawal_400Regular,
        DMSans_500Medium: Tajawal_500Medium,
        DMSans_700Bold: Tajawal_700Bold,
      });
    } else {
      await Font.loadAsync({
        DMSans_400Regular,
        DMSans_500Medium,
        DMSans_700Bold,
      });
    }
  } catch {
    // font remap is best-effort; falls back to whatever is already loaded
  }
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [locale, setLocaleState] = useState<Locale>("en");
  const [fontEpoch, setFontEpoch] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(LOCALE_KEY);
        const next: Locale = raw === "ar" ? "ar" : "en";
        setLocaleState(next);
        const flipped = await applyRTL(next);
        await applyFontFamily(next);
        // If the native RTL flag drifted from the stored locale (e.g. first
        // launch on an AR device, reinstall, or a prior session that forced
        // RTL without reloading), restart the bundle so layout actually
        // mirrors instead of silently flipping direction mid-session.
        if (flipped) {
          await reloadForRTL();
          return;
        }
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const setLocale = useCallback(async (next: Locale) => {
    await AsyncStorage.setItem(LOCALE_KEY, next);
    const flipped = await applyRTL(next);
    if (flipped) {
      // Layout mirroring only takes effect after a bundle reload. Persist
      // first, then reload so the app comes back up in the correct direction.
      await reloadForRTL();
      return;
    }
    setLocaleState(next);
    await applyFontFamily(next);
    // Bump the epoch so children remount and re-read the newly registered
    // font glyphs (RN won't re-render mounted text otherwise).
    setFontEpoch((n) => n + 1);
  }, []);

  const t = useCallback(
    (key: StringKey) => translate(locale, key),
    [locale],
  );

  const fontFamily = useMemo<Record<keyof typeof FONTS, string>>(() => {
    if (locale !== "ar") return { ...FONTS };
    return {
      heading: FONTS.arabicBold,
      headingMedium: FONTS.arabic,
      body: FONTS.arabic,
      bodyMedium: FONTS.arabic,
      bodyBold: FONTS.arabicBold,
      arabic: FONTS.arabic,
      arabicBold: FONTS.arabicBold,
    };
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      ready,
      locale,
      isRTL: locale === "ar",
      t,
      setLocale,
      fontFamily,
      fontEpoch,
    }),
    [ready, locale, t, setLocale, fontFamily, fontEpoch],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}
