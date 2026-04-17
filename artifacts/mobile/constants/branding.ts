/**
 * SGS BagScan flash + haptic profile (per Doc2 spec).
 */

export const FLASH_DURATIONS = {
  green: 800,
  red: 1500,
  yellow: 1000,
  amber: 1000,
  orange: 1500,
} as const;

export type FlashColor = keyof typeof FLASH_DURATIONS;

export const FONTS = {
  heading: "DMSans_700Bold",
  headingMedium: "DMSans_500Medium",
  body: "DMSans_400Regular",
  bodyMedium: "DMSans_500Medium",
  bodyBold: "DMSans_700Bold",
  arabic: "Tajawal_400Regular",
  arabicBold: "Tajawal_700Bold",
} as const;

export const APP_NAME = "SGS BagScan";
export const ORG = "Saudi Ground Services";
