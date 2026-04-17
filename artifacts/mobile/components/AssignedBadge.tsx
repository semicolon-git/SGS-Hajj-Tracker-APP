import React from "react";
import { StyleSheet, Text, View } from "react-native";

import colors from "@/constants/colors";
import { FONTS } from "@/constants/branding";

export function AssignedBadge() {
  return (
    <View style={styles.wrap}>
      <Text style={styles.txt}>ASSIGNED</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.sgs.green,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  txt: {
    color: colors.sgs.black,
    fontFamily: FONTS.bodyBold,
    fontSize: 10,
    letterSpacing: 0.8,
  },
});
