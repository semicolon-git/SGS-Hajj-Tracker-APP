import * as Haptics from "expo-haptics";
import { useCallback, useState } from "react";
import { Platform } from "react-native";

import { FLASH_DURATIONS, type FlashColor } from "@/constants/branding";

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
}

export function useFlashFeedback() {
  const [flash, setFlash] = useState<FlashState | null>(null);

  const trigger = useCallback(
    (state: FlashState, haptic: HapticKey) => {
      fire(haptic);
      setFlash(state);
      const ms = FLASH_DURATIONS[state.color];
      setTimeout(() => setFlash(null), ms);
    },
    [],
  );

  return { flash, trigger };
}
