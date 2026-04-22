import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

import colors from "@/constants/colors";
import { FONTS, type FlashColor } from "@/constants/branding";
import { useLocale } from "@/contexts/LocaleContext";

const COLOR_MAP: Record<FlashColor, string> = {
  green: colors.sgs.flashGreen,
  red: colors.sgs.flashRed,
  yellow: colors.sgs.flashYellow,
  amber: colors.sgs.flashAmber,
  orange: colors.sgs.flashOrange,
};

export type FlashDetail = { label: string; value: string };

export function FlashOverlay({
  color,
  title,
  subtitle,
  hint,
  details,
}: {
  color: FlashColor;
  title: string;
  subtitle?: string;
  hint?: string;
  details?: FlashDetail[];
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const { isRTL } = useLocale();
  const isBorder = color === "amber";

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: 80,
      useNativeDriver: true,
    }).start();
  }, [opacity]);

  const bg = COLOR_MAP[color];
  const fg = color === "yellow" ? "#000" : "#FFF";

  if (isBorder) {
    return (
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { opacity }]}
      >
        <View
          style={[StyleSheet.absoluteFill, { borderColor: bg, borderWidth: 16 }]}
        />
        <View style={styles.center} pointerEvents="none">
          <View style={[styles.label, { backgroundColor: bg }]}>
            <Text style={[styles.title, { color: fg }]}>{title}</Text>
            {subtitle ? (
              <Text style={[styles.subtitle, { color: fg }]}>{subtitle}</Text>
            ) : null}
            {details && details.length > 0 ? (
              <View style={styles.details}>
                {details.map((d) => (
                  <Text
                    key={`${d.label}::${d.value}`}
                    style={[
                      styles.detail,
                      { color: fg },
                      isRTL && { writingDirection: "rtl" },
                    ]}
                  >
                    <Text style={styles.detailLabel}>{d.label}: </Text>
                    {d.value}
                  </Text>
                ))}
              </View>
            ) : null}
            {hint ? (
              <Text style={[styles.hint, { color: fg }, isRTL && { writingDirection: "rtl" }]}>{hint}</Text>
            ) : null}
          </View>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: bg, opacity }]}
    >
      <View style={styles.center}>
        <Text style={[styles.title, { color: fg }]}>{title}</Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: fg }]}>{subtitle}</Text>
        ) : null}
        {details && details.length > 0 ? (
          <View style={styles.details}>
            {details.map((d) => (
              <Text
                key={`${d.label}::${d.value}`}
                style={[
                  styles.detail,
                  { color: fg },
                  isRTL && { writingDirection: "rtl" },
                ]}
              >
                <Text style={styles.detailLabel}>{d.label}: </Text>
                {d.value}
              </Text>
            ))}
          </View>
        ) : null}
        {hint ? (
          <Text style={[styles.hint, { color: fg }, isRTL && { writingDirection: "rtl" }]}>{hint}</Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  label: {
    paddingHorizontal: 28,
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: "center",
  },
  title: {
    fontFamily: FONTS.bodyBold,
    fontSize: 44,
    letterSpacing: -0.5,
    textAlign: "center",
  },
  subtitle: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 22,
    marginTop: 8,
    textAlign: "center",
  },
  hint: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 15,
    marginTop: 16,
    textAlign: "center",
    opacity: 0.8,
  },
  details: {
    marginTop: 12,
    alignSelf: "stretch",
    maxWidth: "100%",
  },
  detail: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 18,
    lineHeight: 24,
    marginTop: 4,
    textAlign: "center",
  },
  detailLabel: {
    fontFamily: FONTS.bodyBold,
    opacity: 0.85,
  },
});
