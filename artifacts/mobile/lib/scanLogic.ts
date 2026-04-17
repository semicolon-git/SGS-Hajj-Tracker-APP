/**
 * Offline-first scan decision tree.
 *
 * When online, the server is the source of truth. When offline, this module
 * uses the cached manifest + locally-scanned set to flash the agent the right
 * color immediately. The actual scan still goes to the queue for replay.
 */

import type { ManifestBag } from "@/lib/api/sgs";
import type { FlashColor } from "@/constants/branding";

export interface ScanDecision {
  flash: FlashColor;
  title: string;
  subtitle?: string;
  hapticKey: "success" | "error" | "duplicate" | "warning";
  bag?: ManifestBag;
}

export function decideScan(args: {
  tagNumber: string;
  groupId: string;
  manifest: ManifestBag[];
  scannedTags: Set<string>;
}): ScanDecision {
  const { tagNumber, groupId, manifest, scannedTags } = args;

  if (scannedTags.has(tagNumber)) {
    return {
      flash: "yellow",
      title: "Already Scanned",
      subtitle: tagNumber,
      hapticKey: "duplicate",
    };
  }

  const bag = manifest.find((b) => b.tagNumber === tagNumber);
  if (!bag) {
    return {
      flash: "orange",
      title: "Unknown Tag",
      subtitle: tagNumber,
      hapticKey: "warning",
    };
  }

  if (bag.groupId !== groupId) {
    return {
      flash: "amber",
      title: "Wrong Group",
      subtitle: `${bag.pilgrimName} • ${bag.groupId}`,
      hapticKey: "warning",
      bag,
    };
  }

  return {
    flash: "green",
    title: "Match",
    subtitle: bag.pilgrimName,
    hapticKey: "success",
    bag,
  };
}
