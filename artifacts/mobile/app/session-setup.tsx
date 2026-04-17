import { Feather } from "@expo/vector-icons";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  cacheAssignments,
  cacheFlights,
  cacheGroups,
  getCachedAssignments,
  getCachedFlights,
  getCachedGroups,
  getCachedManifest,
} from "@/lib/db/storage";
import type {
  BagGroup as BagGroupT,
  Flight as FlightT,
  ManifestBag as ManifestBagT,
} from "@/lib/api/sgs";
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
import { useLocale } from "@/contexts/LocaleContext";
import { useSession } from "@/contexts/SessionContext";
import { sgsApi, type BagGroup, type Flight } from "@/lib/api/sgs";
import { cacheManifest } from "@/lib/db/storage";
import type { StringKey } from "@/lib/i18n";

export default function SessionSetupScreen() {
  const router = useRouter();
  const auth = useAuth();
  const session = useSession();
  const insets = useSafeAreaInsets();
  const { t, locale, setLocale } = useLocale();

  const [selectedFlight, setSelectedFlight] = useState<Flight | null>(null);
  const [pendingGroup, setPendingGroup] = useState<BagGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [flightsCacheAt, setFlightsCacheAt] = useState<string | null>(null);
  const [groupsCacheAt, setGroupsCacheAt] = useState<string | null>(null);

  // Per-flight assignments are a concept that only applies to roles whose
  // duty roster pins them to specific flights (e.g. belt agents working a
  // single inbound). Airport ops agents work the whole airport and the
  // backend (verified live 2026-04-17 with user `yassin`) returns 403 on
  // /api/flights/assignments-all for that role. Skipping the call avoids
  // the silent 403 and correctly hides the "assigned" affordance for roles
  // where it doesn't apply.
  const role = auth.user?.role ?? "";
  const supportsAssignments = role !== "airport_ops";

  const [flightsQ, assignmentsQ] = useQueries({
    queries: [
      {
        queryKey: ["flights"],
        // Try the network first; fall back to AsyncStorage on failure so the
        // screen is usable when the agent is on a poor SGS connection.
        queryFn: async () => {
          try {
            const fresh = await sgsApi.flights();
            await cacheFlights(fresh);
            setFlightsCacheAt(new Date().toISOString());
            return fresh;
          } catch (err) {
            const cached = await getCachedFlights<FlightT[]>();
            if (cached.data) {
              setFlightsCacheAt(cached.cachedAt);
              return cached.data;
            }
            throw err;
          }
        },
      },
      {
        queryKey: ["assignments", role],
        queryFn: async () => {
          try {
            const fresh = await sgsApi.flightAssignments();
            await cacheAssignments(fresh);
            return fresh;
          } catch {
            const cached = await getCachedAssignments<{ flightIds: string[] }>();
            return cached ?? { flightIds: [] };
          }
        },
        enabled: supportsAssignments,
        retry: 0,
      },
    ],
  });

  // Merge assigned ids and sort: assigned flights first, then by departure.
  const flights = React.useMemo(() => {
    const list = flightsQ.data ?? [];
    const assignedIds = new Set(assignmentsQ.data?.flightIds ?? []);
    return [...list]
      .map((f) => ({ ...f, assigned: f.assigned || assignedIds.has(f.id) }))
      .sort((a, b) => {
        if (!!a.assigned !== !!b.assigned) return a.assigned ? -1 : 1;
        return a.departureTime.localeCompare(b.departureTime);
      });
  }, [flightsQ.data, assignmentsQ.data]);

  const groupsQ = useQuery({
    queryKey: ["groups", selectedFlight?.id],
    queryFn: async () => {
      try {
        const fresh = await sgsApi.groups(selectedFlight!.id);
        await cacheGroups(selectedFlight!.id, fresh);
        setGroupsCacheAt(new Date().toISOString());
        return fresh;
      } catch (err) {
        const cached = await getCachedGroups<BagGroupT[]>(selectedFlight!.id);
        if (cached.data) {
          setGroupsCacheAt(cached.cachedAt);
          return cached.data;
        }
        throw err;
      }
    },
    enabled: !!selectedFlight,
  });

  // The live SGS `/api/flight-groups` response does not include a pilgrim
  // count. To still surface a real number on each card we fetch each
  // group's manifest in parallel and derive the count from the unique
  // pilgrim names. Manifests are also written through to the offline cache
  // (and read from it on failure) so this work doubles as a prefetch for
  // the eventual `startSession` call.
  const manifestQs = useQueries({
    queries: (groupsQ.data ?? []).map((g) => ({
      queryKey: ["manifest", g.id],
      queryFn: async (): Promise<ManifestBagT[]> => {
        try {
          const fresh = await sgsApi.manifest(g.id);
          await cacheManifest(g.id, fresh);
          return fresh;
        } catch (err) {
          const cached = await getCachedManifest(g.id);
          if (cached) return cached;
          throw err;
        }
      },
      enabled: !!selectedFlight,
      staleTime: 60_000,
      retry: 0,
    })),
  });

  const pilgrimCounts = React.useMemo(() => {
    const out: Record<string, { count?: number; loading: boolean }> = {};
    (groupsQ.data ?? []).forEach((g, i) => {
      const q = manifestQs[i];
      if (!q || q.isLoading) {
        out[g.id] = { loading: true };
        return;
      }
      const bags = q.data ?? [];
      // Some pilgrims have multiple bags, so count distinct names. Bags
      // missing a name (rare, but possible for no-tag entries) are
      // ignored to avoid inflating the total.
      const names = new Set<string>();
      for (const b of bags) {
        const n = b.pilgrimName?.trim();
        if (n) names.add(n);
      }
      out[g.id] = { count: names.size, loading: false };
    });
    return out;
  }, [groupsQ.data, manifestQs]);

  const startSession = async (group: BagGroup) => {
    if (!selectedFlight) return;
    setBusy(true);
    setError(null);
    setProgressText(t("loadingManifest"));
    try {
      const manifest = await sgsApi.manifest(group.id);
      setProgressText(
        t("loadingManifestN").replace("{n}", String(manifest.length)),
      );
      await cacheManifest(group.id, manifest);
      await session.setSession({
        flight: selectedFlight,
        group,
        startedAt: new Date().toISOString(),
      });
      router.replace("/scan");
    } catch (err) {
      setError((err as Error).message || t("couldNotLoadManifest"));
      setPendingGroup(null);
    } finally {
      setBusy(false);
      setProgressText(null);
    }
  };

  if (!selectedFlight) {
    return (
      <View style={styles.flex}>
        <ScreenHeader
          title={t("selectFlight")}
          subtitle={
            flightsCacheAt && flightsQ.isError
              ? `${t("offlineCached")} ${formatTimeAgo(flightsCacheAt, t)}`
              : auth.user?.name
          }
          showLogo
          right={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
              <Pressable
                onPress={() => setLocale(locale === "ar" ? "en" : "ar")}
                hitSlop={10}
              >
                <Text
                  style={{
                    color: colors.sgs.textPrimary,
                    fontFamily: FONTS.bodyMedium,
                    fontSize: 13,
                  }}
                >
                  {t("language")}
                </Text>
              </Pressable>
              <Pressable onPress={() => auth.signOut()} hitSlop={12}>
                <Feather name="log-out" size={20} color={colors.sgs.textMuted} />
              </Pressable>
            </View>
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
            data={flights}
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
              <Text style={styles.empty}>{t("noFlights")}</Text>
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
        subtitle={
          groupsCacheAt && groupsQ.isError
            ? `${t("offlineCached")} ${formatTimeAgo(groupsCacheAt, t)}`
            : selectedFlight.destination
        }
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
            <GroupCard
              group={item}
              pilgrims={pilgrimCounts[item.id]}
              onPress={() => setPendingGroup(item)}
            />
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>{t("noGroups")}</Text>
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
          <Text style={styles.busyTxt}>{progressText ?? t("loading")}</Text>
        </View>
      ) : null}
      {pendingGroup ? (
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>
              {t("groupLabel")} {pendingGroup.groupNumber}
            </Text>
            <Text style={styles.confirmSub}>
              {(() => {
                const p = pilgrimCounts[pendingGroup.id];
                const fromApi = pendingGroup.pilgrimCount;
                const count =
                  typeof fromApi === "number" ? fromApi : p?.count;
                if (typeof count === "number") {
                  return `${count} ${t("pilgrims")} · ${pendingGroup.expectedBags} ${t("bags")}`;
                }
                if (p?.loading) {
                  return `… ${t("pilgrims")} · ${pendingGroup.expectedBags} ${t("bags")}`;
                }
                return `${pendingGroup.expectedBags} ${t("bags")}`;
              })()}
            </Text>
            <Text style={styles.confirmSub}>
              {selectedFlight.flightNumber} · {selectedFlight.destination}
            </Text>
            <View style={{ height: 16 }} />
            <PrimaryButton
              label={t("startScanning")}
              onPress={() => startSession(pendingGroup)}
            />
            <View style={{ height: 8 }} />
            <PrimaryButton
              label={t("cancel")}
              variant="ghost"
              onPress={() => setPendingGroup(null)}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function formatTimeAgo(iso: string, t: (k: StringKey) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return t("momentsAgo");
  if (diff < 3_600_000)
    return t("minutesAgo").replace("{n}", String(Math.floor(diff / 60_000)));
  if (diff < 86_400_000)
    return t("hoursAgo").replace("{n}", String(Math.floor(diff / 3_600_000)));
  return new Date(iso).toLocaleString();
}

function FlightCard({
  flight,
  onPress,
}: {
  flight: Flight;
  onPress: () => void;
}) {
  const { t } = useLocale();
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
          {flight.bagCount} {t("bags")}
        </Text>
      </View>
    </Pressable>
  );
}

function GroupCard({
  group,
  pilgrims,
  onPress,
}: {
  group: BagGroup;
  pilgrims?: { count?: number; loading: boolean };
  onPress: () => void;
}) {
  const { t } = useLocale();
  const pct = group.expectedBags
    ? Math.min(100, Math.round((group.scannedBags / group.expectedBags) * 100))
    : 0;
  // Prefer the count the server explicitly sent; otherwise fall back to
  // the manifest-derived count. Show a "…" placeholder while the manifest
  // request is still in flight so the card never lies with "0 pilgrims".
  const count =
    typeof group.pilgrimCount === "number"
      ? group.pilgrimCount
      : pilgrims?.count;
  let sub: string;
  if (typeof count === "number") {
    sub = `${count} ${t("pilgrims")} · ${group.expectedBags} ${t("bags")}`;
  } else if (pilgrims?.loading) {
    sub = `… ${t("pilgrims")} · ${group.expectedBags} ${t("bags")}`;
  } else {
    sub = `${group.expectedBags} ${t("bags")}`;
  }
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardRow}>
        <Text style={styles.cardTitle}>
          {t("groupLabel")} {group.groupNumber}
        </Text>
        {group.assigned ? <AssignedBadge /> : null}
      </View>
      <Text style={styles.cardSub}>{sub}</Text>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.metaTxt}>
        {group.scannedBags}/{group.expectedBags} {t("scannedSuffix")} · {pct}%
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
  const { t } = useLocale();
  return (
    <View style={styles.center}>
      <Feather name="wifi-off" size={36} color={colors.sgs.textDim} />
      <Text style={styles.errMsg}>{message}</Text>
      <PrimaryButton label={t("retry")} onPress={onRetry} variant="ghost" />
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
  confirmOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.85)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  confirmCard: {
    width: "100%",
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  confirmTitle: {
    fontFamily: FONTS.bodyBold,
    fontSize: 22,
    color: colors.sgs.textPrimary,
    marginBottom: 4,
  },
  confirmSub: {
    fontFamily: FONTS.body,
    fontSize: 14,
    color: colors.sgs.textMuted,
  },
});
