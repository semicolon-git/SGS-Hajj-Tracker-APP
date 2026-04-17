/**
 * Pure API client for the SGS Hajj Luggage platform.
 *
 * The backend lives at sgshajj.semicolon.sa. Endpoints and payload shapes were
 * validated against the live web client bundle so this module mirrors the same
 * contract used by the official ops console.
 *
 * Auth model:
 *   - POST /api/auth/login returns a JWT in the JSON body and ALSO sets an
 *     HTTP-only refresh cookie ("credentials: include" is required).
 *   - POST /api/auth/refresh consumes that cookie (no body) and returns a new
 *     JWT. There is no client-held refresh token.
 *   - All authed requests send `Authorization: Bearer <token>`.
 */

import Constants from "expo-constants";

const DEFAULT_BASE = "https://sgshajj.semicolon.sa";

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

async function request<T>(path: string, init: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) || {}),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${SGS_BASE_URL}${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      (body as { message?: string })?.message ||
      `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

// ---------- Public types (stable, screen-facing) ----------

export interface User {
  id: string;
  name: string;
  role: string;
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
    // Server doesn't expose a per-group scanned counter on the list endpoint;
    // scan progress is computed from the manifest once the group is opened.
    scannedBags: g.scannedBags ?? g.scannedBagCount ?? 0,
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
  };
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
      },
    };
  },

  // The server uses an HTTP-only refresh cookie. No body; cookie is sent
  // automatically because we always pass credentials: "include".
  refresh: async (): Promise<LoginResponse | null> => {
    try {
      const body = await request<ServerLoginBody>("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!body.token) return null;
      const u = body.user ?? {};
      return {
        token: body.token,
        user: {
          id: String(u.id ?? ""),
          name: u.fullName ?? u.name ?? u.username ?? "",
          role: u.role ?? "agent",
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
    const list = await request<Array<{ flightId: string | number }>>(
      "/api/flights/assignments-all",
    );
    return { flightIds: list.map((a) => String(a.flightId)) };
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
          flightGroupId: scan.groupId,
          flightId: scan.flightId,
          locationName: scan.source,
          correlationId: uuidv4(),
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
        stationCode: input.stationCode,
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
