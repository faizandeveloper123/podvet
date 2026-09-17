const { Notification } = require("electron");

// The one place that touches Electron's native OS notification API
// (Windows Action Center / macOS Notification Center) directly — both
// reminder notifications (handlers/reminderNotifications.js) and the
// post-update notification (handlers/updateNotification.js) call this
// instead of constructing their own Notification, so there's exactly one
// notification-firing code path in the app, not one per feature.
function showNativeNotification({ title, body, getMainWindow, navigateTo }) {
  if (!Notification.isSupported()) return;

  const notification = new Notification({ title, body });
  notification.on("click", () => {
    const win = getMainWindow?.();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (navigateTo) win.webContents.send("navigate-to", navigateTo);
  });
  notification.show();
}

module.exports = { showNativeNotification };
