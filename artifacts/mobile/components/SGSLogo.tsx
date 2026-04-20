import React from "react";
import { Image } from "react-native";

const LOGO_SOURCE = require("../assets/images/sgs-logo.png");
const LOGO_ASPECT = 1754 / 397;

/**
 * Official SGS mark — green gear + white "SGS" wordmark. Rendered from
 * the bundled PNG so it always matches brand guidelines.
 *
 * `size` controls the rendered HEIGHT in dp; the width is derived from
 * the artwork's intrinsic aspect ratio so the mark never looks
 * stretched. Pass a fixed `width` to override.
 */
export function SGSLogo({
  size = 56,
  width,
}: {
  size?: number;
  /** Optional override colour (kept for API compatibility — ignored for the official PNG mark). */
  color?: string;
  width?: number;
}) {
  const w = width ?? size * LOGO_ASPECT;
  return (
    <Image
      source={LOGO_SOURCE}
      style={{ width: w, height: size }}
      resizeMode="contain"
      accessibilityLabel="SGS"
    />
  );
}
