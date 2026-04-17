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

const DEFAULT_BASE = "https://sgshajj.semicolon.sa";

export const SGS_BASE_URL =
  process.env.EXPO_PUBLIC_SGS_API_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : DEFAULT_BASE);

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
  pilgrimCount: number;
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
  user?: { id?: string | number; name?: string; username?: string; role?: string };
}

interface ServerFlight {
  id: string;
  flightNumber: string;
  destination?: string;
  arrivalAirport?: string;
  departureAirport?: string;
  departureTime?: string;
  scheduledDeparture?: string;
  assigned?: boolean;
  bagCount?: number;
  totalBags?: number;
}

interface ServerFlightGroup {
  id: string;
  flightId: string;
  groupNumber?: string;
  groupName?: string;
  pilgrimCount?: number;
  expectedBagCount?: number;
  expectedBags?: number;
  scannedBagCount?: number;
  scannedBags?: number;
  assigned?: boolean;
}

interface ServerBag {
  id?: string;
  bagTag: string;
  pilgrimName?: string;
  flightId?: string;
  flightGroupId?: string;
  groupId?: string;
  status?: string;
}

function normalizeFlight(f: ServerFlight): Flight {
  return {
    id: String(f.id),
    flightNumber: f.flightNumber,
    destination: f.destination ?? f.arrivalAirport ?? "",
    departureTime: f.departureTime ?? f.scheduledDeparture ?? "",
    assigned: f.assigned,
    bagCount: f.bagCount ?? f.totalBags ?? 0,
  };
}

function normalizeGroup(g: ServerFlightGroup): BagGroup {
  return {
    id: String(g.id),
    flightId: String(g.flightId),
    groupNumber: g.groupNumber ?? g.groupName ?? String(g.id),
    pilgrimCount: g.pilgrimCount ?? 0,
    expectedBags: g.expectedBags ?? g.expectedBagCount ?? 0,
    scannedBags: g.scannedBags ?? g.scannedBagCount ?? 0,
    assigned: g.assigned,
  };
}

function normalizeBag(b: ServerBag): ManifestBag {
  const raw = (b.status ?? "pending").toLowerCase();
  const status: ManifestBag["status"] =
    raw === "scanned" || raw === "received" || raw === "loaded"
      ? "scanned"
      : raw === "missing"
        ? "missing"
        : raw === "exception" || raw === "damaged"
          ? "exception"
          : "pending";
  return {
    tagNumber: b.bagTag,
    pilgrimName: b.pilgrimName ?? "",
    groupId: String(b.flightGroupId ?? b.groupId ?? ""),
    flightId: String(b.flightId ?? ""),
    status,
  };
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
        name: u.name ?? u.username ?? username,
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
          name: u.name ?? u.username ?? "",
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
      const res = await request<{
        ok?: boolean;
        result?: ScanResponse["result"];
        message?: string;
        bag?: ServerBag;
      }>(`/api/bags/${encodeURIComponent(scan.tagNumber)}/events`, {
        method: "POST",
        body: JSON.stringify({
          eventType: "SCAN",
          flightGroupId: scan.groupId,
          flightId: scan.flightId,
          locationName: scan.source,
          correlationId: scan.deviceId
            ? `${scan.deviceId}:${scan.scannedAt}`
            : scan.scannedAt,
        }),
      });
      return {
        result: res.result ?? "match",
        bag: res.bag ? normalizeBag(res.bag) : undefined,
        message: res.message,
      };
    } catch (err) {
      // 404 from the events endpoint means the tag isn't on any manifest.
      if (err instanceof ApiError && err.status === 404) {
        return { result: "unknown", message: err.message };
      }
      throw err;
    }
  },

  submitException: async (input: {
    tagNumber: string;
    groupId: string;
    flightId: string;
    reason: string;
    notes?: string;
    photoBase64?: string;
  }): Promise<{ id: string }> => {
    const res = await request<{ id?: string | number; exceptionId?: string }>(
      "/api/exceptions/raise",
      {
        method: "POST",
        body: JSON.stringify({
          bagTag: input.tagNumber,
          exceptionType: input.reason,
          flightId: input.flightId,
          flightGroupId: input.groupId,
          note: input.notes,
        }),
      },
    );
    const id = String(res.id ?? res.exceptionId ?? "");
    if (!id) {
      throw new ApiError("Exception submission missing id", 502, res);
    }
    return { id };
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
