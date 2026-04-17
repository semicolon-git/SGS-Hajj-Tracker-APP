import React from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

import colors from "@/constants/colors";
import { FONTS } from "@/constants/branding";

export function Field({
  label,
  error,
  ...rest
}: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.sgs.textDim}
        style={[styles.input, error ? { borderColor: colors.sgs.flashRed } : null]}
        {...rest}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
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
  error: {
    fontFamily: FONTS.body,
    fontSize: 13,
    color: colors.sgs.flashRed,
  },
});
