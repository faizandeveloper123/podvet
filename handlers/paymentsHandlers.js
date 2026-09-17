const { ipcMain, safeStorage, app } = require("electron");
const path = require("path");
const fs = require("fs");
const { printPOSSlip, printLabSlip, printGeneratedPdf } = require("../generate_invoice");
const { resolveApiBranding, extractHHMM } = require("./utils");
const saasClient = require("./saasClient");

// Appointment payments — backed by the multi-tenant API's
// /api/appointments/:id/payments and /api/appointment-payments.
// is-lab-print-enabled/print-lab-slip are pure local feature-flag/PDF
// logic with no DB coupling at all (same as refine-soap-text/
// generate-consent-form) — left completely untouched.

const paymentStatusToLocal = { PAID: "Paid", UNPAID: "Unpaid", PARTIALLY_PAID: "Partially Paid" };
const paymentStatusToApi = { Paid: "PAID", Unpaid: "UNPAID", "Partially Paid": "PARTIALLY_PAID" };
const paymentModeToApi = { Cash: "CASH", "Card Payment": "CARD_PAYMENT", "Bank Transfer": "BANK_TRANSFER" };
const paymentModeToLocal = { CASH: "Cash", CARD_PAYMENT: "Card Payment", BANK_TRANSFER: "Bank Transfer" };

module.exports = function setupPaymentsHandlers(store) {
  // Decrypts the stored dbConfig.database for the clinic-gated checks below.
  // Falls back to the raw value for legacy plaintext configs from before encryption was added.
  function getDecryptedDbName() {
    const cfg = store.get("dbConfig");
    if (!cfg?.database) return null;
    try {
      return safeStorage.decryptString(Buffer.from(cfg.database, "base64"));
    } catch (err) {
      return cfg.database;
    }
  }

  ipcMain.handle(
    "record-appointment-payment",
    async (
      _event,
      { appointmentId, amount, paymentMode, couponCode = null, manualDiscountPercent = 0, manualDiscountFixed = 0, payRemainingOnly = false, products = null },
    ) => {
      try {
        // Note: `products.coupon` (a second, product-cart-specific coupon
        // the renderer's UI allows applying alongside the service-side
        // `couponCode`) is not sent on — the backend enforces one coupon
        // per Billing ever, same as the legacy app. The service-side
        // coupon takes precedence; applying both simultaneously is a rare
        // combination this migration doesn't attempt to reconcile.
        const result = await saasClient.recordAppointmentPayment(appointmentId, {
          amount,
          paymentMode: paymentModeToApi[paymentMode] || paymentMode,
          couponCode: couponCode || undefined,
          manualDiscountPercent,
          manualDiscountFixed,
          payRemainingOnly,
          // Whether an item is "already on the appointment" (already
          // stock-deducted) is now decided server-side by matching
          // productId against the DB's own live AppointmentProduct rows —
          // see appointmentPayment.service.ts's mergeInLiveProducts — not
          // by a client-sent flag, so nothing extra needs to travel here.
          productsCart: products?.cart?.map((item) => ({ productId: item.id, cartQty: item.cartQty, price: item.price, total: item.total })) || [],
        });

        return {
          success: true,
          message: result.data.status === "PAID" ? "Payment completed successfully!" : "Partial payment recorded successfully!",
          status: paymentStatusToLocal[result.data.status] || result.data.status,
          pdfPath: null,
        };
      } catch (err) {
        console.error("Error recording payment:", err);
        return { success: false, message: err.message };
      }
    },
  );

  ipcMain.handle("get-payments-list", async (_event, { page = 1, limit = 10, statusFilter = "all" } = {}) => {
    try {
      const result = await saasClient.listAppointmentPayments({ page, pageSize: limit, statusFilter });
      const payments = result.data.map((p) => ({
        appointment_id: p.appointmentId,
        appointment_date: p.appointmentDate,
        appointment_time: extractHHMM(p.appointmentTime),
        total_amount: p.totalAmount,
        first_time_fee: p.firstTimeFee,
        billing_status: paymentStatusToLocal[p.billingStatus] || p.billingStatus,
        billing_id: p.billingId,
        client_name: p.clientName,
        contact_number: p.contactNumber,
        pet_name: p.petName,
        total_due: p.totalDue,
        total_paid: p.totalPaid,
        payment_summary: p.paymentSummary,
      }));
      return { success: true, payments, total: result.total, totalPages: result.totalPages };
    } catch (err) {
      console.error("[get-payments-list]", err);
      return { success: false, error: err.message, payments: [], total: 0 };
    }
  });

  ipcMain.handle("update-appointment-payment-status", async (_event, appointmentId, paymentStatus, couponCode = null) => {
    try {
      await saasClient.updateAppointmentPaymentStatus(appointmentId, {
        status: paymentStatusToApi[paymentStatus] || paymentStatus,
        couponCode: couponCode || undefined,
      });
      return { success: true, message: paymentStatus === "Unpaid" ? "Payment reset to Unpaid. All transaction records cleared." : "Payment status updated" };
    } catch (err) {
      console.error("[update-appointment-payment-status]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("print-pos-slip", async (_event, data) => {
    try {
      const clinic = await saasClient.getMyClinic();
      data.branding = await resolveApiBranding(store, clinic.clinic);
      return await printPOSSlip(data);
    } catch (err) {
      console.error("[print-pos-slip]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("is-lab-print-enabled", async () => {
    return getDecryptedDbName() === "webatmax_dr_alee_pet_clinic";
  });

  ipcMain.handle("print-lab-slip", async (_event, data) => {
    if (getDecryptedDbName() !== "webatmax_dr_alee_pet_clinic") {
      return { success: false, error: "Feature not enabled for this clinic" };
    }
    if (!data?.tests?.trim()) return { success: false, error: "Tests are required" };
    if (!data?.ordered_by?.trim()) return { success: false, error: "Ordered by is required" };
    try {
      const clinic = await saasClient.getMyClinic();
      data.branding = await resolveApiBranding(store, clinic.clinic);
      return await printLabSlip(data);
    } catch (err) {
      console.error("[print-lab-slip]", err);
      return { success: false, error: err.message };
    }
  });

  // Same job as print-pos-slip/print-lab-slip above, for the one document
  // type that isn't already a file on disk by the time Print is clicked: the
  // Medical Summary (generateSummaryPDF.js) is built client-side with
  // jsPDF, not via generate_invoice.js in the main process, so there's no
  // pdfPath to hand straight to a print-file-style handler. This writes the
  // renderer's PDF bytes to a temp file first, then prints it the same way.
  ipcMain.handle("print-pdf-buffer", async (event, { data, fileName }) => {
    try {
      const filePath = path.join(app.getPath("temp"), fileName || `Document_${Date.now()}.pdf`);
      await fs.promises.writeFile(filePath, Buffer.from(data));
      return await printGeneratedPdf(filePath);
    } catch (err) {
      console.error("[print-pdf-buffer]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("get-appointment-payment-details", async (_event, appointmentId) => {
    try {
      const result = await saasClient.getAppointmentPaymentDetails(appointmentId);
      const d = result.data;
      const payments = d.payments.map((p) => ({
        id: p.id,
        appointment_id: appointmentId,
        amount: p.amount,
        payment_mode: paymentModeToLocal[p.paymentMode] || p.paymentMode,
        paid_at: p.paidAt,
      }));
      return {
        success: true,
        appointment: {
          appointment_id: d.appointment.id,
          pet_name: d.appointment.petName,
          client_name: d.appointment.clientName,
          contact_number: d.appointment.contactNumber,
          doctor: d.appointment.doctor,
          appointment_date: d.appointment.appointmentDate,
          appointment_time: extractHHMM(d.appointment.appointmentTime),
          total_amount: d.appointment.totalAmount,
          first_time_fee: d.appointment.firstTimeFee,
          billing_status: paymentStatusToLocal[d.appointment.billingStatus] || d.appointment.billingStatus,
          billing_id: d.appointment.billingId,
        },
        payments,
        transactions: payments,
        totalDue: d.totalDue,
        totalPaid: d.totalPaid,
        remaining: d.remaining,
      };
    } catch (err) {
      console.error("[get-appointment-payment-details]", err);
      return { success: false, message: err.message };
    }
  });
};
