import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AssignedBadge } from "@/components/AssignedBadge";
import { PrimaryButton } from "@/components/PrimaryButton";
import { ScreenHeader } from "@/components/ScreenHeader";
import { FONTS } from "@/constants/branding";
import colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { sgsApi, type BagGroup, type Flight } from "@/lib/api/sgs";
import { cacheManifest } from "@/lib/db/storage";

export default function SessionSetupScreen() {
  const router = useRouter();
  const auth = useAuth();
  const session = useSession();
  const insets = useSafeAreaInsets();

  const [selectedFlight, setSelectedFlight] = useState<Flight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flightsQ = useQuery({
    queryKey: ["flights"],
    queryFn: sgsApi.flights,
  });

  const groupsQ = useQuery({
    queryKey: ["groups", selectedFlight?.id],
    queryFn: () => sgsApi.groups(selectedFlight!.id),
    enabled: !!selectedFlight,
  });

  const startSession = async (group: BagGroup) => {
    if (!selectedFlight) return;
    setBusy(true);
    setError(null);
    try {
      const manifest = await sgsApi.manifest(group.id);
      await cacheManifest(group.id, manifest);
      await session.setSession({
        flight: selectedFlight,
        group,
        startedAt: new Date().toISOString(),
      });
      router.replace("/scan");
    } catch (err) {
      setError((err as Error).message || "Could not load manifest.");
    } finally {
      setBusy(false);
    }
  };

  if (!selectedFlight) {
    return (
      <View style={styles.flex}>
        <ScreenHeader
          title="Select Flight"
          subtitle={auth.user?.name}
          showLogo
          right={
            <Pressable onPress={() => auth.signOut()} hitSlop={12}>
              <Feather name="log-out" size={20} color={colors.sgs.textMuted} />
            </Pressable>
          }
        />
        {flightsQ.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.sgs.green} />
          </View>
        ) : flightsQ.error ? (
          <ErrorState
            message={(flightsQ.error as Error).message}
            onRetry={() => flightsQ.refetch()}
          />
        ) : (
          <FlatList
            data={flightsQ.data ?? []}
            keyExtractor={(f) => f.id}
            contentContainerStyle={[
              styles.list,
              { paddingBottom: insets.bottom + 24 },
            ]}
            ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
            renderItem={({ item }) => (
              <FlightCard flight={item} onPress={() => setSelectedFlight(item)} />
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>No flights assigned today.</Text>
            }
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <ScreenHeader
        title={selectedFlight.flightNumber}
        subtitle={selectedFlight.destination}
        onBack={() => setSelectedFlight(null)}
      />
      {groupsQ.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.sgs.green} />
        </View>
      ) : groupsQ.error ? (
        <ErrorState
          message={(groupsQ.error as Error).message}
          onRetry={() => groupsQ.refetch()}
        />
      ) : (
        <FlatList
          data={groupsQ.data ?? []}
          keyExtractor={(g) => g.id}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + 24 },
          ]}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          renderItem={({ item }) => (
            <GroupCard group={item} onPress={() => startSession(item)} />
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>No groups for this flight.</Text>
          }
        />
      )}
      {error ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorTxt}>{error}</Text>
        </View>
      ) : null}
      {busy ? (
        <View pointerEvents="auto" style={styles.busyOverlay}>
          <ActivityIndicator color={colors.sgs.green} size="large" />
          <Text style={styles.busyTxt}>Caching manifest…</Text>
        </View>
      ) : null}
    </View>
  );
}

function FlightCard({
  flight,
  onPress,
}: {
  flight: Flight;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardRow}>
        <Text style={styles.cardTitle}>{flight.flightNumber}</Text>
        {flight.assigned ? <AssignedBadge /> : null}
      </View>
      <Text style={styles.cardSub}>{flight.destination}</Text>
      <View style={styles.cardMeta}>
        <Text style={styles.metaTxt}>
          <Feather name="clock" size={11} color={colors.sgs.textMuted} />{" "}
          {new Date(flight.departureTime).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Text>
        <Text style={styles.metaTxt}>
          <Feather name="package" size={11} color={colors.sgs.textMuted} />{" "}
          {flight.bagCount} bags
        </Text>
      </View>
    </Pressable>
  );
}

function GroupCard({ group, onPress }: { group: BagGroup; onPress: () => void }) {
  const pct = group.expectedBags
    ? Math.min(100, Math.round((group.scannedBags / group.expectedBags) * 100))
    : 0;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardRow}>
        <Text style={styles.cardTitle}>Group {group.groupNumber}</Text>
        {group.assigned ? <AssignedBadge /> : null}
      </View>
      <Text style={styles.cardSub}>
        {group.pilgrimCount} pilgrims · {group.expectedBags} bags
      </Text>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.metaTxt}>
        {group.scannedBags}/{group.expectedBags} scanned · {pct}%
      </Text>
    </Pressable>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.center}>
      <Feather name="wifi-off" size={36} color={colors.sgs.textDim} />
      <Text style={styles.errMsg}>{message}</Text>
      <PrimaryButton label="Retry" onPress={onRetry} variant="ghost" />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sgs.black },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  list: { padding: 16 },
  empty: {
    color: colors.sgs.textDim,
    fontFamily: FONTS.body,
    textAlign: "center",
    marginTop: 48,
  },
  card: {
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  cardPressed: { opacity: 0.7 },
  cardRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: {
    fontFamily: FONTS.bodyBold,
    fontSize: 20,
    color: colors.sgs.textPrimary,
    letterSpacing: -0.3,
  },
  cardSub: {
    fontFamily: FONTS.body,
    fontSize: 14,
    color: colors.sgs.textMuted,
  },
  cardMeta: { flexDirection: "row", gap: 16, marginTop: 4 },
  metaTxt: {
    fontFamily: FONTS.body,
    fontSize: 12,
    color: colors.sgs.textMuted,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.sgs.surfaceElevated,
    overflow: "hidden",
    marginTop: 4,
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.sgs.green,
  },
  errMsg: {
    fontFamily: FONTS.body,
    color: colors.sgs.textPrimary,
    textAlign: "center",
    fontSize: 14,
  },
  errorBar: {
    backgroundColor: colors.sgs.flashRed,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  errorTxt: {
    color: "#FFF",
    fontFamily: FONTS.bodyMedium,
    fontSize: 13,
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  busyTxt: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyMedium,
    fontSize: 14,
  },
});
