import React from "react";
import Svg, { Circle, Path } from "react-native-svg";

import colors from "@/constants/colors";

/**
 * SGS sunburst mark. Stylised geometric starburst — radiating rays around a
 * central core. Used in headers, splash, and login.
 */
export function SGSLogo({
  size = 56,
  color = colors.sgs.green,
}: {
  size?: number;
  color?: string;
}) {
  const cx = 50;
  const cy = 50;
  const innerR = 12;
  const outerR = 46;
  const rays = 12;
  const half = (Math.PI / rays) * 0.45;

  const paths = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 - Math.PI / 2;
    const a1 = a - half;
    const a2 = a + half;
    const x1 = cx + Math.cos(a1) * innerR;
    const y1 = cy + Math.sin(a1) * innerR;
    const x2 = cx + Math.cos(a) * outerR;
    const y2 = cy + Math.sin(a) * outerR;
    const x3 = cx + Math.cos(a2) * innerR;
    const y3 = cy + Math.sin(a2) * innerR;
    paths.push(`M${x1},${y1} L${x2},${y2} L${x3},${y3} Z`);
  }

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {paths.map((d, i) => (
        <Path key={i} d={d} fill={color} />
      ))}
      <Circle cx={cx} cy={cy} r={innerR - 2} fill={color} />
    </Svg>
  );
}
