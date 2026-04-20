# Flight-only scan flow — on-device smoke test

This checklist verifies the multi-group flight-only scan refactor end-to-end.
It must be executed on real hardware: a Zebra TC scanner with DataWedge for the
hardware path, and a consumer Android phone (camera) for the camera path. The
two paths share the same merged-manifest / optimistic-reconciliation logic, so
both must be exercised.

## Pre-flight

- A flight with **at least 3 groups**, each with a non-empty manifest.
- Manifests for all three groups have been pre-fetched at least once on the
  device (open the scan screen while online so the parallel manifest queries
  populate the cache).
- One agent account in the role `agent` (not `driver`) so the per-card
  Bulk Receive button is visible.
- A second account in role `driver` to confirm Bulk Receive is hidden for
  drivers (negative case).
- Airplane-mode toggle ready on the device for the offline portions.
- Backend reachable at the URL configured in `eas.json` for the build under
  test (production, per `replit.md`).

## A. Online scan reconciliation (no double-count)

Goal: `scanDelta` bump + server refetch must converge to the true count.

1. Sign in as the `agent`, pick the flight, do **not** pin a group.
2. On the scan screen, note the per-card "scanned/expected" for **Group A**.
3. Scan one bag whose tag is on Group A's manifest.
   - Expected: green flash, Group A's card pulses (green border briefly,
     scale-down), the counter ticks **+1 immediately**.
4. Wait ~2s for the `groups` query refetch.
   - Expected: Group A's counter remains at the same value (no jump to +2).
   - Expected: the flight-level header `m/n bags · pct%` matches the sum of
     per-card numbers.
5. Repeat for a tag from **Group B**. Confirm only Group B's card pulses and
   only Group B's counter advances.
6. Scan the same Group A tag a second time.
   - Expected: amber flash "DUPLICATE", no counter change anywhere.
7. Scan a tag that is on **none** of the manifests.
   - Expected: red flash "NOT IN MANIFEST" with the tag echoed as subtitle.

## B. Per-card Bulk Receive credits the right group

Goal: ?groupId param from a card routes scans correctly under offline + online.

1. From Group A's card tap **Bulk Receive**.
   - Expected: header subtitle reads `<flight> · Group A` (not session-pinned).
2. Toggle airplane mode ON.
3. Paste / scan 3 valid Group A tags, then paste 1 valid Group B tag.
4. Tap **Accept all**.
   - Expected: 3 Group A rows turn ✓, the Group B row marks as `wrong group`
     or `missing` (because the local manifest passed to `decideScan` is
     Group A's only).
5. Toggle airplane mode OFF, return to the scan screen.
6. Wait for the queue to drain (status pill shows queue=0 and last-sync time
   updates).
7. Refresh by leaving the flight and re-entering it.
   - Expected: Group A card shows the original count + 3, Group B card is
     **unchanged** (no spurious credit).
8. Repeat (1–4) while online to confirm same group credit on the happy path.

## C. Driver role hides Bulk Receive

1. Sign in as `driver`, pick the same flight.
2. Confirm none of the per-card Bulk Receive buttons render.

## D. Exception group picker fallback

1. Sign in as `agent`, pick the flight, do **not** pin a group.
2. Without scanning anything red, tap **Exception** in the footer.
   - Expected: the screen shows the **group picker** (lazy-loaded list with
     `<groupNumber>` and `<scanned>/<expected>`), because no group is pinned
     and no `?groupId` was passed.
3. Pick Group B. Fill in tag + reason, submit.
   - Expected: success alert, queue drains, exception is associated with
     Group B in the supervisor dashboard.
4. Back on the scan screen, scan a tag from Group A's manifest **as if it
   were Group B's** — i.e. scan a tag that is *not* in any manifest to
   force a red flash. Note the tag.
5. Tap **Exception**.
   - Expected: the form is **pre-filled** with that red-flashed tag, and the
     screen skips the picker by routing to the matched bag's group when
     applicable. For an unmatched tag, the picker still appears.

## E. No-tag bag, flight-only (no group picker)

1. Still flight-only (no pinned group), tap **No-tag** in the footer.
2. Fill pilgrim name + description, submit while ONLINE.
   - Expected: `tagGenerated` alert showing the backend-issued
     `NOTAG-<station>-<seq>` tag.
3. Toggle airplane mode ON, repeat with a different pilgrim.
   - Expected: `queuedOffline` alert showing a placeholder tag.
4. Toggle airplane mode OFF and wait for the queue to drain.
   - Expected: the placeholder is reconciled to the backend tag in the
     local cache (visible on the next manifest refresh).

## F. Shift summary aggregation

1. Still flight-only with the data accumulated above, tap **End** to open
   shift summary.
2. Verify header subtitle: `<flight> · All groups (<N>)` where N is the
   number of groups on the flight.
3. Verify the totals card:
   - `Expected` = sum of all groups' `expectedBags`.
   - `Scanned` = total unique tags scanned across all groups (deduped).
   - `Exceptions` = unique manifest entries with `status=exception` across
     groups (deduped by tagNumber).
4. Cross-check: numbers here should equal the sum of the per-card numbers
   shown on the scan screen at the same moment in time.
5. Tap **Send to supervisor** while ONLINE.
   - Expected: native share sheet appears, then a `Report sent` alert (if
     the audit POST succeeded) or `Report shared` (if backend route is
     missing — both are acceptable).

## G. Trigger-health ribbon (Zebra only)

1. On a Zebra device, after pulling a fresh build, open the scan screen and
   wait 30s without pulling the trigger.
   - Expected: amber ribbon "No scans yet" appears with **Open settings**.
2. Pull the trigger once. Ribbon disappears for the rest of the session.

---

## Pass criteria

All sections A–G complete with the **Expected** outcomes. Any double-count,
mis-routed credit, or missing picker is a regression that must be filed
against the original refactor, not against this checklist.

## Known follow-up

While reading the bulk-receive flow I noticed `decideScan` is called with
the *single-group* manifest (`getCachedManifest(groupId)`), so a tag that
belongs to another group on the same flight is reported as `wrong_group` or
`missing` rather than being routed to its real group. This is consistent
with the per-card "credit to this group only" intent, but the wording in
the result row may confuse agents who scan a mixed bundle. If on-device
testing confirms agent confusion, consider relabeling those rows as
"belongs to another group" instead of "wrong group / missing".
