import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";

import colors from "@/constants/colors";
import { FONTS } from "@/constants/branding";

export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  variant = "primary",
  style,
  testID,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "primary" | "ghost" | "danger";
  style?: ViewStyle;
  testID?: string;
}) {
  const bg =
    variant === "primary"
      ? colors.sgs.green
      : variant === "danger"
        ? colors.sgs.flashRed
        : "transparent";
  const border = variant === "ghost" ? colors.sgs.border : "transparent";
  const fg = variant === "primary" ? colors.sgs.black : colors.sgs.textPrimary;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: bg,
          borderColor: border,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator color={fg} />
        ) : (
          <Text style={[styles.txt, { color: fg }]}>{label}</Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    height: 56,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  txt: { fontFamily: FONTS.bodyBold, fontSize: 17, letterSpacing: 0.2 },
});
