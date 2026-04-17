/**
 * Shift report builder.
 *
 * Produces a serializable snapshot of a single shift (flight + group + totals
 * + exceptions + queue status) plus pre-rendered plain-text and HTML
 * representations suitable for emailing, sharing, or printing.
 *
 * Kept pure / side-effect free so the same payload can be:
 *   1. shown in a confirmation dialog,
 *   2. fed to the native Share sheet,
 *   3. POSTed to the server for audit.
 */

import type { BagGroup, Flight, ManifestBag } from "@/lib/api/sgs";

export interface ShiftReportInput {
  flight: Flight;
  group: BagGroup;
  startedAt: string;
  endedAt: string;
  manifest: ManifestBag[];
  scannedTags: Set<string>;
  queue: {
    pending: number;
    failed: number;
    online: boolean;
    lastSyncAt: string | null;
  };
  agent: { id: string; name: string } | null;
}

export interface ShiftReport {
  /** Stable identifier for de-duplication on the audit endpoint. */
  reportId: string;
  generatedAt: string;
  flightId: string;
  flightNumber: string;
  destination: string;
  groupId: string;
  groupLabel: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  totals: {
    expected: number;
    scanned: number;
    remaining: number;
    exceptions: number;
    matchPct: number;
  };
  exceptions: Array<{ tagNumber: string; pilgrimName: string }>;
  queue: ShiftReportInput["queue"];
  agent: ShiftReportInput["agent"];
  text: string;
  html: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildShiftReport(input: ShiftReportInput): ShiftReport {
  const { flight, group, startedAt, endedAt, manifest, scannedTags, queue, agent } =
    input;

  const expected = group.expectedBags || manifest.length;
  const scanned = scannedTags.size;
  const remaining = Math.max(0, expected - scanned);
  const matchPct = expected ? Math.round((scanned / expected) * 100) : 0;

  const exceptions = manifest
    .filter((b) => b.status === "exception")
    .map((b) => ({ tagNumber: b.tagNumber, pilgrimName: b.pilgrimName }));

  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  const durationMinutes = Math.max(
    1,
    Math.round((endMs - startMs) / 60000),
  );

  // Stable id: flight + group + start instant. Lets the server collapse
  // accidental double-sends from the same shift.
  const reportId = `shift-${flight.id}-${group.id}-${startMs}`;

  const lines: string[] = [];
  lines.push(`SGS BagScan — Shift Summary`);
  lines.push(`Generated ${fmtDateTime(endedAt)}`);
  lines.push("");
  lines.push(`Flight: ${flight.flightNumber}${flight.destination ? ` → ${flight.destination}` : ""}`);
  lines.push(`Group:  ${group.groupNumber}`);
  if (agent) lines.push(`Agent:  ${agent.name} (${agent.id})`);
  lines.push(`Shift:  ${fmtDateTime(startedAt)} → ${fmtDateTime(endedAt)} (${durationMinutes}m)`);
  lines.push("");
  lines.push(`Totals`);
  lines.push(`  Expected:   ${expected}`);
  lines.push(`  Scanned:    ${scanned}  (${matchPct}%)`);
  lines.push(`  Remaining:  ${remaining}`);
  lines.push(`  Exceptions: ${exceptions.length}`);
  lines.push("");
  lines.push(`Queue`);
  lines.push(`  Pending: ${queue.pending}`);
  lines.push(`  Failed:  ${queue.failed}`);
  lines.push(`  Network: ${queue.online ? "online" : "offline"}`);
  if (queue.lastSyncAt) {
    lines.push(`  Last sync: ${fmtDateTime(queue.lastSyncAt)}`);
  }
  if (exceptions.length) {
    lines.push("");
    lines.push(`Exception tags`);
    for (const e of exceptions) {
      lines.push(`  - ${e.tagNumber}${e.pilgrimName ? ` — ${e.pilgrimName}` : ""}`);
    }
  }
  const text = lines.join("\n");

  const exceptionRows = exceptions.length
    ? exceptions
        .map(
          (e) =>
            `<tr><td>${escapeHtml(e.tagNumber)}</td><td>${escapeHtml(e.pilgrimName || "—")}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="2" style="color:#888">None</td></tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>SGS BagScan — Shift Summary</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:#111; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#666; font-size:12px; margin-bottom:16px; }
  table { border-collapse: collapse; width:100%; margin:8px 0 16px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #eee; font-size:13px; }
  th { background:#f6f6f6; font-weight:600; }
  .totals td:first-child { color:#555; width:40%; }
  .pct { font-size:36px; font-weight:700; }
</style></head>
<body>
  <h1>SGS BagScan — Shift Summary</h1>
  <div class="sub">Generated ${escapeHtml(fmtDateTime(endedAt))}</div>

  <table class="totals">
    <tr><td>Flight</td><td><strong>${escapeHtml(flight.flightNumber)}</strong>${flight.destination ? ` → ${escapeHtml(flight.destination)}` : ""}</td></tr>
    <tr><td>Group</td><td>${escapeHtml(group.groupNumber)}</td></tr>
    ${agent ? `<tr><td>Agent</td><td>${escapeHtml(agent.name)} (${escapeHtml(agent.id)})</td></tr>` : ""}
    <tr><td>Shift</td><td>${escapeHtml(fmtDateTime(startedAt))} → ${escapeHtml(fmtDateTime(endedAt))} (${durationMinutes}m)</td></tr>
  </table>

  <div class="pct">${matchPct}%</div>
  <div class="sub">${scanned} / ${expected} scanned</div>

  <table class="totals">
    <tr><td>Expected</td><td>${expected}</td></tr>
    <tr><td>Scanned</td><td>${scanned}</td></tr>
    <tr><td>Remaining</td><td>${remaining}</td></tr>
    <tr><td>Exceptions</td><td>${exceptions.length}</td></tr>
  </table>

  <h3>Queue</h3>
  <table class="totals">
    <tr><td>Pending scans</td><td>${queue.pending}</td></tr>
    <tr><td>Failed scans</td><td>${queue.failed}</td></tr>
    <tr><td>Network</td><td>${queue.online ? "Online" : "Offline"}</td></tr>
    ${queue.lastSyncAt ? `<tr><td>Last sync</td><td>${escapeHtml(fmtDateTime(queue.lastSyncAt))}</td></tr>` : ""}
  </table>

  <h3>Exception tags</h3>
  <table>
    <thead><tr><th>Tag</th><th>Pilgrim</th></tr></thead>
    <tbody>${exceptionRows}</tbody>
  </table>
</body></html>`;

  return {
    reportId,
    generatedAt: endedAt,
    flightId: flight.id,
    flightNumber: flight.flightNumber,
    destination: flight.destination,
    groupId: group.id,
    groupLabel: group.groupNumber,
    startedAt,
    endedAt,
    durationMinutes,
    totals: { expected, scanned, remaining, exceptions: exceptions.length, matchPct },
    exceptions,
    queue,
    agent,
    text,
    html,
  };
}
