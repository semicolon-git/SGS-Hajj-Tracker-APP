import { Feather } from "@expo/vector-icons";
import Constants from "expo-constants";
import React, { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { FONTS } from "@/constants/branding";
import colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";
import { useLocale } from "@/contexts/LocaleContext";
import {
  getLastSeenWhatsNewVersion,
  setLastSeenWhatsNewVersion,
} from "@/lib/db/storage";
import {
  getLatestReleaseNotes,
  getReleaseNotesFor,
  type ReleaseNote,
} from "@/lib/releaseNotes";

/**
 * Auto-shown modal that surfaces release notes after the app updates.
 *
 * Decision flow on mount:
 *   1. Read the running app version from `expo-constants`.
 *   2. Look up bundled notes for that version. If none → never show.
 *   3. Compare against the last-dismissed version in AsyncStorage.
 *      - First-launch (no prior value): suppress, mark seen. The very
 *        first install shouldn't pop a modal — there's nothing "new"
 *        from the agent's perspective.
 *      - Different version with notes: show the sheet.
 *      - Same version: stay hidden.
 *
 * Gated behind `auth.token` so the sheet never appears on top of the
 * login screen — agents see it on their first authenticated screen
 * after the update, where the context makes sense.
 */
export function WhatsNewSheet({
  forceShow,
  onClose,
}: {
  /** When true, bypass the lastSeen check and show the latest notes
   * regardless. Used for the manual "What's new" link in Settings. */
  forceShow?: boolean;
  /** Called when the user dismisses the sheet. Required when
   * `forceShow` is set so the parent can hide it. */
  onClose?: () => void;
} = {}) {
  const auth = useAuth();
  const { t, locale, isRTL } = useLocale();
  const [notes, setNotes] = useState<ReleaseNote | null>(null);

  // Auto-mode: gate on auth and last-seen storage.
  useEffect(() => {
    if (forceShow) return;
    if (!auth.ready || !auth.token) return;
    let cancelled = false;
    (async () => {
      const version = Constants.expoConfig?.version ?? null;
      if (!version) return;
      const entry = getReleaseNotesFor(version);
      if (!entry) return;
      const lastSeen = await getLastSeenWhatsNewVersion();
      if (cancelled) return;
      if (lastSeen === null) {
        // Brand-new install — silently mark as seen so we don't
        // confuse a first-time agent with notes for changes they
        // never experienced.
        await setLastSeenWhatsNewVersion(version);
        return;
      }
      if (lastSeen !== version) {
        setNotes(entry);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.ready, auth.token, forceShow]);

  // Force-show mode: just grab the latest notes (or notes for the
  // running version if available). Used by the Settings link.
  useEffect(() => {
    if (!forceShow) return;
    const version = Constants.expoConfig?.version ?? null;
    const entry =
      (version && getReleaseNotesFor(version)) || getLatestReleaseNotes();
    setNotes(entry);
  }, [forceShow]);

  const dismiss = async () => {
    if (notes && !forceShow) {
      await setLastSeenWhatsNewVersion(notes.version);
    }
    setNotes(null);
    onClose?.();
  };

  if (!notes) return null;
  const bullets = locale === "ar" ? notes.ar : notes.en;
  const title = t("whatsNewTitle").replace("{version}", notes.version);

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={dismiss}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={[styles.title, isRTL && styles.rtl]}>{title}</Text>
          <Text style={[styles.date, isRTL && styles.rtl]}>{notes.date}</Text>
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {bullets.map((b, i) => (
              <View
                key={i}
                style={[styles.bulletRow, isRTL && styles.bulletRowRtl]}
              >
                <Feather
                  name="check"
                  size={16}
                  color={colors.sgs.green}
                  style={styles.bulletIcon}
                />
                <Text style={[styles.bulletText, isRTL && styles.rtl]}>
                  {b}
                </Text>
              </View>
            ))}
          </ScrollView>
          <Pressable
            onPress={dismiss}
            style={({ pressed }) => [
              styles.cta,
              pressed && { opacity: 0.85 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={t("whatsNewCta")}
          >
            <Text style={styles.ctaText}>{t("whatsNewCta")}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.sgs.surfaceElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderColor: colors.sgs.border,
    maxHeight: "80%",
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.sgs.border,
    marginBottom: 12,
  },
  title: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 20,
  },
  date: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 12,
    marginTop: 2,
    marginBottom: 12,
  },
  list: {
    marginBottom: 16,
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginBottom: 12,
  },
  bulletRowRtl: {
    flexDirection: "row-reverse",
  },
  bulletIcon: {
    marginTop: 2,
  },
  bulletText: {
    flex: 1,
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.body,
    fontSize: 14,
    lineHeight: 20,
  },
  rtl: {
    writingDirection: "rtl",
    textAlign: "right",
  },
  cta: {
    backgroundColor: colors.sgs.green,
    borderRadius: 12,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: {
    color: colors.sgs.black,
    fontFamily: FONTS.bodyBold,
    fontSize: 15,
  },
});
