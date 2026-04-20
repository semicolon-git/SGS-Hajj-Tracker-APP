import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import colors from "@/constants/colors";
import { FONTS } from "@/constants/branding";
import { useLocale } from "@/contexts/LocaleContext";

import { SGSLogo } from "./SGSLogo";

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  right,
  showLogo,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  showLogo?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { isRTL } = useLocale();
  // In RTL, flexDirection:row already swaps the back slot to the visual right;
  // mirror the chevron too so it points toward the previous screen.
  const backIcon = isRTL ? "chevron-right" : "chevron-left";
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <View style={styles.row}>
        <View style={styles.left}>
          {onBack ? (
            <Pressable onPress={onBack} hitSlop={12}>
              <Feather name={backIcon} size={28} color={colors.sgs.textPrimary} />
            </Pressable>
          ) : showLogo ? (
            <SGSLogo size={28} />
          ) : null}
        </View>
        <View style={styles.center}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        <View style={styles.right}>{right}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: colors.sgs.black,
    borderBottomWidth: 1,
    borderBottomColor: colors.sgs.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
  },
  left: { width: 56, alignItems: "flex-start" },
  right: { width: 56, alignItems: "flex-end" },
  center: { flex: 1, alignItems: "center" },
  title: {
    fontFamily: FONTS.bodyBold,
    fontSize: 17,
    color: colors.sgs.textPrimary,
    letterSpacing: 0.2,
  },
  subtitle: {
    fontFamily: FONTS.body,
    fontSize: 12,
    color: colors.sgs.textMuted,
    marginTop: 2,
  },
});
