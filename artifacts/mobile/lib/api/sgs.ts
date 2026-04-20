/**
 * Pure API client for the SGS Hajj Luggage platform.
 *
 * The backend lives at api-bagtracker-prod.saudiags.com. Endpoints and payload
 * shapes were validated against the live web client bundle so this module
 * mirrors the same contract used by the official ops console.
 *
 * Auth model:
 *   - POST /api/auth/login returns a JWT in the JSON body and ALSO sets an
 *     HTTP-only refresh cookie ("credentials: include" is required).
 *   - POST /api/auth/refresh consumes that cookie (no body) and returns a new
 *     JWT. There is no client-held refresh token.
 *   - All authed requests send `Authorization: Bearer <token>`.
 */

import Constants from "expo-constants";

const DEFAULT_BASE = "https://api-bagtracker-prod.saudiags.com";

// IMPORTANT: do NOT fall back to EXPO_PUBLIC_DOMAIN here. That env var is set
// by the build script to the Replit hosting domain so Metro can serve the JS
// bundle — it is NOT the API host. Conflating the two routed every authed
// call to a server with no /api/* mounted, producing 404 on login.
//
// Resolution order:
//   1. EXPO_PUBLIC_SGS_API_URL (process.env, inlined at bundle time when
//      provided via eas.json build profile env or shell env at metro start).
//   2. expo.extra.eas.env.EXPO_PUBLIC_SGS_API_URL from app.json (read via
//      expo-constants), which is the value pinned into every published
//      build as a deployment-policy escape hatch.
//   3. Hard-coded production backend.
const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
const easEnv = ((extra.eas as Record<string, unknown> | undefined)?.env ??
  {}) as Record<string, string | undefined>;

export const SGS_BASE_URL =
  process.env.EXPO_PUBLIC_SGS_API_URL ||
  easEnv.EXPO_PUBLIC_SGS_API_URL ||
  (extra.EXPO_PUBLIC_SGS_API_URL as string | undefined) ||
  DEFAULT_BASE;

let authToken: string | null = null;
export function setAuthToken(token: string | null) {
  authToken = token;
}
export function getAuthToken() {
  return authToken;
}

// Fired when a non-auth endpoint returns 401/403 with a bearer token set —
// i.e. the stored JWT is invalid/expired. AuthContext wires this to its
// signOut flow so the agent gets bounced to /login instead of seeing the
// same error on every screen refresh.
let onAuthFailure: (() => void) | null = null;
export function setOnAuthFailure(handler: (() => void) | null) {
  onAuthFailure = handler;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

type RequestOpts = RequestInit & { credentials?: RequestCredentials };

// ---------- Request interceptor / logger ----------

const __DEV__ = process.env.NODE_ENV !== "production";

function logRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
) {
  if (!__DEV__) return;
  const safeHeaders = { ...headers };
  if (safeHeaders["Authorization"]) {
    safeHeaders["Authorization"] = safeHeaders["Authorization"].slice(0, 20) + "…";
  }
  console.log(
    `\n[SGS ▶] ${method} ${url}\n` +
    `  Headers: ${JSON.stringify(safeHeaders, null, 2)}\n` +
    (body ? `  Body:    ${body}` : ""),
  );
}

function logResponse(
  method: string,
  url: string,
  status: number,
  durationMs: number,
  body: unknown,
) {
  if (!__DEV__) return;
  const bodyStr = JSON.stringify(body);
  console.log(
    `\n[SGS ◀] ${status} ${method} ${url} (${durationMs}ms)\n` +
    `  Body: ${bodyStr}`,
  );
}

function logError(
  method: string,
  url: string,
  durationMs: number,
  err: unknown,
) {
  if (!__DEV__) return;
  console.warn(
    `\n[SGS ✗] ${method} ${url} (${durationMs}ms)\n` +
    `  Error: ${err instanceof Error ? err.message : String(err)}`,
  );
}

async function request<T>(path: string, init: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) || {}),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const fullUrl = `${SGS_BASE_URL}${path}`;
  const method = (init.method ?? "GET").toUpperCase();
  const t0 = Date.now();

  logRequest(method, fullUrl, headers, init.body as string | undefined);

  let res: Response;
  try {
    res = await fetch(fullUrl, {
      ...init,
      headers,
    });
  } catch (fetchErr) {
    logError(method, fullUrl, Date.now() - t0, fetchErr);
    throw fetchErr;
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  logResponse(method, fullUrl, res.status, Date.now() - t0, body);

  if (!res.ok) {
    const msg =
      (body as { message?: string })?.message ||
      `Request failed (${res.status})`;
    // Auth endpoints report 401 as part of their normal contract (wrong
    // password, missing refresh cookie). Skip the global handler for those
    // so a failed login doesn't recursively sign the user out.
    const isAuthEndpoint =
      path === "/api/auth/login" ||
      path === "/api/auth/refresh" ||
      path === "/api/auth/logout";
    if (
      (res.status === 401 || res.status === 403) &&
      authToken &&
      !isAuthEndpoint
    ) {
      authToken = null;
      onAuthFailure?.();
    }
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

// Lightweight reachability check. Used by the login screen's "Test
// connection" button to separate "device cannot reach the SGS host"
// (carrier APN whitelist, captive portal, DNS, TLS) from "credentials
// are wrong / account is rate-limited". Bypasses the throwing request()
// wrapper because we want to time the round-trip and report status
// regardless of whether the body parses.
export async function checkReachability(): Promise<{
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${SGS_BASE_URL}/api/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    return { ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    const msg = (e as Error)?.message || "network error";
    return { ok: false, ms: Date.now() - t0, error: msg };
  }
}

// ---------- Public types (stable, screen-facing) ----------

export interface User {
  id: string;
  name: string;
  role: string;
  /**
   * Three-letter IATA station code (e.g. "JED") forwarded to write
   * endpoints like `/api/bags/no-tag` so backend tag generation produces
   * `NOTAG-JED-NNN` rather than defaulting to an unknown station.
   */
  stationCode?: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface Flight {
  id: string;
  flightNumber: string;
  destination: string;
  departureTime: string;
  assigned?: boolean;
  bagCount: number;
}

export interface BagGroup {
  id: string;
  flightId: string;
  groupNumber: string;
  /**
   * Number of pilgrims in the group. Optional because the live SGS
   * `/api/flight-groups` endpoint does not include this field on every
   * deployment; when absent we hide the count in the UI rather than show
   * a misleading "0 pilgrims".
   */
  pilgrimCount?: number;
  expectedBags: number;
  scannedBags: number;
  assigned?: boolean;
}

export interface ManifestBag {
  tagNumber: string;
  pilgrimName: string;
  groupId: string;
  flightId: string;
  status: "pending" | "scanned" | "missing" | "exception";
  /**
   * Optional IATA Resolution 740 license plate (e.g. "0065SV456953")
   * printed on the airline's bag tag. The SGS workflow expects agents
   * to scan whichever tag is physically on the bag — sometimes the
   * SGS-printed tag, sometimes the airline tag. Storing both lets the
   * offline matcher (`decideScan`) flash green when an agent scans the
   * airline tag for a bag that's on the manifest. Absent when the
   * backend hasn't recorded the airline tag for this bag yet.
   */
  iataTag?: string;
}

export interface ScanRequest {
  tagNumber: string;
  groupId: string;
  flightId: string;
  scannedAt: string; // ISO
  source: "zebra" | "camera" | "manual";
  deviceId?: string;
}

export interface ScanResponse {
  result: "match" | "duplicate" | "wrong_group" | "unknown" | "exception";
  bag?: ManifestBag;
  message?: string;
}

// ---------- Server-shape helpers / normalizers ----------

interface ServerLoginBody {
  token?: string;
  user?: {
    id?: string | number;
    name?: string;
    fullName?: string;
    username?: string;
    role?: string;
    stationCode?: string;
    station?: string;
    stationId?: string;
  };
}

// Verified against sgshajj.semicolon.sa on 2026-04-17. The server returns
// `flightNo` and `scheduledTime`; older builds used `flightNumber` /
// `scheduledDeparture`, so we accept either.
interface ServerFlight {
  id: string;
  flightNo?: string;
  flightNumber?: string;
  destination?: string;
  arrivalAirport?: string;
  departureAirport?: string;
  originAirport?: string;
  flightDirection?: "ARRIVAL" | "DEPARTURE" | string;
  scheduledTime?: string;
  departureTime?: string;
  scheduledDeparture?: string;
  flightDate?: string;
  assigned?: boolean;
  bagCount?: number;
  totalBags?: number;
  scannedBags?: number;
}

// Flight groups on the server are keyed by accommodation, not a group number.
// We surface `accommodationName` as the user-visible label since agents speak
// about "the Movenpick group" rather than a numeric id.
interface ServerFlightGroup {
  id: string;
  flightId: string;
  groupNumber?: string;
  groupName?: string;
  accommodationName?: string;
  terminalCode?: string | null;
  pilgrimCount?: number;
  pilgrimsCount?: number;
  paxCount?: number;
  passengerCount?: number;
  expectedBagCount?: number;
  expectedBags?: number;
  actualBagCount?: number;
  scannedBagCount?: number;
  scannedBags?: number;
  assigned?: boolean;
}

// Bag shape verified live: the real status field is `currentStatus` with
// values like MANIFESTED / COLLECTED_FROM_BELT / EXCEPTION / LOADED /
// DELIVERED. An open exception is also flagged via `exceptionWorkflowStatus`.
interface ServerBag {
  id?: string;
  bagTag: string;
  pilgrimName?: string | null;
  flightId?: string;
  flightGroupId?: string;
  groupId?: string;
  status?: string;
  currentStatus?: string;
  exceptionWorkflowStatus?: string | null;
  exceptionType?: string | null;
  noTag?: boolean;
  surrogateTag?: string | null;
  // The SGS backend has used several names for the airline IATA license
  // plate across builds. Accept any of them so the field lights up the
  // moment the server starts emitting it, without needing a coordinated
  // client release.
  iataTag?: string | null;
  iataLicensePlate?: string | null;
  licensePlate?: string | null;
  airlineTag?: string | null;
  airlineBagTag?: string | null;
}

function normalizeFlight(f: ServerFlight): Flight {
  return {
    id: String(f.id),
    flightNumber: f.flightNo ?? f.flightNumber ?? "",
    destination:
      f.destination ?? f.arrivalAirport ?? f.originAirport ?? "",
    departureTime:
      f.scheduledTime ?? f.departureTime ?? f.scheduledDeparture ?? f.flightDate ?? "",
    assigned: f.assigned,
    bagCount: f.bagCount ?? f.totalBags ?? 0,
  };
}

function normalizeGroup(g: ServerFlightGroup): BagGroup {
  // On the live SGS backend the operationally-recognised label for a group
  // is the accommodation name ("Movenpick Hotel Jeddah"), so we prefer it
  // first. groupNumber/groupName are kept as fallbacks for older builds
  // that might expose them, and we finally fall back to terminalCode or a
  // short id slice so the UI never surfaces a raw UUID.
  const label =
    g.accommodationName ??
    g.groupNumber ??
    g.groupName ??
    (g.terminalCode ? `Terminal ${g.terminalCode}` : undefined) ??
    String(g.id).slice(0, 8);
  return {
    id: String(g.id),
    flightId: String(g.flightId),
    groupNumber: label,
    // Live SGS `/api/flight-groups` does not currently surface a pilgrim
    // count, but older / alternate builds expose it under several names.
    // Leave it undefined when truly unavailable so the UI can hide the
    // line instead of showing a misleading "0 pilgrims".
    pilgrimCount:
      g.pilgrimCount ?? g.pilgrimsCount ?? g.paxCount ?? g.passengerCount,
    expectedBags: g.expectedBags ?? g.expectedBagCount ?? 0,
    // Live SGS returns the running loaded-bags total as `actualBagCount`.
    // Older builds used `scannedBagCount` / `scannedBags`, so we accept any
    // of them before falling back to 0 (the local manifest then corrects
    // the number as the agent scans).
    scannedBags:
      g.scannedBags ?? g.scannedBagCount ?? g.actualBagCount ?? 0,
    assigned: g.assigned,
  };
}

function normalizeBag(b: ServerBag): ManifestBag {
  const raw = (b.currentStatus ?? b.status ?? "MANIFESTED").toUpperCase();
  let status: ManifestBag["status"];
  if (raw === "EXCEPTION" || b.exceptionWorkflowStatus === "OPEN") {
    status = "exception";
  } else if (raw === "MANIFESTED" || raw === "PENDING") {
    status = "pending";
  } else if (raw === "MISSING") {
    status = "missing";
  } else {
    // Everything post-belt (COLLECTED_FROM_BELT, RECEIVED, LOADED,
    // IN_TRANSIT, DELIVERED, HANDED_TO_DRIVER, ARRIVED_AT_LOCATION, etc.)
    // counts as scanned from the agent's perspective.
    status = "scanned";
  }
  return {
    tagNumber: b.bagTag,
    pilgrimName: b.pilgrimName ?? "",
    groupId: String(b.flightGroupId ?? b.groupId ?? ""),
    flightId: String(b.flightId ?? ""),
    status,
    iataTag: normalizeIataTag(
      b.iataTag ?? b.iataLicensePlate ?? b.licensePlate ?? b.airlineTag ?? b.airlineBagTag,
    ),
  };
}

/**
 * Strip whitespace and normalize an airline IATA tag to its compact
 * digits-only form ("0065 SV 456953" -> "0065SV456953" before scanning,
 * but the live-printed plate is always digits, so once stripped we
 * expect 10-13 digits). Returns undefined for absent / malformed values
 * so the offline matcher never compares against an empty string and
 * accidentally matches the empty raw scan.
 */
function normalizeIataTag(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  // Uppercase + strip whitespace so a backend that stores "0065sv456953"
  // still matches a scanner payload of "0065SV456953". `normalizeTag`
  // (used on every raw scan) doesn't change case, so we anchor on
  // upper-case here for a single canonical form.
  const v = String(raw).replace(/\s+/g, "").trim().toUpperCase();
  if (!v) return undefined;
  // Be permissive on shape — keep whatever the server stored (it might
  // include a check digit or alphabetic airline code suffix on legacy
  // builds). The decideScan match is exact, so noise here just means
  // no match, never a false positive.
  return v;
}

function normalizeStationCode(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = String(raw).trim().toUpperCase();
  // IATA airport codes are exactly three uppercase letters. Anything else
  // (empty, numeric ids, "unknown", etc.) is omitted so the backend can
  // resolve from the JWT instead of failing validation on a bad string.
  return /^[A-Z]{3}$/.test(v) ? v : undefined;
}

// RFC 4122 v4 UUID, good enough for correlation IDs. The backend validates
// scan events with a strict uuid schema so we cannot reuse our local
// "deviceId:timestamp" style here.
function uuidv4(): string {
  // 8-4-4-4-12 hex pattern
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
    } else if (i === 14) {
      out += "4";
    } else if (i === 19) {
      out += hex[(Math.random() * 4) | 0 | 8];
    } else {
      out += hex[(Math.random() * 16) | 0];
    }
  }
  return out;
}

// ---------- Endpoints ----------

// ---------- Rapid-Scan / Hajj-check shapes ----------
//
// The live `/api/bags/hajj-check` endpoint returns a discriminator plus a
// scattering of optional fields. Different builds have shipped slightly
// different shapes (matched/hasAccommodation flags vs explicit status), so
// the wire type is intentionally permissive and `normalizeHajjCheck` does
// the folding.
export type RawHajjCheck = {
  status?: string;
  result?: string;
  matched?: boolean;
  hasAccommodation?: boolean;
  bagTag?: string;
  tag?: string;
  pilgrimName?: string;
  passengerName?: string;
  accommodationName?: string;
  hotelName?: string;
  accommodationAddress?: string;
  hotelAddress?: string;
  reason?: string;
  message?: string;
};

export type HajjCheckResult = {
  status: "green" | "amber" | "red";
  bagTag: string;
  pilgrimName?: string;
  accommodationName?: string;
  accommodationAddress?: string;
  /** Machine-readable reason on red (e.g. "unknown_tag", "non_hajj"). */
  reason?: string;
  /** Server-provided human message (used as fallback for the flash). */
  message?: string;
};

function normalizeHajjCheck(
  scannedTag: string,
  raw: RawHajjCheck,
): HajjCheckResult {
  const bagTag = String(raw.bagTag ?? raw.tag ?? scannedTag);
  const pilgrimName = raw.pilgrimName ?? raw.passengerName;
  const accommodationName = raw.accommodationName ?? raw.hotelName;
  const accommodationAddress =
    raw.accommodationAddress ?? raw.hotelAddress;
  const reason = raw.reason ?? raw.message;
  const explicit = (raw.status ?? raw.result ?? "").toLowerCase();
  let status: HajjCheckResult["status"];
  if (explicit === "green" || explicit === "amber" || explicit === "red") {
    status = explicit as HajjCheckResult["status"];
  } else if (raw.matched === false) {
    status = "red";
  } else if (raw.hasAccommodation === false || !accommodationName) {
    status = raw.matched === true || pilgrimName ? "amber" : "red";
  } else {
    status = "green";
  }
  return {
    status,
    bagTag,
    pilgrimName,
    accommodationName,
    accommodationAddress,
    reason,
    message: raw.message,
  };
}

export const sgsApi = {
  login: async (username: string, password: string): Promise<LoginResponse> => {
    const body = await request<ServerLoginBody>("/api/auth/login", {
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ username, password }),
    });
    if (!body.token) {
      throw new ApiError("Login response missing token", 502, body);
    }
    const u = body.user ?? {};
    return {
      token: body.token,
      user: {
        id: String(u.id ?? username),
        name: u.fullName ?? u.name ?? u.username ?? username,
        role: u.role ?? "agent",
        stationCode: u.stationCode ?? u.station ?? u.stationId,
      },
    };
  },

  // The server uses an HTTP-only refresh cookie. No body; cookie is sent
  // automatically because we always pass credentials: "include".
  refresh: async (): Promise<LoginResponse | null> => {
    try {
      const body = await request<ServerLoginBody>("/api/auth/refresh", {
        method: "POST",
      });
      if (!body.token) return null;
      const u = body.user ?? {};
      return {
        token: body.token,
        user: {
          id: String(u.id ?? ""),
          name: u.fullName ?? u.name ?? u.username ?? "",
          role: u.role ?? "agent",
          stationCode: u.stationCode ?? u.station ?? u.stationId,
        },
      };
    } catch {
      return null;
    }
  },

  me: () => request<User>("/api/auth/me"),

  flights: async (): Promise<Flight[]> => {
    const list = await request<ServerFlight[]>("/api/flights");
    return list.map(normalizeFlight);
  },

  flightAssignments: async (): Promise<{ flightIds: string[] }> => {
    // The live `/api/flights/assignments-all` returns a map keyed by
    // flightId — typically `Record<flightId, agents[]>` for duty-manager /
    // supervisor roles. Older builds returned an array of `{ flightId }`
    // objects. Accept both shapes so the assigned-flight badges render
    // correctly across roles.
    const raw = await request<
      | Array<{ flightId: string | number }>
      | Record<string, unknown>
    >("/api/flights/assignments-all");
    if (Array.isArray(raw)) {
      return { flightIds: raw.map((a) => String(a.flightId)) };
    }
    if (raw && typeof raw === "object") {
      return { flightIds: Object.keys(raw).map(String) };
    }
    return { flightIds: [] };
  },

  groups: async (flightId: string): Promise<BagGroup[]> => {
    const list = await request<ServerFlightGroup[]>(
      `/api/flight-groups?flightId=${encodeURIComponent(flightId)}`,
    );
    return list.map(normalizeGroup);
  },

  manifest: async (groupId: string): Promise<ManifestBag[]> => {
    const list = await request<ServerBag[]>(
      `/api/bags?groupId=${encodeURIComponent(groupId)}`,
    );
    return list.map(normalizeBag);
  },

  // Scans are recorded as bag events, matching the SGS web client. The
  // backend infers match/duplicate/wrong_group server-side from the bag's
  // current state; we surface its decision to callers.
  submitScan: async (scan: ScanRequest): Promise<ScanResponse> => {
    try {
      // The server returns { event, bag } on success (201) and enforces:
      //   - eventType must be a concrete enum value (belt agents send
      //     COLLECTED_FROM_BELT)
      //   - correlationId must be a UUID
      // Duplicate / wrong-group / missing-permission conditions are surfaced
      // as 403/404 which we translate into ScanResponse results below.
      const res = await request<{
        event?: { id?: string };
        bag?: ServerBag;
      }>(`/api/bags/${encodeURIComponent(scan.tagNumber)}/events`, {
        method: "POST",
        body: JSON.stringify({
          eventType: "COLLECTED_FROM_BELT",
          // Rapid Scan submits collected events without a pinned flight
          // (the supervisor scans across multiple flights at the belt).
          // Send `null` rather than an empty string so the server can
          // derive the manifest from the bag tag itself instead of
          // failing zod validation on an empty UUID.
          flightGroupId: scan.groupId || null,
          flightId: scan.flightId || null,
          locationName: scan.source,
          correlationId: uuidv4(),
          // Stable per-install id so the backend can reliably dedupe
          // cross-device duplicate scans (two agents scanning the same
          // bag, or the same device reinstalled). Optional on the wire.
          deviceId: scan.deviceId,
        }),
      });
      const normalized = res.bag ? normalizeBag(res.bag) : undefined;
      // If the server echoes a bag that belongs to a different group, flag it
      // as wrong_group so the UI can warn the agent.
      if (normalized && normalized.groupId && normalized.groupId !== scan.groupId) {
        return { result: "wrong_group", bag: normalized };
      }
      return { result: "match", bag: normalized };
    } catch (err) {
      if (err instanceof ApiError) {
        // 404 from the events endpoint means the tag isn't on any manifest.
        if (err.status === 404) {
          return { result: "unknown", message: err.message };
        }
        // 409 (conflict) is the only status we treat as a benign duplicate.
        // Everything else — including 403 authorization/state errors — must
        // rethrow so the queue sync retries and, if necessary, moves the
        // scan to the dead-letter store rather than silently dropping it.
        if (err.status === 409) {
          return { result: "duplicate", message: err.message };
        }
        // Some backends return 400 with a duplicate-state message. Detect
        // that narrowly via the error message text instead of a blanket
        // status-code mapping so real validation errors still bubble up.
        if (err.status === 400 && /duplicate|already\s+(scanned|collected)/i.test(err.message)) {
          return { result: "duplicate", message: err.message };
        }
      }
      throw err;
    }
  },

  submitException: async (input: {
    tagNumber: string;
    groupId: string;
    flightId: string;
    reason: string;
    /** Stage the exception was raised at. Defaults to "BELT" for belt agents. */
    stage?: "BELT" | "LOADING" | "TRANSIT" | "DELIVERY";
    notes?: string;
    photoBase64?: string;
  }): Promise<{ id: string }> => {
    // The server requires `exceptionStage` (zod-validated) and returns the
    // full bag record on success — the bag's `id` is the canonical handle.
    const res = await request<{
      id?: string | number;
      exceptionId?: string;
      bagTag?: string;
    }>(
      "/api/exceptions/raise",
      {
        method: "POST",
        body: JSON.stringify({
          bagTag: input.tagNumber,
          exceptionType: input.reason,
          exceptionStage: input.stage ?? "BELT",
          flightId: input.flightId,
          flightGroupId: input.groupId,
          note: input.notes,
        }),
      },
    );
    const id = String(res.id ?? res.exceptionId ?? res.bagTag ?? "");
    if (!id) {
      throw new ApiError("Exception submission missing id", 502, res);
    }
    return { id };
  },

  /**
   * Submits a shift summary snapshot for supervisor audit.
   *
   * The endpoint is best-effort: the live SGS backend may not yet expose
   * `/api/shift-reports`, so callers should treat a 404 as "audit unavailable"
   * rather than a hard failure — the agent has still produced and shared the
   * report locally.
   *
   * Returns `{ recorded: true }` on success, `{ recorded: false, reason }` if
   * the server has not been upgraded with the audit route yet.
   */
  submitShiftReport: async (input: {
    reportId: string;
    flightId: string;
    flightGroupId: string;
    startedAt: string;
    endedAt: string;
    totals: {
      expected: number;
      scanned: number;
      remaining: number;
      exceptions: number;
      matchPct: number;
    };
    exceptionTags: string[];
    queue: { pending: number; failed: number; online: boolean };
    summaryText: string;
    summaryHtml: string;
    deliveryChannel: "share" | "email" | "manual";
  }): Promise<{ recorded: boolean; reason?: string; id?: string }> => {
    try {
      const res = await request<{ id?: string | number }>(
        "/api/shift-reports",
        {
          method: "POST",
          body: JSON.stringify({
            reportId: input.reportId,
            flightId: input.flightId,
            flightGroupId: input.flightGroupId,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            totals: input.totals,
            exceptionTags: input.exceptionTags,
            queue: input.queue,
            summaryText: input.summaryText,
            summaryHtml: input.summaryHtml,
            deliveryChannel: input.deliveryChannel,
          }),
        },
      );
      return { recorded: true, id: res.id ? String(res.id) : undefined };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
        // The backend doesn't expose the audit route on this deployment.
        // The agent has already received/shared the snapshot, so we degrade
        // gracefully instead of surfacing a scary error.
        return { recorded: false, reason: "audit_endpoint_unavailable" };
      }
      throw err;
    }
  },

  /**
   * Hajj-check lookup powering the Rapid Scan screen. Maps the live
   * `/api/bags/hajj-check?tag=…` response onto a small client-friendly
   * shape with three explicit statuses:
   *   - "green"  → bag is on a Hajj manifest AND has accommodation assigned
   *   - "amber"  → bag is on a Hajj manifest but no accommodation yet
   *   - "red"    → tag isn't a Hajj bag, isn't recognized, or has no
   *                Nusuk match
   *
   * Field mapping is defensive: the live backend has been observed to
   * return either `{ status }` directly or a richer object with
   * `{ matched, hasAccommodation }` — we accept both. Callers only need
   * to branch on `status`.
   */
  hajjCheck: async (tagNumber: string): Promise<HajjCheckResult> => {
    try {
      const raw = await request<RawHajjCheck>(
        `/api/bags/hajj-check?tag=${encodeURIComponent(tagNumber)}`,
      );
      return normalizeHajjCheck(tagNumber, raw);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return {
          status: "red",
          bagTag: tagNumber,
          reason: "unknown_tag",
          message: "Unknown tag",
        };
      }
      throw err;
    }
  },

  /**
   * Log a red-flash scan (unknown tag / non-Hajj / no Nusuk match) for
   * supervisor audit. Mirrors the web Rapid Scan flow which writes to
   * `red_scan_events`. Treated as best-effort: a 404/405 from the
   * backend (route not deployed) degrades to `{ recorded: false }`
   * rather than spamming the agent with errors — the screen has
   * already shown the red flash to the operator.
   */
  logRedScan: async (input: {
    tagNumber: string;
    reason: string;
    flightId?: string;
  }): Promise<{ recorded: boolean; reason?: string }> => {
    try {
      await request("/api/red-scans", {
        method: "POST",
        body: JSON.stringify({
          bagTag: input.tagNumber,
          reason: input.reason,
          flightId: input.flightId,
        }),
      });
      return { recorded: true };
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 404 || err.status === 405)
      ) {
        return { recorded: false, reason: "endpoint_unavailable" };
      }
      throw err;
    }
  },

  registerNoTag: async (input: {
    pilgrimName: string;
    groupId: string;
    flightId: string;
    description: string;
    photoBase64?: string;
    stationCode?: string;
  }): Promise<{ id: string; tagNumber: string }> => {
    const res = await request<{
      id?: string | number;
      bagTag?: string;
      tag?: string;
    }>("/api/bags/no-tag", {
      method: "POST",
      body: JSON.stringify({
        // Sanitize: backend expects an uppercase 3-letter IATA code.
        // Trim/uppercase if it looks valid; otherwise omit so the server
        // can fall back to its own default rather than reject on a bad
        // value.
        stationCode: normalizeStationCode(input.stationCode),
        flightId: input.flightId,
        flightGroupId: input.groupId,
        pilgrimName: input.pilgrimName,
        description: input.description,
      }),
    });
    const tagNumber = String(res.bagTag ?? res.tag ?? "");
    if (!tagNumber) {
      throw new ApiError("No-tag submission missing generated tag", 502, res);
    }
    return { id: String(res.id ?? ""), tagNumber };
  },
};
