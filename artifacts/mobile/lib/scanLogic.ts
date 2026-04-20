/**
 * Offline-first scan decision tree.
 *
 * When online, the server is the source of truth. When offline, this module
 * uses the cached manifest + locally-scanned set to flash the agent the right
 * color immediately. The actual scan still goes to the queue for replay.
 */

import type { HajjCheckResult, ManifestBag } from "@/lib/api/sgs";
import type { FlashColor } from "@/constants/branding";
import type { HapticKey } from "@/hooks/useFlashFeedback";

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

  // Permissive shape check — anything alphanumeric of plausible bag-tag
  // length is forwarded to the server, which is the source of truth.
  // Things like food-packaging EANs or random short strings still get
  // an "OUT OF SCOPE" warning so the agent gets immediate feedback that
  // the camera saw *something* but it wasn't usable.
  if (!isAcceptedScanTag(tagNumber)) {
    return {
      flash: "orange",
      title: "OUT OF SCOPE",
      subtitle: tagNumber,
      hapticKey: "warning",
    };
  }

  // Look up by either the SGS-printed tag or the airline IATA license
  // plate — agents may scan whichever is physically on the bag, and the
  // manifest stores both. Match the SGS tag first since it's the
  // canonical key for the offline scanned-set / queue / dead-letter.
  const bag = manifest.find(
    (b) => b.tagNumber === tagNumber || (b.iataTag && b.iataTag === tagNumber),
  );

  // Duplicate check considers both the raw scanned value and, if we
  // resolved a bag, that bag's *other* identifier — otherwise an agent
  // who scanned the SGS tag and then the airline tag for the same bag
  // would get a misleading green/COLLECTED on the second scan.
  const otherTag = bag
    ? bag.tagNumber === tagNumber
      ? bag.iataTag
      : bag.tagNumber
    : undefined;
  if (
    scannedTags.has(tagNumber) ||
    (otherTag && scannedTags.has(otherTag))
  ) {
    return {
      flash: "amber",
      title: "Already Scanned",
      subtitle: tagNumber,
      hapticKey: "duplicate",
      bag,
    };
  }

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
 * Strips DataWedge / GS1 control characters and surrounding whitespace from
 * a raw scan payload. Use this on every scan source (Zebra trigger or
 * camera) before passing to decideScan.
 *
 * When the raw payload is an IATA BTP PDF417 record (multi-field string
 * containing spaces / slashes), parseBtpPdf417 extracts the canonical
 * bag tag number so the rest of the pipeline never sees the raw blob.
 */
export function normalizeTag(raw: string): string {
  // Strip ASCII control chars (GS=0x1D, RS=0x1E, EOT=0x04, NUL, etc.) and
  // any AIM identifier prefix DataWedge prepends ("]C1", "]d2", ...).
  let v = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
  v = v.replace(/^\]\w{2}/, "");
  // If this looks like a BTP PDF417 payload, extract just the tag number
  // before collapsing whitespace — detection relies on spaces/slashes
  // still being present.
  const btp = parseBtpPdf417(v);
  if (btp) return btp.tagNumber;
  // Collapse all whitespace inside the payload so "0065 SV 456953" and
  // "0065SV456953" both arrive at decideScan as one canonical string.
  v = v.replace(/\s+/g, "");
  return v;
}

/**
 * Fields decoded from an IATA BTP (Baggage Tag Protocol) PDF417 barcode.
 * The PDF417 on an airline bag tag encodes a structured record containing
 * the tag number, flight, station, passenger name, PNR and bag sequence
 * as a single space/slash-delimited string.
 */
export interface BtpFields {
  /** Canonical bag tag number extracted from the payload (e.g. "BG191399") */
  tagNumber: string;
  /** IATA 3-letter destination/station code (e.g. "JED") */
  station?: string;
  /** Carrier + flight number (e.g. "EC135") */
  flight?: string;
  /** Passenger name in IATA SURNAME/GIVEN format (e.g. "NATION/MOHAMMED") */
  pilgrimName?: string;
  /** Booking reference / PNR (e.g. "ACLXVY") */
  pnr?: string;
  /** Sequential bag number on the booking (e.g. 426) */
  bagSequence?: number;
}

/**
 * Parses an IATA BTP PDF417 payload into its constituent fields.
 *
 * A PDF417 on an airline bag tag encodes a structured record rather than
 * just a bare tag number — the Code 128 linear barcode carries the bare
 * number. This function extracts the canonical tagNumber plus all
 * supplementary fields so they can be shown to the agent and the
 * correct key forwarded to the scan pipeline.
 *
 * Returns null when the payload does not look like a BTP record (e.g.
 * it is already a bare tag number from a Code 128 scan).
 */
export function parseBtpPdf417(raw: string): BtpFields | null {
  // BTP payloads always contain spaces or slashes. A bare Code 128 tag
  // number never does — use that as the primary gate.
  if (!raw.includes(" ") && !raw.includes("/")) return null;

  // --- Tag number (primary key) ---
  // SGS-printed formats: BG191399, SGS-JED-260512-006, NOTAG-JED-042
  const sgsTagMatch = raw.match(/\b((?:BG|SGS|NOTAG)[A-Z0-9-]{3,25})\b/i);
  // IATA 10-13 digit license plate (carrier account code + serial number)
  const iataLpMatch = raw.match(/\b([0-9]{10,13})\b/);
  const tagNumber = sgsTagMatch?.[1] ?? iataLpMatch?.[1];
  if (!tagNumber) return null;

  // --- Passenger name (SURNAME/GIVEN format, e.g. NATION/MOHAMMED) ---
  const nameMatch = raw.match(/\b([A-Z]{2,}\/[A-Z]{2,})\b/i);
  const pilgrimName = nameMatch?.[1];

  // --- Carrier + flight number (e.g. "EC 135" → "EC135") ---
  const flightMatch = raw.match(/\b([A-Z]{2})\s*([0-9]{1,4})\b/);
  const flight = flightMatch ? `${flightMatch[1]}${flightMatch[2]}` : undefined;

  // --- IATA 3-letter station code (exactly 3 uppercase letters) ---
  // Pick the first 3-letter token that isn't the 2-letter carrier code.
  const carrierCode = flightMatch?.[1];
  const stationCandidates = Array.from(raw.matchAll(/\b([A-Z]{3})\b/g)).map(m => m[1]);
  const station = stationCandidates.find(s => s !== carrierCode);

  // --- PNR / booking reference (6 uppercase alphanumeric chars) ---
  const pnrCandidates = Array.from(raw.matchAll(/\b([A-Z][A-Z0-9]{5})\b/g))
    .map(m => m[1])
    .filter(p => !tagNumber.startsWith(p) && p !== carrierCode);
  const pnr = pnrCandidates[0];

  // --- Sequential bag number (after BN: or BN followed by digits) ---
  const bnMatch = raw.match(/\bBN[:\s]*([0-9]{1,4})\b/i);
  const bagSequence = bnMatch ? parseInt(bnMatch[1], 10) : undefined;

  return { tagNumber, station, flight, pilgrimName, pnr, bagSequence };
}

/**
 * SGS-issued Hajj bag-tag shape used by `bulk-receive` to gate the manual
 * paste flow. Kept narrow on purpose — paste is a typing surface, so we
 * want to reject obviously-wrong input (a phone number, a name, etc.)
 * before it ever reaches the queue.
 *
 * The SGS backend issues several SGS-printed tag formats today:
 *   - "SGS-JED-260512-006"      (regular bag tag, hyphenated)
 *   - "SGSJED260512006"         (legacy unhyphenated)
 *   - "NOTAG-JED-006"           (no-tag-bag generated tag)
 *   - "SGS-CARGO-JED-260512-001" (cargo variant)
 *
 * For the live scanner, prefer `isAcceptedScanTag` — it also accepts
 * IATA airline license plates (Resolution 740) so the camera doesn't
 * silently drop a tag the server might still resolve.
 */
export function isSgsHajjTag(tag: string): boolean {
  if (!tag) return false;
  return /^[A-Z0-9-]{5,30}$/i.test(tag);
}

/**
 * IATA Resolution 740 bag-tag license plate: 10 numeric digits
 * (3-digit airline accounting code + 6-digit serial + 1 leading digit).
 * Some printers add a check digit, so 11 is also common. We accept
 * 10-13 digits to cover variants without false-accepting random
 * numeric strings (phone numbers, EANs).
 */
export function isIataBagTag(tag: string): boolean {
  if (!tag) return false;
  return /^[0-9]{10,13}$/.test(tag);
}

/**
 * Live scanner gate: accepts the union of SGS-printed tags and IATA
 * airline license plates. Anything else (food packaging EANs, QR codes,
 * boarding-pass PDF417 payloads, etc.) is "OUT OF SCOPE".
 *
 * The server stays authoritative — this only filters out things that
 * are clearly not a bag tag so the agent gets useful feedback instead
 * of silent acceptance.
 */
export function isAcceptedScanTag(tag: string): boolean {
  return isSgsHajjTag(tag) || isIataBagTag(tag);
}

/**
 * Rapid-Scan classification. Folds a HajjCheckResult into the same
 * `{flash,title,subtitle,hint,hapticKey}` shape `decideScan` produces so
 * the screen can hand it straight to `useFlashFeedback`. The translator
 * is passed in so the strings stay localized; pass `t` from `useLocale`.
 */
export interface RapidScanDecision {
  flash: FlashColor;
  title: string;
  subtitle?: string;
  hint?: string;
  hapticKey: HapticKey;
}

export function classifyHajjCheck(
  result: HajjCheckResult,
  t: (key: string) => string,
): RapidScanDecision {
  if (result.status === "green") {
    return {
      flash: "green",
      title: result.accommodationName ?? t("rapidGreen"),
      subtitle: result.pilgrimName,
      hint: result.accommodationAddress,
      hapticKey: "success",
    };
  }
  if (result.status === "amber") {
    // Use the `yellow` flash variant — `FlashOverlay` renders `amber`
    // as a border-only frame (used by the regular scan screen for
    // "wrong group" warnings) but Rapid Scan needs a true full-screen
    // fill so the supervisor can read the result without looking at
    // the device.
    return {
      flash: "yellow",
      title: t("rapidAmberTitle"),
      subtitle: result.pilgrimName ?? result.bagTag,
      hapticKey: "warning",
    };
  }
  // Red: explain what we know. Localized strings always win — fall
  // back to a server-supplied `message` only when we don't have a
  // dedicated translation key, so Arabic mode never leaks an English
  // fallback for the common unknown-tag case.
  let title = t("rapidRedUnknown");
  if (result.reason === "non_hajj") title = t("rapidRedNonHajj");
  else if (result.reason === "no_nusuk") title = t("rapidRedNoNusuk");
  else if (result.reason === "unknown_tag") title = t("rapidRedUnknown");
  else if (result.message) title = result.message;
  return {
    flash: "red",
    title,
    subtitle: result.bagTag,
    hapticKey: "error",
  };
}
