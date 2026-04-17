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

  // SGS Hajj bag tags use a fixed prefix-and-length contract (typically
  // "SGS" + 10-13 alphanumeric chars). Anything else came from a foreign
  // barcode (airline tag, food packaging, etc.) and is out-of-scope.
  if (!isSgsHajjTag(tagNumber)) {
    return {
      flash: "orange",
      title: "OUT OF SCOPE",
      subtitle: tagNumber,
      hapticKey: "warning",
    };
  }

  if (scannedTags.has(tagNumber)) {
    return {
      flash: "amber",
      title: "Already Scanned",
      subtitle: tagNumber,
      hapticKey: "duplicate",
    };
  }

  const bag = manifest.find((b) => b.tagNumber === tagNumber);
  if (!bag) {
    return {
      flash: "red",
      title: "NOT IN MANIFEST",
      subtitle: tagNumber,
      hapticKey: "error",
    };
  }

  if (bag.groupId !== groupId) {
    return {
      flash: "red",
      title: "Wrong Group",
      subtitle: `${bag.pilgrimName} • ${bag.groupId}`,
      hapticKey: "error",
      bag,
    };
  }

  return {
    flash: "green",
    title: "COLLECTED",
    subtitle: bag.pilgrimName,
    hapticKey: "success",
    bag,
  };
}

/**
 * Strips DataWedge / GS1 control characters and validates the SGS Hajj
 * bag-tag prefix and length contract. Use this on every scan source
 * (Zebra trigger or camera) before passing to decideScan.
 */
export function normalizeTag(raw: string): string {
  // Strip ASCII control chars (GS=0x1D, RS=0x1E, EOT=0x04, NUL, etc.) and
  // any AIM identifier prefix DataWedge prepends ("]C1", "]d2", ...).
  let v = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
  v = v.replace(/^\]\w{2}/, "");
  return v;
}

export function isSgsHajjTag(tag: string): boolean {
  if (!tag) return false;
  // The SGS backend issues several tag formats today:
  //   - "SGS-JED-260512-006"      (regular bag tag, hyphenated)
  //   - "SGSJED260512006"         (legacy unhyphenated)
  //   - "NOTAG-JED-006"           (no-tag-bag generated tag)
  //   - "SGS-CARGO-JED-260512-001" (cargo variant)
  // Rather than enforce every shape on the client (and reject legitimate
  // tags the server happily accepts), we use a permissive shape check —
  // alphanumeric + hyphen, length 5-30 — and let the server be the
  // authoritative validator. Anything outside this window is almost
  // certainly a barcode from a different domain (boarding pass, ID, etc.)
  // and shouldn't reach the scan pipeline.
  return /^[A-Z0-9-]{5,30}$/i.test(tag);
}
