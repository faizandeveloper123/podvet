const { ipcMain } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const saasClient = require("./saasClient");
const { extractHHMM } = require("./utils");
const { showNativeNotification } = require("./nativeNotifications");

// Native OS notifications (Windows Action Center / macOS Notification
// Center) for reminders that have just become due — this only runs while
// the app process is alive (open or minimized); there's no app-closed
// notification path (would need a separate always-on service, out of
// scope). DB access already runs through the multi-tenant API via
// saasClient (see remindersHandlers.js) — no local DB in the main process
// to query directly, so this reuses the same listDueReminders() call.
//
// Also backs the notification bell in the top nav (Dashboard.jsx) — the
// bell shows exactly the reminders that fired an OS notification, read off
// the same store key below, so the two can never drift out of sync.

// 20 minutes: reminders are date-granular (a day, not a minute, is what
// "due" means for every type except the sub-hour boarding ones), so
// sub-15-minute polling buys nothing. 20 min sits in the middle of the
// suggested 15-30 min range — frequent enough that a reminder due at
// midnight is noticed within the hour, without polling the API needlessly
// often while the app just sits open.
const CHECK_INTERVAL_MS = 20 * 60 * 1000;
// First check fires shortly after launch rather than instantly, so it
// doesn't compete with the splash screen / login flow for attention.
const INITIAL_DELAY_MS = 15 * 1000;

// The bell only ever shows the most recent 5 firings, so "unread" is scoped
// to that same window — otherwise an unread item that scrolls past position
// 5 would inflate the badge count forever with no way to reach it and clear
// it (it can still be reached and cleared once it's dismissed elsewhere,
// via the same prune-on-dismiss logic that already runs below).
const BELL_FEED_SIZE = 5;

// Stored shape: `{ scopeKey, records }`. `records` holds one entry per
// reminder that has fired an OS notification at least once today (and
// hasn't since been dismissed/deleted — see the prune step below) —
// firedAt's date is the per-day dedup key, so a reminder that's still
// within its active window re-fires (and this record gets overwritten) on
// each subsequent day, capped at one notification per day. Holds enough of
// the reminder's own fields to render the bell dropdown's text without a
// second API round-trip, plus firedAt (ordering + per-day dedup) and
// isRead (bell read-tracking). See getScopedRecords/saveScopedRecords
// below for what scopeKey guards against — this whole cache is discarded
// (not merged/namespaced) whenever it doesn't match the current one.
const STORE_KEY = "firedReminderNotifications";

// This cache is a plain machine-local file (electron-store), with no
// awareness of which backend/clinic it was populated from — but this one
// install can be pointed at different backends over its lifetime (e.g. a
// local dev API during testing vs. the production one for real clinic
// use), each with its own Reminders table whose ids restart from 1. A bare
// `String(id)` key can therefore collide across environments: switching
// backends could make a stale, unrelated reminder from the old one look
// "still active" forever, since its id happens to also exist in the new
// backend's results. Scoping by backend URL + clinic id and discarding
// the cache outright on a scope mismatch (rather than trying to merge/
// namespace multiple scopes at once — a single desktop session only ever
// has one active backend+clinic at a time) closes that hole.
function getCurrentScopeKey() {
  const clinicId = saasClient.loadSession()?.activeClinic?.clinicId ?? null;
  return `${saasClient.getBaseUrl()}::${clinicId}`;
}

function getScopedRecords(store) {
  const stored = store.get(STORE_KEY);
  const scopeKey = getCurrentScopeKey();
  if (!stored || stored.scopeKey !== scopeKey) {
    return { scopeKey, records: {} };
  }
  return { scopeKey, records: stored.records || {} };
}

function saveScopedRecords(store, scopeKey, records) {
  store.set(STORE_KEY, { scopeKey, records });
}

function toDateOnlyStr(isoString) {
  if (!isoString) return null;
  return String(isoString).slice(0, 10);
}

function getLocalTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// getReminderDueLine already exists as a plain (non-React) function in the
// renderer's src tree (pet-vet/src/utils/reminderMessage.js) — reused
// here via a dynamic import rather than re-implemented, so the WhatsApp
// message text and the notification text can never drift apart. Works
// because pet-vet/package.json declares "type": "module": Node resolves
// that file as real ESM based on its own nearest package.json regardless of
// this (CommonJS) file's own module type. (The bell dropdown itself renders
// in the renderer and imports reminderMessage.js directly — this dynamic
// import is only needed here, on the main-process side of the OS
// notification.)
let reminderMessageModulePromise = null;
function loadReminderMessageModule() {
  if (!reminderMessageModulePromise) {
    const filePath = path.join(__dirname, "..", "pet-vet", "src", "utils", "reminderMessage.js");
    reminderMessageModulePromise = import(pathToFileURL(filePath).href);
  }
  return reminderMessageModulePromise;
}

function toReminderForText(r) {
  return {
    entity_type: r.entityType,
    pet_name: r.petName,
    client_name: r.clientName,
    note: r.note,
    remind_on: r.remindOn,
    appointment_date: toDateOnlyStr(r.appointmentDate),
    appointment_time: extractHHMM(r.appointmentTime),
    doctor: r.doctor,
    due_date: toDateOnlyStr(r.dueDate),
    reminder_type: r.reminderType,
  };
}

function fireNotification(reminderForText, line, getMainWindow) {
  const title = reminderForText.pet_name
    ? reminderForText.pet_name + (reminderForText.client_name ? ` (${reminderForText.client_name})` : "")
    : "Reminder due";

  showNativeNotification({ title, body: line, getMainWindow, navigateTo: "/dashboard" });
}

function sortedByFiredAtDesc(records) {
  return Object.values(records).sort((a, b) => new Date(b.firedAt) - new Date(a.firedAt));
}

// Persisted in electron-store rather than a new `notified_at` DB column —
// this app already uses electron-store for exactly this kind of local,
// per-install state (auth tokens/session, use12HourTime, dbConfig), and a
// notified-or-not/read-or-not flag has no reason to be shared across the
// clinic's other devices/users the way the reminder itself is, so it
// doesn't belong in the multi-tenant backend. Avoids a schema change
// entirely.
async function checkAndNotify(store, getMainWindow) {
  let result;
  try {
    result = await saasClient.listDueReminders();
  } catch (err) {
    // Not signed in yet, offline, token refresh failed, etc. — silent,
    // next interval just retries.
    console.error("[reminder-notifications] fetch failed:", err.message);
    return;
  }

  const rows = result?.data || [];
  const today = getLocalTodayStr();
  const { scopeKey, records } = getScopedRecords(store);
  const stillActiveIds = new Set();
  let reminderMessage;
  let addedAny = false;

  for (const r of rows) {
    const id = String(r.id);
    stillActiveIds.add(id);

    // startDate = remind_on: for appointments and pet-direct reminders,
    // this is the lead-in date (e.g. 3 days before the appointment/due
    // date; see Appointments.jsx's calculateReminderDate and
    // AddPetReminderModal.jsx's identical subtractDays use) that
    // determines when it starts appearing on the Dashboard's reminders
    // list at all — notifications should start then too, not wait for the
    // actual event.
    //
    // dueDate = the actual event: appointment_date for appointments (the
    // appointment IS the thing that's due, remind_on is just an early
    // heads-up), due_date for pet-direct reminders (same idea — the user
    // picked a due date, remind_on is the calculated lead-in), or
    // remind_on itself for every other type (no separate lead-in concept —
    // remind_on already IS their due date, so start === due and this fires
    // on exactly one day, same as before).
    //
    // Fires once per calendar day for every day in [startDate, dueDate]
    // inclusive (e.g. 24th/25th/26th/27th for a 3-day-lead appointment due
    // on the 27th) — not once ever — but never past dueDate: once the
    // event itself is overdue, the Dashboard's red "overdue" badge is what
    // communicates that, not a repeated/backlog OS notification.
    const startDate = toDateOnlyStr(r.remindOn);
    const dueDate =
      r.entityType === "appointment"
        ? toDateOnlyStr(r.appointmentDate) || startDate
        : r.entityType === "pet"
          ? toDateOnlyStr(r.dueDate) || startDate
          : startDate;
    if (!startDate || !dueDate || today < startDate || today > dueDate) continue;

    const existing = records[id];
    if (existing && toDateOnlyStr(existing.firedAt) === today) continue; // already notified today

    const reminderForText = toReminderForText(r);
    let line;
    try {
      if (!reminderMessage) reminderMessage = await loadReminderMessageModule();
      line = reminderMessage.getReminderDueLine(reminderForText);
    } catch (err) {
      console.error("[reminder-notifications] text generation failed:", err.message);
      line = reminderForText.note || "Reminder due";
    }

    fireNotification(reminderForText, line, getMainWindow);

    records[id] = {
      id: r.id,
      entityType: r.entityType,
      petName: r.petName,
      clientName: r.clientName,
      note: r.note,
      remindOn: r.remindOn,
      appointmentDate: toDateOnlyStr(r.appointmentDate),
      appointmentTime: extractHHMM(r.appointmentTime),
      doctor: r.doctor,
      dueDate: toDateOnlyStr(r.dueDate),
      reminderType: r.reminderType,
      firedAt: new Date().toISOString(),
      // Each new day's re-fire is a fresh ping — resets to unread even if
      // yesterday's firing for this same reminder had already been read.
      isRead: false,
    };
    addedAny = true;
  }

  // Prune entries for reminders no longer in the active (non-dismissed,
  // not-yet-deleted) set returned by the API, so this doesn't grow forever
  // — and so a dismissed reminder disappears from the bell exactly when it
  // disappears from the OS-notification dedup set, keeping the two in sync.
  const pruned = {};
  for (const id of Object.keys(records)) {
    if (stillActiveIds.has(id)) pruned[id] = records[id];
  }
  saveScopedRecords(store, scopeKey, pruned);

  if (addedAny) {
    getMainWindow()?.webContents.send("reminder-notifications-updated");
  }
}

function getBellFeed(store) {
  const { records } = getScopedRecords(store);
  const feed = sortedByFiredAtDesc(records).slice(0, BELL_FEED_SIZE);
  const unreadCount = feed.filter((n) => !n.isRead).length;
  return { notifications: feed, unreadCount };
}

function setupReminderNotifications(store, getMainWindow) {
  const run = () => checkAndNotify(store, getMainWindow);
  const initialTimer = setTimeout(run, INITIAL_DELAY_MS);
  const interval = setInterval(run, CHECK_INTERVAL_MS);

  ipcMain.handle("get-reminder-notifications", () => {
    try {
      return { success: true, ...getBellFeed(store) };
    } catch (err) {
      console.error("[get-reminder-notifications]", err);
      return { success: false, notifications: [], unreadCount: 0 };
    }
  });

  ipcMain.handle("mark-reminder-notification-read", (_event, id) => {
    try {
      const { scopeKey, records } = getScopedRecords(store);
      const record = records[String(id)];
      if (record && !record.isRead) {
        record.isRead = true;
        saveScopedRecords(store, scopeKey, records);
      }
      return { success: true };
    } catch (err) {
      console.error("[mark-reminder-notification-read]", err);
      return { success: false, message: err.message };
    }
  });

  return {
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    },
    checkNow: run,
  };
}

module.exports = setupReminderNotifications;
