import { Redirect } from "expo-router";
import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";

export default function Index() {
  const auth = useAuth();
  const session = useSession();

  if (!auth.ready || !session.ready) {
    return (
      <View style={styles.wrap}>
        <ActivityIndicator color={colors.sgs.green} />
      </View>
    );
  }

  if (!auth.user) return <Redirect href="/login" />;
  if (!session.session) return <Redirect href="/session-setup" />;
  return <Redirect href="/scan" />;
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sgs.black,
  },
});
