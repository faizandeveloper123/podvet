const { ipcMain, shell, app } = require("electron");
const path = require("path");
const fs = require("fs");
const { generateConsentForm } = require("../consentForm");
const { generateInvoicePDF } = require("../generate_invoice");
const { formatDate, formatTime, resolveApiBranding, extractHHMM } = require("./utils");
const saasClient = require("./saasClient");

// Appointments — backed by the multi-tenant API's /api/appointments.
// branch_id is forced server-side for a branch-scoped ADMIN/USER creator;
// only an OWNER's create-appointment payload may set it (optional, defaults
// to clinic-wide/null). PDF rendering (invoice reprint) stays 100%
// desktop-side, fed by the API's structured invoice-payload data.

const statusToApi = { Confirmed: "CONFIRMED", Cancelled: "CANCELLED" };
const statusToLocal = { CONFIRMED: "Confirmed", CANCELLED: "Cancelled" };
const billingStatusToLocal = { PAID: "Paid", UNPAID: "Unpaid", PARTIALLY_PAID: "Partially Paid" };

async function buildBranding(store) {
  const clinic = await saasClient.getMyClinic();
  return resolveApiBranding(store, clinic.clinic);
}

function toLocalAppointmentBase(a) {
  return {
    appointment_id: a.id,
    pet_id: a.petId,
    legacy_pet_id: a.legacyPetId,
    pet_name: a.petName,
    species: a.species,
    breed: a.breed,
    client_id: a.clientId,
    client_name: a.clientName,
    contact_number: a.contactNumber,
    appointment_date: a.appointmentDate,
    appointment_time: extractHHMM(a.appointmentTime),
    notes: a.notes,
    status: statusToLocal[a.status] || a.status,
    doctor: a.doctor,
    total_amount: a.totalAmount,
    first_time_fee: a.firstTimeFee,
    billing_status: billingStatusToLocal[a.billingStatus] || a.billingStatus,
    billing_id: a.billingId,
    branch_id: a.branchId,
  };
}

// List rows (get-appointments) — `services`/`service_categories` are
// joined display STRINGS here, matching the legacy AppointmentDetails SQL
// view exactly (renderServices() in the renderer calls .split(', ') on
// these — passing the structured array crashes the whole render tree).
function toLocalAppointmentListRow(a) {
  return {
    ...toLocalAppointmentBase(a),
    services: (a.services || []).map((s) => s.serviceName).join(", "),
    service_categories: [...new Set((a.services || []).map((s) => s.category))].join(", "),
  };
}

// Single-appointment fetch (get-appointment-for-billing) — `services`
// stays a structured ARRAY here; the Edit modal's add/remove diff logic
// needs each line's own id/service_id, not just a display string.
function toLocalAppointmentDetail(a) {
  return {
    ...toLocalAppointmentBase(a),
    services: (a.services || []).map((s) => ({
      id: s.id,
      service_id: s.serviceId,
      service_name: s.serviceName,
      category: s.category,
      quantity: s.quantity,
      rate: s.rate,
      notes: s.notes,
    })),
  };
}

module.exports = function setupAppointmentsHandlers(store) {
  ipcMain.handle("generate-consent-form", async (_event, appointmentData) => {
    try {
      const branding = await buildBranding(store);
      const result = generateConsentForm(appointmentData, branding);
      if (result.success) {
        shell.openPath(result.filePath);
      }
      return result;
    } catch (error) {
      console.error("Error in generate-consent-form handler:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("create-appointment", async (_event, appointmentData) => {
    try {
      const result = await saasClient.createAppointment({
        petId: appointmentData.pet_id,
        appointmentDate: appointmentData.appointment_date,
        appointmentTime: appointmentData.appointment_time,
        notes: appointmentData.notes || undefined,
        doctor: appointmentData.doctor || undefined,
        status: appointmentData.status ? statusToApi[appointmentData.status] || undefined : undefined,
        services: (appointmentData.services || []).map((s) => ({ serviceId: s.service_id, baseRate: s.base_rate })),
        subServices: Object.fromEntries(
          Object.entries(appointmentData.sub_services || {}).map(([mainId, subs]) => [
            mainId,
            subs.map((s) => ({ serviceId: s.service_id, baseRate: s.base_rate })),
          ]),
        ),
        isBackfill: !!appointmentData.isBackfill,
        firstTimeFee: appointmentData.firstTimeFee ?? undefined,
        // Ignored server-side for a branch-scoped ADMIN/USER (forced to
        // their own branch); only meaningful when an OWNER sends it.
        branchId: appointmentData.branch_id || undefined,
        ...(appointmentData.reminder
          ? {
              reminder: {
                enabled: appointmentData.reminder.enabled,
                remindOn: appointmentData.reminder.remind_on || undefined,
                note: appointmentData.reminder.note || undefined,
              },
            }
          : {}),
      });
      return {
        success: true,
        message: "Appointment created successfully",
        appointment_id: result.data.id,
        isNewClient: result.data.isNewClient,
        firstTimeFee: result.data.firstTimeFee,
      };
    } catch (err) {
      console.error("Error creating appointment:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("get-appointments", async (_event, queryParams) => {
    try {
      const params = new URLSearchParams(queryParams);
      const page = parseInt(params.get("page")) || 1;
      const search = params.get("search") || undefined;
      const service = params.get("service") || undefined;
      const status = params.get("status") || undefined; // legacy status filter is dead UI, but forwarded if present
      const doctor = params.get("doctor") || undefined;
      const paymentStatus = params.get("paymentStatus") || undefined;
      const date = params.get("date") || undefined;

      const paymentStatusMap = { Paid: "PAID", Unpaid: "UNPAID", "Partially Paid": "PARTIALLY_PAID" };

      const result = await saasClient.listAppointments({
        page,
        pageSize: 5,
        search,
        service,
        status: status ? status.toUpperCase() : undefined,
        doctor,
        paymentStatus: paymentStatus ? paymentStatusMap[paymentStatus] || undefined : undefined,
        date,
      });

      return { success: true, appointments: result.data.map(toLocalAppointmentListRow), total: result.total, totalPages: result.totalPages };
    } catch (err) {
      console.error("Error fetching appointments:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("get-appointment-for-billing", async (_event, appointmentId) => {
    try {
      const result = await saasClient.getAppointmentForBilling(appointmentId);
      return { success: true, appointment: toLocalAppointmentDetail(result.data) };
    } catch (err) {
      console.error("Error fetching appointment for billing:", err);
      return { success: false, error: err.message };
    }
  });

  // Dead in the current UI (no call site uses this — edits go through
  // remove+add instead), kept functional for API completeness. Requires
  // both the appointment id and the service line id, unlike
  // remove-appointment-service below.
  ipcMain.handle("update-appointment-service", async (_event, { appointmentId, appointmentServiceId, rate, quantity = 1, notes }) => {
    try {
      await saasClient.updateAppointmentServiceLine(appointmentId, appointmentServiceId, { rate, quantity, notes: notes || undefined });
      return { success: true, message: "Appointment service updated successfully" };
    } catch (err) {
      console.error("Error updating appointment service:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("remove-appointment-service", async (_event, appointmentServiceId) => {
    try {
      await saasClient.removeAppointmentServiceLineById(appointmentServiceId);
      return { success: true, message: "Service removed successfully" };
    } catch (err) {
      console.error("Error removing appointment service:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("update-appointment-status", async (_event, appointmentId, status) => {
    try {
      await saasClient.updateAppointmentStatus(appointmentId, statusToApi[status] || status);
      return { success: true, message: "Appointment status updated successfully" };
    } catch (err) {
      console.error("Error updating appointment status:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("update-appointment", async (_event, { appointmentId, appointment_date, appointment_time, notes, doctor, status }) => {
    try {
      await saasClient.updateAppointment(appointmentId, {
        appointmentDate: appointment_date,
        appointmentTime: appointment_time,
        notes: notes || "",
        doctor,
        status: status ? statusToApi[status] || undefined : undefined,
      });
      return { success: true, message: "Appointment updated successfully" };
    } catch (err) {
      console.error("Error updating appointment:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("delete-appointment", async (_event, appointmentId) => {
    try {
      await saasClient.deleteAppointment(appointmentId);
      return { success: true, message: "Appointment deleted successfully" };
    } catch (err) {
      console.error("Error deleting appointment:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("add-service-to-appointment", async (_event, { appointmentId, serviceId, quantity = 1, customRate = null }) => {
    try {
      await saasClient.addAppointmentServiceLine(appointmentId, { serviceId, quantity, customRate });
      return { success: true, message: "Service added successfully" };
    } catch (err) {
      console.error("Error adding service to appointment:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("reprint-appointment-invoice", async (_event, appointmentId) => {
    try {
      const result = await saasClient.getAppointmentInvoicePayload(appointmentId);
      const payload = result.data;
      const use12HourTime = store.get("use12HourTime", false);
      const now = new Date();

      const invoiceData = {
        invoice_no: payload.invoiceNo,
        item_column_label: "Description",
        billing_date: formatDate(now.toISOString().slice(0, 10)),
        billing_time: formatTime(`${now.getHours()}:${now.getMinutes()}`, use12HourTime),
        line_items: payload.lineItems.map((li) => ({ name: li.label, cartQty: li.cartQty, price: li.price, total: li.total })),
        subtotal: payload.subtotal,
        discount: payload.couponDiscount + payload.manualDiscount,
        finalTotal: payload.finalTotal,
        coupon: payload.coupon || "",
        customer: {
          client_name: payload.clientName,
          contact_number: payload.contactNumber,
          pet_name: payload.petName,
          appointment_date: formatDate(String(payload.appointmentDate).slice(0, 10)),
          appointment_time: formatTime(extractHHMM(payload.appointmentTime), use12HourTime),
          doctor: payload.doctor || "",
        },
        branding: await buildBranding(store),
      };

      // Partially-Paid appointments show the outstanding-balance strip on
      // the reprinted invoice — Paid/Unpaid ones don't (matches legacy).
      if (payload.totalPaid > 0 && payload.remaining > 0) {
        invoiceData.partialPayment = {
          totalPaid: payload.totalPaid,
          remaining: payload.remaining,
          finalDue: payload.finalTotal,
        };
      }

      const baseDir = path.join(app.getPath("documents"), "PetVet-Invoices");
      await fs.promises.mkdir(baseDir, { recursive: true });
      const safeName = (payload.clientName || "client").replace(/[^\w\s]/g, "").replace(/\s+/g, "_");
      const ts = now.toISOString().slice(0, 19).replace(/:/g, "-");
      const filePath = path.join(baseDir, `${invoiceData.partialPayment ? "PartialInvoice" : "Invoice"}_${safeName}_${ts}.pdf`);
      await generateInvoicePDF(invoiceData, filePath);

      return {
        success: true,
        pdfPath: filePath,
        billing_id: payload.invoiceNo,
        line_items: payload.lineItems,
        subtotal: payload.subtotal,
        coupon_discount: payload.couponDiscount,
        manual_discount: payload.manualDiscount,
        final_total: invoiceData.partialPayment ? payload.remaining : payload.finalTotal,
        coupon: payload.coupon,
      };
    } catch (err) {
      console.error("reprint-appointment-invoice:", err);
      return { success: false, message: err.message };
    }
  });
};
