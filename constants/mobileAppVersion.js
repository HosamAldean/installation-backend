// backend/constants/mobileAppVersion.js
// Bump these every time a new mobile release APK is cut and copied into
// public/downloads/petra-mobile-latest.apk -- there is no OTA update
// mechanism for this app (no expo-updates, sideload-only distribution, see
// mobile/eas.json), so this is the only way an already-installed app can
// find out a newer build exists. LATEST_VERSION_CODE must match the
// versionCode actually baked into that APK (mobile/app.config.js's
// android.versionCode).
export const LATEST_VERSION_CODE = 7;
export const LATEST_VERSION_NAME = "1.0.6";

// Devices below this versionCode get a mandatory (non-dismissible) update
// screen (HomeScreen) and, for any build new enough to report its version
// at login (routes/auth.js), are refused a session outright until they
// update. Set equal to LATEST_VERSION_CODE -- explicit policy choice
// (2026-08-24): always force everyone onto the newest build rather than
// tolerating older-but-still-supported versions. Lower this back below
// LATEST_VERSION_CODE if a softer rollout (dismissible prompt only) is
// ever wanted again for a specific release.
export const MIN_SUPPORTED_VERSION_CODE = 7;

// Full devtunnel URL, not a relative path -- an OLD installed app may have
// its own API_BASE_URL baked in as the LAN address (see mobile/src/
// config.ts's dev default), which off-site devices like the one that
// prompted this feature can't reach at all. The devtunnel is reachable
// from anywhere regardless of what that stale build's own base URL is, so
// the update download always goes through it explicitly rather than
// riding along on whatever host the client happened to call this
// endpoint through.
//
// Release asset filename includes the version (petra-mobile-vX.Y.Z.apk),
// not a generic "app-release.apk" -- every earlier release used the same
// literal filename, so a device with a prior download still sitting in
// its Downloads folder could get confused (or its OS could silently skip
// the download / offer up the old cached file) since nothing distinguished
// the new file from the old one. Keep this per-version naming for every
// future release: rename the built APK to
// `petra-mobile-v${LATEST_VERSION_NAME}.apk` before `gh release upload`.
export const DOWNLOAD_URL = "https://github.com/HosamAldean/petra-mobile-releases/releases/download/v1.0.6/petra-mobile-v1.0.6.apk";

// What actually gets handed to a person (push notification body, the
// login-rejection response, the in-app update modal/toast) instead of
// DOWNLOAD_URL directly -- linking straight to the .apk gives a browser
// nothing to show (confirmed live: Chrome just silently starts a binary
// download with no page, no version info, no "what do I do next"). This
// points at GET /update instead, a small friendly HTML page (see index.js)
// that explains what's happening and links to DOWNLOAD_URL itself.
export const UPDATE_PAGE_URL = "https://petralu.duckdns.org:4000/update";
