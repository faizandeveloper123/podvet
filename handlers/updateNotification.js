const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const { showNativeNotification } = require("./nativeNotifications");

// One-time "Updated to vX.X.X" native OS notification, fired the first time
// the app starts up on a version different from the last one it ran as.
// electron-updater's relaunch (main.js's 'restart-app-to-update' handler,
// triggered from UpdateToast.jsx — not automatic) can happen anywhere from
// immediately to days after the update actually downloaded, so "just
// updated" isn't something autoUpdater's own events can tell us directly —
// it has to be inferred here, at the next app start, by comparing versions.
const LAST_SEEN_VERSION_KEY = "lastSeenAppVersion";

const FALLBACK_MESSAGE = "PetVet has been updated.";

// changelog.json sits at the repo root (packaged into the app via
// package.json's electron-builder "files" list, same as package.json
// itself) — __dirname here is handlers/, one level below it. Read fresh
// each time rather than cached at module load: this only ever runs once
// per app start anyway, and it means editing changelog.json takes effect
// without needing to touch any other file.
function loadChangelogMessage(version) {
  try {
    const filePath = path.join(__dirname, "..", "changelog.json");
    const changelog = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return changelog[version] || FALLBACK_MESSAGE;
  } catch (err) {
    // Missing file, malformed JSON, no entry for this version, etc. — a
    // forgotten changelog entry should never be the reason an update
    // notification doesn't show at all.
    console.error("[update-notification] changelog load failed:", err.message);
    return FALLBACK_MESSAGE;
  }
}

// Runs once at startup. Deliberately does nothing on a true first-ever
// install (no stored version yet) — that's a new user, not someone who
// just updated, so there's nothing to announce. Only fires once a stored
// version exists AND differs from the current one; either way the stored
// version is immediately brought up to date so this can't re-fire for the
// same version on a later launch.
function checkForPostUpdateNotification(store, getMainWindow) {
  const currentVersion = app.getVersion();
  const lastSeenVersion = store.get(LAST_SEEN_VERSION_KEY);

  if (lastSeenVersion === undefined) {
    store.set(LAST_SEEN_VERSION_KEY, currentVersion);
    return;
  }

  if (lastSeenVersion === currentVersion) {
    return;
  }

  store.set(LAST_SEEN_VERSION_KEY, currentVersion);

  showNativeNotification({
    title: `Updated to v${currentVersion}`,
    body: loadChangelogMessage(currentVersion),
    getMainWindow,
  });
}

module.exports = checkForPostUpdateNotification;
