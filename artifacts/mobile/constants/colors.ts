/**
 * SGS BagScan brand palette.
 * Strict brand-guideline colors. Dark mode only (black background).
 */

const sgs = {
  green: "#3CB34A",
  greenDark: "#2A8A37",
  greenLight: "#4FD05F",
  black: "#000000",
  surface: "#0E0E0E",
  surfaceElevated: "#171717",
  border: "#262626",
  borderStrong: "#3A3A3A",
  textPrimary: "#FFFFFF",
  textMuted: "#A3A3A3",
  textDim: "#6B6B6B",

  // Scan result semantic colors
  flashGreen: "#3CB34A",
  flashRed: "#E53935",
  flashYellow: "#FBC02D",
  flashAmber: "#FF8F00",
  flashOrange: "#F4511E",
};

const palette = {
  text: sgs.textPrimary,
  tint: sgs.green,

  background: sgs.black,
  foreground: sgs.textPrimary,

  card: sgs.surface,
  cardForeground: sgs.textPrimary,

  primary: sgs.green,
  primaryForeground: sgs.black,

  secondary: sgs.surfaceElevated,
  secondaryForeground: sgs.textPrimary,

  muted: sgs.surface,
  mutedForeground: sgs.textMuted,

  accent: sgs.green,
  accentForeground: sgs.black,

  destructive: sgs.flashRed,
  destructiveForeground: sgs.textPrimary,

  border: sgs.border,
  input: sgs.border,
};

const colors = {
  light: palette,
  dark: palette,
  sgs,
  radius: 10,
};

export default colors;
