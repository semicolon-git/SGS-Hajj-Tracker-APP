import { Feather } from "@expo/vector-icons";
import { useQueries } from "@tanstack/react-query";
import {
  cacheAssignments,
  cacheFlights,
  getCachedAssignments,
  getCachedFlights,
} from "@/lib/db/storage";
import type { Flight as FlightT } from "@/lib/api/sgs";
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
import {
  getFlightAirlineCode,
  getFlightDisplayLabel,
  sgsApi,
  type Flight,
} from "@/lib/api/sgs";
import type { StringKey } from "@/lib/i18n";

export default function SessionSetupScreen() {
  const router = useRouter();
  const auth = useAuth();
  const session = useSession();
  const insets = useSafeAreaInsets();
  const { t, locale, setLocale } = useLocale();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [flightsCacheAt, setFlightsCacheAt] = useState<string | null>(null);

  // Per-flight assignments are a concept that only applies to roles whose
  // duty roster pins them to specific flights (e.g. belt agents working a
  // single inbound). Airport ops agents work the whole airport and the
  // backend (verified live 2026-04-17 with user `yassin`) returns 403 on
  // /api/flights/assignments-all for that role. Skipping the call avoids
  // the silent 403 and correctly hides the "assigned" affordance for roles
  // where it doesn't apply.
  const role = auth.user?.role ?? "";
  const supportsAssignments = role !== "airport_ops";
  // Rapid Scan is a high-volume, distraction-free belt-clearing surface for
  // supervisors and the airport-ops role. Belt agents (`agent`), drivers,
  // and other roles never see the entry point.
  const canRapidScan =
    role === "admin" || role === "duty_manager" || role === "airport_ops";

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

  const startFlightSession = async (flight: Flight) => {
    setBusy(true);
    setError(null);
    try {
      // Flight-only session: the scan screen now renders a per-group
      // cards grid above the camera and resolves each scan's group from
      // the merged flight manifest. We deliberately do NOT prefetch the
      // groups / manifests here — the scan screen owns that fetch and
      // gracefully falls back to cached manifests on a poor link.
      await session.setSession({
        flight,
        startedAt: new Date().toISOString(),
      });
      router.replace("/scan");
    } catch (err) {
      setError((err as Error).message || t("couldNotLoadManifest"));
    } finally {
      setBusy(false);
    }
  };

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
          ListHeaderComponent={
            canRapidScan ? (
              <Pressable
                onPress={() => router.push("/rapid-scan")}
                style={({ pressed }) => [
                  styles.rapidCard,
                  pressed && styles.cardPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={t("rapidScan")}
              >
                <View style={styles.rapidIcon}>
                  <Feather name="zap" size={20} color={colors.sgs.green} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rapidTitle}>{t("rapidScan")}</Text>
                  <Text style={styles.rapidSub}>{t("rapidScanSub")}</Text>
                </View>
                <Feather
                  name="chevron-right"
                  size={20}
                  color={colors.sgs.textMuted}
                />
              </Pressable>
            ) : null
          }
          renderItem={({ item }) => (
            <FlightCard
              flight={item}
              onPress={() => startFlightSession(item)}
            />
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>{t("noFlights")}</Text>
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
          <Text style={styles.busyTxt}>{t("loading")}</Text>
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

// Airline + label resolution lives in `lib/api/sgs.ts` so every screen
// formats flights identically. Prefer the discrete server `airlineCode`
// field; fall back to regex-extracting it from a glued `flightNumber`
// for legacy cached payloads. See `getFlightAirlineCode` /
// `getFlightDisplayLabel` for the contract.

// Date format: "Wed 22 Apr · 9:30 PM". Uses the active app locale so
// Arabic mode renders the weekday/month in Arabic without further work.
function formatFlightWhen(iso: string, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const lang = locale === "ar" ? "ar" : "en-US";
  const date = d.toLocaleDateString(lang, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const time = d.toLocaleTimeString(lang, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${date} · ${time}`;
}

function FlightCard({
  flight,
  onPress,
}: {
  flight: Flight;
  onPress: () => void;
}) {
  const { t, locale } = useLocale();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardRow}>
        <View style={styles.titleRow}>
          {getFlightAirlineCode(flight) ? (
            <View style={styles.airlineChip}>
              <Text style={styles.airlineChipTxt}>
                {getFlightAirlineCode(flight)}
              </Text>
            </View>
          ) : null}
          <Text style={styles.cardTitle}>{getFlightDisplayLabel(flight)}</Text>
        </View>
        {flight.assigned ? <AssignedBadge /> : null}
      </View>
      <Text style={styles.cardSub}>{flight.destination}</Text>
      <View style={styles.cardMeta}>
        <Text style={styles.metaTxt}>
          <Feather name="clock" size={11} color={colors.sgs.textMuted} />{" "}
          {formatFlightWhen(flight.departureTime, locale)}
        </Text>
        <Text style={styles.metaTxt}>
          <Feather name="package" size={11} color={colors.sgs.textMuted} />{" "}
          {flight.bagCount} {t("bags")}
        </Text>
      </View>
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
  rapidCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.sgs.surface,
    borderColor: colors.sgs.green,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  rapidIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.sgs.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  rapidTitle: {
    color: colors.sgs.textPrimary,
    fontFamily: FONTS.bodyBold,
    fontSize: 16,
  },
  rapidSub: {
    color: colors.sgs.textMuted,
    fontFamily: FONTS.body,
    fontSize: 12,
    marginTop: 2,
  },
  cardRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  airlineChip: {
    backgroundColor: colors.sgs.surfaceElevated,
    borderColor: colors.sgs.green,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  airlineChipTxt: {
    fontFamily: FONTS.bodyBold,
    fontSize: 12,
    color: colors.sgs.green,
    letterSpacing: 0.5,
  },
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
