import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import colors from "@/constants/colors";
import { FONTS } from "@/constants/branding";

export function Field({
  label,
  error,
  rightElement,
  isRTL = false,
  ...rest
}: TextInputProps & { label: string; error?: string; rightElement?: React.ReactNode; isRTL?: boolean }) {
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { textAlign: isRTL ? "right" : "left" }]}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          placeholderTextColor={colors.sgs.textDim}
          textAlign={isRTL ? "right" : "left"}
          textBreakStrategy="simple"
          style={[
            styles.input,
            rightElement
              ? isRTL
                ? styles.inputWithLeft
                : styles.inputWithRight
              : null,
            error ? { borderColor: colors.sgs.flashRed } : null,
          ]}
          {...rest}
        />
        {rightElement ? (
          <View style={isRTL ? styles.leftEl : styles.rightEl}>{rightElement}</View>
        ) : null}
      </View>
      {error ? <Text style={[styles.error, { textAlign: isRTL ? "right" : "left" }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  label: {
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
    color: colors.sgs.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  inputRow: {
    position: "relative" as ViewStyle["position"],
  },
  input: {
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.body,
    fontSize: 17,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  inputWithRight: {
    paddingRight: 52,
  },
  inputWithLeft: {
    paddingLeft: 52,
  },
  rightEl: {
    position: "absolute" as ViewStyle["position"],
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  leftEl: {
    position: "absolute" as ViewStyle["position"],
    left: 0,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  error: {
    fontFamily: FONTS.body,
    fontSize: 13,
    color: colors.sgs.flashRed,
  },
});
