# SGS BagScan (mobile)

Expo React Native app used by SGS field agents to scan luggage tags during
Hajj operations.

## Development

```bash
pnpm --filter @workspace/mobile run dev
```

## Releases

The app ships in two channels:

1. **Native build** (APK / IPA) — required whenever you bump the Expo SDK,
   change a native plugin, or modify `app.json` fields outside of JS
   (permissions, plugins, package id, etc.).
2. **OTA update** (`expo-updates` via EAS Update) — the fast path for JS-only
   fixes that ship to already-installed devices in seconds. Agents are
   prompted to apply the update during idle time on the next cold start
   (see `components/OtaUpdateGate.tsx`).

### One-time setup

```bash
# Authenticate the machine doing the release.
pnpm exec eas login

# Link this repo to an EAS project (writes the project id into app.json
# and creates the EAS Update endpoint).
pnpm --filter @workspace/mobile exec eas init
pnpm --filter @workspace/mobile exec eas update:configure
```

After `eas update:configure` runs, the placeholder
`expo.updates.url` in `app.json` is replaced with the real
`https://u.expo.dev/<project-id>` URL. Commit that change.

### Cutting an OTA update

```bash
# From repo root. `--branch production` matches the channel that the
# installed APK is bound to (set during the EAS Build profile).
pnpm --filter @workspace/mobile exec eas update \
  --branch production \
  --message "fix: correct group counts on dashboard"
```

The runtime version is pinned to `app.json` → `expo.version` (policy
`appVersion`). That means an OTA update only reaches devices running the
**same** `expo.version`. If you bump `version` you must publish a new
native build before any new OTA can land.

### Cutting a native build

```bash
pnpm --filter @workspace/mobile exec eas build --platform android --profile production
```

Distribute the resulting APK to ops via the normal channel; once installed,
subsequent JS fixes can ship via `eas update` without reinstalling.

## Other docs

- `docs/zebra-datawedge-setup.md` — Zebra trigger / DataWedge profile setup.
