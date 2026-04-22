import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import { FLASH_DURATIONS, type FlashColor } from "@/constants/branding";
import type { FlashDetail } from "@/components/FlashOverlay";

export type HapticKey = "success" | "error" | "duplicate" | "warning";

async function fire(haptic: HapticKey) {
  if (Platform.OS === "web") return;
  try {
    if (haptic === "success") {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else if (haptic === "error") {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setTimeout(
        () =>
          Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Error,
          ).catch(() => undefined),
        110,
      );
      setTimeout(
        () =>
          Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Error,
          ).catch(() => undefined),
        220,
      );
    } else if (haptic === "duplicate") {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setTimeout(
        () =>
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
            () => undefined,
          ),
        90,
      );
    } else if (haptic === "warning") {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  } catch {
    // ignore
  }
}

export interface FlashState {
  color: FlashColor;
  title: string;
  subtitle?: string;
  hint?: string;
  details?: FlashDetail[];
}

export function useFlashFeedback() {
  const [flash, setFlash] = useState<FlashState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const trigger = useCallback(
    (
      state: FlashState,
      haptic: HapticKey,
      /**
       * Optional explicit on-screen duration in milliseconds. When
       * omitted the per-color default from `FLASH_DURATIONS` is used.
       *
       * Pass `0` (or any non-positive value) to make the flash
       * **sticky** — it stays mounted until either the next `trigger`
       * replaces its content or `clearFlash` is called. Used by Rapid
       * Scan so a supervisor reading from across the belt isn't racing
       * a 1.5 s timer; the haptic + sound still fire on the existing
       * rhythm because they're decoupled from the visual dwell.
       */
      durationMs?: number,
    ) => {
      fire(haptic);
      // Always cancel any previously-pending fade so a sticky flash
      // can't be wiped out by an earlier fixed-duration timer that
      // hadn't fired yet.
      cancelTimer();
      setFlash(state);
      const ms = durationMs ?? FLASH_DURATIONS[state.color];
      if (ms > 0) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setFlash(null);
        }, ms);
      }
    },
    [cancelTimer],
  );

  const clearFlash = useCallback(() => {
    cancelTimer();
    setFlash(null);
  }, [cancelTimer]);

  // Hygiene: clear any pending timer on unmount so a slow fade can't
  // call setFlash on a torn-down component.
  useEffect(() => cancelTimer, [cancelTimer]);

  return { flash, trigger, clearFlash };
}
