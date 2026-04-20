# Changelog

All notable changes to the SGS Hajj Tracker project will be documented in this file.

## [1.1.0] - 2026-04-20

### Added

- **Scanner Mode Selector** (`useScannerMode` hook): new auto/zebra/camera toggle in Settings that lets agents override the detected scanner source. Preference is persisted in AsyncStorage and hydrated optimistically to avoid UI flash on the scan screen.
- **Scanner Mode Selector UI**: segmented control in Settings showing detected hardware and an override-warning banner when the user forces a non-auto mode.
- **Authentication failure auto-logout**: global `onAuthFailure` handler wired from `AuthContext` into the API layer — expired/invalid JWTs on non-auth endpoints now automatically clear credentials and redirect to `/login` instead of spamming 401s.
- **Login screen improvements**: password visibility toggle (eye/eye-off icon), redesigned biometric toggle as a tappable card with fingerprint icon and checkmark indicator, proper keyboard-avoiding behaviour on Android (`behavior="height"` with vertical offset).
- **FlashOverlay hint text**: scan result overlay now renders an optional `hint` line below the subtitle (used for "NOT IN MANIFEST" to explain the bag isn't registered in the current group).
- **Field component `rightElement` slot**: composable accessory view on the right (or left in RTL) of text inputs — used for the password eye toggle.
- **RTL-aware text alignment**: login form fields, error messages, biometric card, scan-screen banners, and footer all now respect `isRTL` with explicit `textAlign` and `writingDirection`.
- **ScreenHeader RTL back chevron**: back icon mirrors direction in Arabic locale.
- **Locale reload with biometric skip**: switching language triggers a native bundle reload (`Updates.reloadAsync` / `DevSettings.reload`); a one-time `sgs.skipNextBiometric` flag prevents the biometric gate from re-locking the app after the reload.
- **Root layout route guard for `/login`**: authenticated users sitting on `/login` are automatically redirected to `/scan` or `/session-setup`.
- **Zebra native module eager init**: root layout calls `isDataWedgeAvailable()` at boot to force TurboModule instantiation under the New Architecture, preventing silent scan loss on fresh launches.
- **Zebra SCAN intent-filter**: `withZebraScan` config plugin now declares the SCAN action on `MainActivity` in `AndroidManifest.xml` for discoverability and DataWedge profile compatibility.
- **API request/response logging**: dev-mode console logging for every SGS API call (method, URL, truncated auth header, status, duration, response body).
- **Scan dead-letter for unknown bags**: offline queue moves server-confirmed "unknown" bags (`result=unknown`) straight to dead-letter instead of retrying forever.
- **NOT-IN-MANIFEST offline skip**: scans already decided as NOT IN MANIFEST (with a loaded manifest) are not queued for server sync — avoids filling the offline queue with noise the server will always 404.
- **Variable debounce for red scans**: red (NOT IN MANIFEST) scans use a 2 s debounce window vs 1.5 s for other colours.
- **`app.json` + `eas.json` at repo root**: EAS Build configuration at the monorepo root pointing to production API.
- **iOS `ITSAppUsesNonExemptEncryption=false`**: skips export-compliance prompts on App Store submission.
- **iOS bundle identifier changed** to `app.semicolon.sa.sgsbagscan`.
- **App version bumped** to `1.0.1` (mobile `app.json`).

### Changed

- **`scannedBags` normalisation**: `normalizeGroup` now also accepts `actualBagCount` from the live SGS API so the scanned-bag counter is accurate.
- **`StatusPill` compacted**: reduced padding, dot size, font size, and letter spacing for a tighter header fit.
- **Footer button labels**: `numberOfLines={2}` with `adjustsFontSizeToFit` so long Arabic translations don't clip.
- **`mockup-sandbox` UI components updated**: Tailwind CSS class modernisation (`top-px`, bare `z-1`, `w-(--var)` syntax) in `navigation-menu.tsx` and `sidebar.tsx`.
- **`react` → `19.1.0`, `react-native` → `0.81.5`, `expo` → `~54.0.33`** moved from devDependencies to dependencies in `package.json`.

### Fixed

- **Stale JWT loop**: expired tokens no longer cause infinite 401 retries; the global auth-failure handler clears state immediately.
- **Biometric re-lock on language switch**: reload-triggered cold starts now bypass the biometric gate once.
- **Missing Zebra scans on fresh launch**: TurboModule lazy-loading no longer prevents the DataWedge BroadcastReceiver from registering.
- **RTL layout drift**: removed the `React.Fragment key={wrapperKey}` subtree remount hack; the Stack now uses a `key` prop tied to `locale-fontEpoch` for proper re-render without losing navigation state.

---

## [1.0.0] - 2025-06-01

### Added

- Initial release of SGS BagScan mobile application.
- Camera-based and Zebra-trigger barcode scanning.
- Biometric quick-unlock.
- Offline scan queue with automatic sync.
- Arabic/English locale support.
- EAS Build & OTA update integration.
