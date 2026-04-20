/**
 * Unified scan-source detector.
 *
 * - On Zebra enterprise handhelds (TC57HO, TC72, TC77, MC93), the DataWedge
 *   service is configured to broadcast a barcode intent into the React Native
 *   layer. This hook subscribes to that broadcast via DeviceEventEmitter
 *   ("ZebraScan"), which a small native module (BroadcastReceiver -> RN bridge)
 *   forwards. In Expo Go (no native module), this stays silent and the camera
 *   fallback takes over.
 * - On consumer phones, callers should mount the camera scan UI.
 */

import * as Device from "expo-device";
import { useCallback, useEffect, useRef, useState } from "react";
import { DeviceEventEmitter, NativeModules, Platform } from "react-native";

import { normalizeTag } from "@/lib/scanLogic";
import {
  getScannerMode,
  setScannerMode as persistScannerMode,
  type ScannerMode,
} from "@/lib/db/storage";

const ZEBRA_MANUFACTURERS = ["zebra", "zebra technologies"];
const ZEBRA_MODELS = ["TC57HO", "TC72", "TC77", "MC93"];

export interface ZebraScanEvent {
  data: string;
  symbology?: string;
}

export function useIsZebraDevice(): boolean {
  const [isZebra, setIsZebra] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const m = (Device.manufacturer || "").toLowerCase();
    const model = (Device.modelName || "").toUpperCase();
    if (
      ZEBRA_MANUFACTURERS.includes(m) ||
      ZEBRA_MODELS.some((z) => model.includes(z))
    ) {
      setIsZebra(true);
    }
  }, []);
  return isZebra;
}

export interface ScannerModeState {
  /** User-selected preference from Settings — auto by default. */
  mode: ScannerMode;
  /**
   * Source the app should actually use right now. In auto mode this folds
   * the device detection in (Zebra hardware → "zebra"; else → "camera").
   * In an explicit mode it equals `mode`. Callers should branch on this,
   * not on `useIsZebraDevice` directly.
   */
  effective: "zebra" | "camera";
  /** Raw device-detection result, exposed so Settings can show what was detected. */
  detected: boolean;
  /** True once the persisted preference has been hydrated from AsyncStorage. */
  ready: boolean;
  setMode: (mode: ScannerMode) => void;
}

/**
 * Single source of truth for which scanner the UI should drive.
 *
 * The persisted preference is hydrated optimistically: we render with
 * `mode="auto"` immediately and overwrite once AsyncStorage resolves.
 * That avoids a UI flash on the scan screen — `effective` lands on the
 * right value within the same frame the device-detection effect resolves.
 */
export function useScannerMode(): ScannerModeState {
  const detected = useIsZebraDevice();
  const [mode, setModeState] = useState<ScannerMode>("auto");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    getScannerMode().then((stored) => {
      if (!alive) return;
      setModeState(stored);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setMode = useCallback((next: ScannerMode) => {
    setModeState(next);
    void persistScannerMode(next);
  }, []);

  const effective: "zebra" | "camera" =
    mode === "auto" ? (detected ? "zebra" : "camera") : mode;

  return { mode, effective, detected, ready, setMode };
}

/**
 * Subscribe to the cleaned scan stream. Payloads are normalized
 * (whitespace/AIM prefix stripped) before being delivered. Used by the
 * scan screen for the green/red flash logic.
 */
export function useZebraScanner(onBarcode: (data: string) => void) {
  const cb = useRef(onBarcode);
  cb.current = onBarcode;
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      "ZebraScan",
      (event: ZebraScanEvent) => {
        if (!event?.data) return;
        // GS1 control chars + AIM prefix stripping happens here so every
        // downstream consumer sees a clean tag string.
        const clean = normalizeTag(event.data);
        if (clean) cb.current(clean);
      },
    );
    return () => sub.remove();
  }, []);
}

/**
 * Subscribe to *every* raw Zebra scan event — even ones where the payload
 * normalizes to empty. Diagnostic only: powers the "Show raw scan" banner
 * and the "no scans received" warning ribbon so an agent can prove the
 * trigger is reaching the app even when the tag itself is rejected.
 */
export function useZebraScanRaw(onEvent: (event: ZebraScanEvent) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      "ZebraScan",
      (event: ZebraScanEvent) => {
        if (!event) return;
        cb.current(event);
      },
    );
    return () => sub.remove();
  }, []);
}

// ---------- Native module wrappers ----------

interface ZebraScanNativeModule {
  reconfigureProfile: () => Promise<{ status: "ok" | "datawedge_not_installed" }>;
  isDataWedgeAvailable: () => Promise<boolean>;
}

function getNative(): ZebraScanNativeModule | null {
  const mod = (NativeModules as Record<string, unknown>).ZebraScanModule;
  return (mod as ZebraScanNativeModule | undefined) ?? null;
}

export type ReconfigureResult =
  | { ok: true; dataWedgeMissing?: false }
  | { ok: true; dataWedgeMissing: true }
  | { ok: false; error: string };

/**
 * Re-runs the DataWedge profile setup. Surface the result in a toast so
 * the agent gets immediate feedback: "Scanner reconfigured" / "DataWedge
 * not installed on this device" / specific error.
 *
 * Safe to call on non-Zebra devices — returns `dataWedgeMissing: true`
 * so the caller can show a friendly message instead of crashing.
 */
export async function reconfigureZebraProfile(): Promise<ReconfigureResult> {
  const native = getNative();
  if (!native) {
    return { ok: true, dataWedgeMissing: true };
  }
  try {
    const r = await native.reconfigureProfile();
    if (r.status === "datawedge_not_installed") {
      return { ok: true, dataWedgeMissing: true };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Returns true only if the native bridge is available AND DataWedge is
 * installed. Used to decide whether to render the Reconfigure button.
 */
export async function isDataWedgeAvailable(): Promise<boolean> {
  const native = getNative();
  if (!native) return false;
  try {
    return await native.isDataWedgeAvailable();
  } catch {
    return false;
  }
}
