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
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { BiometricLockGate } from "@/components/BiometricLockGate";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OtaUpdateGate } from "@/components/OtaUpdateGate";
import colors from "@/constants/colors";
import { AuthProvider } from "@/contexts/AuthContext";
import { LocaleProvider } from "@/contexts/LocaleContext";
import { ScanQueueProvider } from "@/contexts/ScanQueueContext";
import { SessionProvider } from "@/contexts/SessionContext";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

import { useRouter, useSegments } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";

const PUBLIC_ROUTES = new Set(["login", "index"]);

function RootStack() {
  const auth = useAuth();
  const session = useSession();
  const router = useRouter();
  const segments = useSegments();

  // Protected-route guard. Bounces unauthenticated users to /login and
  // anyone trying to scan without a session back to /session-setup.
  useEffect(() => {
    if (!auth.ready) return;
    const top = (segments[0] ?? "index") as string;
    if (!auth.token && !PUBLIC_ROUTES.has(top)) {
      router.replace("/login");
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
  }, [auth.ready, auth.token, session.session, segments, router]);

  return (
    <Stack
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
