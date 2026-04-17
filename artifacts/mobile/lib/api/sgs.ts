/**
 * Pure API client for the SGS Hajj Luggage platform.
 *
 * The backend lives at sgshajj.semicolon.sa (configurable via EXPO_PUBLIC_DOMAIN
 * for local proxy development). All business logic stays server-side; this app
 * only consumes endpoints.
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

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) || {}),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${SGS_BASE_URL}${path}`, { ...init, headers });
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

// ---------- Types ----------

export interface LoginResponse {
  token: string;
  refreshToken?: string;
  user: { id: string; name: string; role: string };
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

// ---------- Endpoints ----------

export const sgsApi = {
  login: (username: string, password: string) =>
    request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  refresh: (refreshToken: string) =>
    request<LoginResponse>("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    }),

  flights: () => request<Flight[]>("/api/agent/flights"),

  groups: (flightId: string) =>
    request<BagGroup[]>(`/api/agent/flights/${flightId}/groups`),

  manifest: (groupId: string) =>
    request<ManifestBag[]>(`/api/agent/groups/${groupId}/manifest`),

  submitScan: (scan: ScanRequest) =>
    request<ScanResponse>("/api/agent/scans", {
      method: "POST",
      body: JSON.stringify(scan),
    }),

  submitException: (input: {
    tagNumber: string;
    groupId: string;
    flightId: string;
    reason: string;
    notes?: string;
    photoBase64?: string;
  }) =>
    request<{ id: string }>("/api/agent/exceptions", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  registerNoTag: (input: {
    pilgrimName: string;
    groupId: string;
    flightId: string;
    description: string;
    photoBase64?: string;
  }) =>
    request<{ id: string; tagNumber: string }>("/api/agent/no-tag", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
