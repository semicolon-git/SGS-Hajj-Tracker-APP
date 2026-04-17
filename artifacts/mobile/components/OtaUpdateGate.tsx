import * as Updates from "expo-updates";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import colors from "@/constants/colors";

type Phase = "idle" | "downloading" | "ready" | "applying";

const IDLE_PROMPT_DELAY_MS = 4000;

export function OtaUpdateGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCheckRef = useRef(0);

  const downloadIfAvailable = useCallback(async () => {
    if (!Updates.isEnabled) return;
    if (__DEV__) return;
    const now = Date.now();
    if (now - lastCheckRef.current < 60_000) return;
    lastCheckRef.current = now;
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) return;
      setPhase("downloading");
      const fetched = await Updates.fetchUpdateAsync();
      if (fetched.isNew) {
        if (promptTimer.current) clearTimeout(promptTimer.current);
        // Wait for a short idle window so the agent isn't interrupted
        // mid-trigger; surface the prompt between scans instead.
        promptTimer.current = setTimeout(() => {
          setPhase("ready");
        }, IDLE_PROMPT_DELAY_MS);
      } else {
        setPhase("idle");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }, []);

  const { isUpdatePending } = Updates.useUpdates();

  useEffect(() => {
    void downloadIfAvailable();
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") void downloadIfAvailable();
    });
    return () => {
      sub.remove();
      if (promptTimer.current) clearTimeout(promptTimer.current);
    };
  }, [downloadIfAvailable]);

  useEffect(() => {
    // If a prior session downloaded an update but the agent tapped "Later"
    // (or backgrounded the app before applying), it's still pending on
    // disk — re-surface the prompt after the same idle delay.
    if (!isUpdatePending) return;
    if (__DEV__) return;
    if (promptTimer.current) clearTimeout(promptTimer.current);
    promptTimer.current = setTimeout(() => {
      setPhase((p) => (p === "applying" ? p : "ready"));
    }, IDLE_PROMPT_DELAY_MS);
  }, [isUpdatePending]);

  const apply = useCallback(async () => {
    setPhase("applying");
    try {
      await Updates.reloadAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("ready");
    }
  }, []);

  return (
    <>
      {children}
      <Modal
        visible={phase === "ready" || phase === "applying"}
        transparent
        animationType="fade"
        onRequestClose={() => setPhase("idle")}
      >
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text style={styles.title}>Update ready</Text>
            <Text style={styles.body}>
              A new build of SGS BagScan has finished downloading. Apply it now
              to get the latest fixes — your shift and queued scans are kept.
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.row}>
              <Pressable
                style={[styles.button, styles.buttonGhost]}
                onPress={() => setPhase("idle")}
                disabled={phase === "applying"}
                accessibilityRole="button"
                accessibilityLabel="Apply update later"
              >
                <Text style={styles.buttonGhostText}>Later</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                onPress={apply}
                disabled={phase === "applying"}
                accessibilityRole="button"
                accessibilityLabel="Apply update now"
              >
                {phase === "applying" ? (
                  <ActivityIndicator color={colors.sgs.black} />
                ) : (
                  <Text style={styles.buttonPrimaryText}>Apply now</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "flex-end",
    padding: 16,
  },
  card: {
    backgroundColor: colors.sgs.surfaceElevated,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.sgs.border,
    gap: 12,
  },
  title: {
    color: colors.sgs.textPrimary,
    fontSize: 18,
    fontWeight: "700",
  },
  body: {
    color: colors.sgs.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  error: {
    color: colors.sgs.flashRed,
    fontSize: 13,
  },
  row: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  button: {
    flex: 1,
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonGhost: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.sgs.borderStrong,
  },
  buttonGhostText: {
    color: colors.sgs.textPrimary,
    fontSize: 15,
    fontWeight: "600",
  },
  buttonPrimary: {
    backgroundColor: colors.sgs.green,
  },
  buttonPrimaryText: {
    color: colors.sgs.black,
    fontSize: 15,
    fontWeight: "700",
  },
});
