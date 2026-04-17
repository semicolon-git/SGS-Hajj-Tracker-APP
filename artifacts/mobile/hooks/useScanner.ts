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
import { useEffect, useRef, useState } from "react";
import { DeviceEventEmitter, Platform } from "react-native";

const ZEBRA_MANUFACTURERS = ["zebra", "zebra technologies"];
const ZEBRA_MODELS = ["TC57HO", "TC72", "TC77", "MC93"];

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

export function useZebraScanner(onBarcode: (data: string) => void) {
  const cb = useRef(onBarcode);
  cb.current = onBarcode;
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      "ZebraScan",
      (event: { data?: string }) => {
        if (event?.data) cb.current(event.data);
      },
    );
    return () => sub.remove();
  }, []);
}
