import { Feather } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import colors from "@/constants/colors";
import { FONTS } from "@/constants/branding";

export function StatusPill({
  online,
  queueSize,
  syncing,
}: {
  online: boolean;
  queueSize: number;
  syncing: boolean;
}) {
  const color = online
    ? queueSize > 0
      ? colors.sgs.flashYellow
      : colors.sgs.green
    : colors.sgs.flashRed;

  return (
    <View style={[styles.wrap, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.txt}>
        {online ? (queueSize > 0 ? `${queueSize} queued` : "Online") : "Offline"}
      </Text>
      {syncing ? (
        <Feather name="refresh-cw" size={11} color={colors.sgs.textPrimary} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  txt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 11,
    letterSpacing: 0.4,
  },
});
