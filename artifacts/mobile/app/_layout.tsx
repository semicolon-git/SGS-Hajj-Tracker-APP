import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
} from "@expo-google-fonts/dm-sans";
import {
  Tajawal_400Regular,
  Tajawal_700Bold,
  useFonts,
} from "@expo-google-fonts/tajawal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { BiometricLockGate } from "@/components/BiometricLockGate";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OtaUpdateGate } from "@/components/OtaUpdateGate";
import { WhatsNewSheet } from "@/components/WhatsNewSheet";
import colors from "@/constants/colors";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { LocaleProvider, useLocale } from "@/contexts/LocaleContext";
import { ScanQueueProvider } from "@/contexts/ScanQueueContext";
import { SessionProvider, useSession } from "@/contexts/SessionContext";
import { isDataWedgeAvailable } from "@/hooks/useScanner";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

const PUBLIC_ROUTES = new Set(["login", "index"]);

function RootStack() {
  const auth = useAuth();
  const session = useSession();
  const { fontEpoch, locale } = useLocale();
  const router = useRouter();
  const segments = useSegments();

  // Protected-route guard. Bounces unauthenticated users to /login, lifts
  // authenticated users off /login toward their next step, and kicks anyone
  // trying to scan without a session back to /session-setup.
  useEffect(() => {
    if (!auth.ready || !session.ready) return;
    const top = (segments[0] ?? "index") as string;
    if (!auth.token && !PUBLIC_ROUTES.has(top)) {
      router.replace("/login");
      return;
    }
    if (auth.token && top === "login") {
      router.replace(session.session ? "/scan" : "/session-setup");
      return;
    }
    if (
      auth.token &&
      (top === "scan" ||
        top === "shift-summary" ||
        top === "bulk-receive") &&
      !session.session
    ) {
      router.replace("/session-setup");
    }
    // Rapid Scan is restricted to supervisor/ops roles. The session-setup
    // entry tile is already role-gated, but route-level enforcement is
    // required so a deep-link or remembered URL from a non-eligible
    // account (e.g. a belt agent) can't bypass the UI gate.
    if (auth.token && top === "rapid-scan") {
      const role = auth.user?.role ?? "";
      const allowed =
        role === "admin" ||
        role === "duty_manager" ||
        role === "airport_ops";
      if (!allowed) {
        router.replace(session.session ? "/scan" : "/session-setup");
      }
    }
  }, [auth.ready, auth.token, auth.user, session.ready, session.session, segments, router]);

  const navKey = Platform.OS === "web" ? locale : `${locale}-${fontEpoch}`;

  return (
    <Stack
      key={navKey}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.sgs.black },
        animation: "fade",
      }}
    />
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
    Tajawal_400Regular,
    Tajawal_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  // Force-instantiate the Zebra native module at app boot. Under the New
  // Architecture (newArchEnabled=true) TurboModules are lazy — ZebraScanModule.
  // initialize() (which registers the DataWedge BroadcastReceiver) only runs
  // when JS first touches the module. The scan screens only subscribe to
  // DeviceEventEmitter, so without this call the receiver never registers and
  // every trigger pull falls into the void on a fresh launch.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    void isDataWedgeAvailable();
  }, []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.sgs.black }}>
            <KeyboardProvider>
              <LocaleProvider>
                <AuthProvider>
                  <SessionProvider>
                    <ScanQueueProvider>
                      <View style={{ flex: 1, backgroundColor: colors.sgs.black }}>
                        <StatusBar style="light" backgroundColor={colors.sgs.black} />
                        <OtaUpdateGate>
                          <BiometricLockGate>
                            <RootStack />
                            <WhatsNewSheet />
                          </BiometricLockGate>
                        </OtaUpdateGate>
                      </View>
                    </ScanQueueProvider>
                  </SessionProvider>
                </AuthProvider>
              </LocaleProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
