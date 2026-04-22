import { Feather } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import colors from "@/constants/colors";
import { FONTS } from "@/constants/branding";
import { useLocale } from "@/contexts/LocaleContext";

export function StatusPill({
  online,
  queueSize,
  syncing,
}: {
  online: boolean;
  queueSize: number;
  syncing: boolean;
}) {
  const { t } = useLocale();
  // Connection state and queue depth are now two independent signals so
  // the agent always sees the link status, even when something is
  // pending. Colour stays semantic: green = online, red = offline,
  // amber badge = items waiting to upload.
  const connectionColor = online ? colors.sgs.green : colors.sgs.flashRed;
  const queueColor = colors.sgs.flashYellow;

  return (
    <View style={styles.row}>
      <View style={[styles.wrap, { borderColor: connectionColor }]}>
        <View style={[styles.dot, { backgroundColor: connectionColor }]} />
        <Text style={styles.txt}>{online ? t("online") : t("offline")}</Text>
        {syncing ? (
          <Feather name="refresh-cw" size={11} color={colors.sgs.textPrimary} />
        ) : null}
      </View>
      {queueSize > 0 ? (
        <View style={[styles.queueBadge, { borderColor: queueColor }]}>
          <Text style={[styles.queueTxt, { color: queueColor }]}>
            {queueSize}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  txt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 10,
    letterSpacing: 0.2,
  },
  queueBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    minWidth: 18,
    alignItems: "center",
  },
  queueTxt: {
    fontFamily: FONTS.bodyBold,
    fontSize: 10,
    letterSpacing: 0.2,
  },
});
