const { ipcMain } = require("electron");
const saasClient = require("./saasClient");
const { extractHHMM } = require("./utils");

// Reminders + upcoming birthdays — backed by the multi-tenant API's
// polymorphic /api/reminders and /api/pets/upcoming-birthdays. Not
// branch-scoped (same as Clients/Pets/Records — branch-level data scoping
// hasn't been carried over to the new backend for any module yet).

function toDateOnlyStr(isoString) {
  if (!isoString) return null;
  return String(isoString).slice(0, 10);
}

function toLocalReminder(r) {
  return {
    id: r.id,
    entity_type: r.entityType,
    entity_id: r.entityId,
    remind_on: r.remindOn,
    note: r.note,
    is_dismissed: r.isDismissed,
    due_date: toDateOnlyStr(r.dueDate),
    doctor: r.doctor ?? null,
    reminder_type: r.reminderType ?? null,
  };
}

const BOARDING_REMINDER_TYPES = new Set(["boarding_feeding", "boarding_monitoring", "boarding_medication"]);

function toLocalDueReminder(r) {
  const isBoarding = BOARDING_REMINDER_TYPES.has(r.entityType);
  return {
    id: r.id,
    entity_type: r.entityType,
    entity_id: r.entityId,
    appointment_id: r.entityType === "appointment" ? r.entityId : null,
    // Boarding reminders need sub-hour precision ("due in 30 minutes") —
    // remind_on stays date-only for every other type (unchanged), boarding
    // types additionally get the full timestamp in remind_on_datetime.
    remind_on: toDateOnlyStr(r.remindOn),
    remind_on_datetime: isBoarding ? r.remindOn : null,
    note: r.note,
    appointment_date: toDateOnlyStr(r.appointmentDate),
    appointment_time: extractHHMM(r.appointmentTime),
    doctor: r.doctor ?? null,
    due_date: toDateOnlyStr(r.dueDate),
    reminder_type: r.reminderType ?? null,
    pet_name: r.petName,
    client_name: r.clientName,
    contact_number: r.contactNumber,
    branch_id: null,
    boarding_stay_id: r.boardingStayId ?? null,
  };
}

function setupRemindersHandlers() {
  ipcMain.handle("get-reminders", async (_event, { today } = {}) => {
    try {
      const result = await saasClient.listDueReminders(today);
      return { success: true, reminders: result.data.map(toLocalDueReminder) };
    } catch (err) {
      console.error("[get-reminders]", err);
      return { success: false, error: err.message, reminders: [] };
    }
  });

  ipcMain.handle("get-reminder-by-entity", async (_event, { entity_type, entity_id }) => {
    try {
      const result = await saasClient.getReminderByEntity(entity_type, entity_id);
      return { success: true, data: result.data ? toLocalReminder(result.data) : null };
    } catch (err) {
      console.error("[get-reminder-by-entity]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("list-reminders-by-entity", async (_event, { entity_type, entity_id }) => {
    try {
      const result = await saasClient.listRemindersByEntity(entity_type, entity_id);
      return { success: true, reminders: result.data.map(toLocalReminder) };
    } catch (err) {
      console.error("[list-reminders-by-entity]", err);
      return { success: false, error: err.message, reminders: [] };
    }
  });

  ipcMain.handle("add-reminder", async (_event, { entity_type, entity_id, remind_on, note, due_date, doctor, reminder_type } = {}) => {
    try {
      const trimmedNote = String(note || "").trim() || null;
      if (!entity_type || !entity_id || !remind_on) {
        return { success: false, error: "Entity type, entity id, and date are required." };
      }
      // Pet-direct reminders (entity_type='pet') require due_date +
      // reminder_type — the backend also enforces this, but failing fast
      // here avoids a round-trip for an obviously-incomplete form.
      if (entity_type === "pet" && (!due_date || !String(reminder_type || "").trim())) {
        return { success: false, error: "Due date and reminder type are required." };
      }
      const result = await saasClient.upsertReminder({
        entityType: entity_type,
        entityId: entity_id,
        remindOn: remind_on,
        note: trimmedNote,
        dueDate: due_date || null,
        doctor: String(doctor || "").trim() || null,
        reminderType: String(reminder_type || "").trim() || null,
      });
      // Returning the created/updated row (not just success) lets callers
      // that track multiple reminders locally (e.g. AddPetReminderModal's
      // "Custom Reminders" preview list on Appointments) capture the id —
      // needed to edit/delete that specific one later, since pet-direct
      // reminders no longer have "the one reminder for this entity" to
      // fall back on.
      return { success: true, message: "Reminder saved.", reminder: toLocalReminder(result.data) };
    } catch (err) {
      console.error("[add-reminder]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("update-reminder", async (_event, { id, remind_on, note, due_date, doctor, reminder_type } = {}) => {
    try {
      if (!id) {
        return { success: false, error: "Reminder id is required." };
      }
      const payload = {};
      if (remind_on !== undefined) payload.remindOn = remind_on;
      if (note !== undefined) payload.note = String(note || "").trim() || null;
      if (due_date !== undefined) payload.dueDate = due_date || null;
      if (doctor !== undefined) payload.doctor = String(doctor || "").trim() || null;
      if (reminder_type !== undefined) payload.reminderType = String(reminder_type || "").trim() || null;

      const result = await saasClient.updateReminderById(id, payload);
      return { success: true, reminder: toLocalReminder(result.data) };
    } catch (err) {
      console.error("[update-reminder]", err.message, err.details ? JSON.stringify(err.details) : "");
      return { success: false, error: err.message || "Could not update reminder" };
    }
  });

  ipcMain.handle("delete-reminder-by-id", async (_event, id) => {
    try {
      await saasClient.deleteReminderById(id);
      return { success: true };
    } catch (err) {
      console.error("[delete-reminder-by-id]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("dismiss-reminder", async (_event, id) => {
    try {
      await saasClient.dismissReminder(id);
      return { success: true };
    } catch (err) {
      console.error("[dismiss-reminder]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("delete-reminder", async (_event, { entity_type, entity_id }) => {
    try {
      await saasClient.deleteReminderByEntity(entity_type, entity_id);
      return { success: true };
    } catch (err) {
      console.error("[delete-reminder]", err);
      return { success: false, error: err.message };
    }
  });

  // Get upcoming birthdays
  ipcMain.handle("get-upcoming-birthdays", async () => {
    try {
      const result = await saasClient.listUpcomingBirthdays();
      const birthdays = result.data.map((b) => ({
        pet_name: b.petName,
        client_name: b.clientName,
        species: b.species,
        breed: b.breed,
        days_until_birthday:
          b.daysUntilBirthday === 0
            ? "Today"
            : b.daysUntilBirthday === 1
              ? "Tomorrow"
              : `In ${b.daysUntilBirthday} days`,
      }));
      return { success: true, birthdays };
    } catch (err) {
      console.error("[get-upcoming-birthdays]", err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = setupRemindersHandlers;
