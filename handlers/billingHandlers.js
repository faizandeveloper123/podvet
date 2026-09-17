const { ipcMain, app } = require("electron");
const path = require("path");
const fs = require("fs");
const { generateInvoicePDF } = require("../generate_invoice");
const { formatDate, formatTime, resolveApiBranding, extractHHMM } = require("./utils");
const saasClient = require("./saasClient");

// Coupons + walk-in POS billing + appointment invoice PDFs — backed by the
// multi-tenant API's /api/coupons and /api/billing. PDF rendering stays
// 100% desktop-side (same "backend never touches files" precedent as EMR
// Reports) — every handler here fetches structured data from the API,
// then builds the exact invoiceData shape generate_invoice.js's
// generateInvoicePDF() already expects, unchanged.

function toLocalCoupon(c) {
  return {
    coupon_id: c.id,
    code: c.code,
    discount_type: c.discountType,
    discount_value: c.discountValue,
    start_date: c.startDate ? c.startDate.slice(0, 10) : null,
    expiry_date: c.expiryDate ? c.expiryDate.slice(0, 10) : null,
    usage_limit: c.usageLimit,
    times_used: c.timesUsed,
    is_active_status: c.isActive,
  };
}

// Same convention as clientBillingHandlers.js's pay-all-client-appointments —
// the renderer's <select> uses human-readable labels as option values
// (nice for direct display), this handler maps to the API's enum member
// names right before the persist call.
const PAYMENT_MODE_TO_API = { Cash: "CASH", "Card Payment": "CARD_PAYMENT", "Bank Transfer": "BANK_TRANSFER" };
// Reverse of the above, for display — plus the status enum, which
// Payments.jsx's existing getStatusBadge() already renders for appointment
// billing_status ("Paid"/"Partially Paid"/"Unpaid"), so custom invoices
// reuse that same helper rather than needing their own.
const PAYMENT_MODE_TO_LOCAL = { CASH: "Cash", CARD_PAYMENT: "Card Payment", BANK_TRANSFER: "Bank Transfer" };
const STATUS_TO_LOCAL = { PAID: "Paid", PARTIALLY_PAID: "Partially Paid", UNPAID: "Unpaid" };

async function buildBranding(store) {
  const clinic = await saasClient.getMyClinic();
  return resolveApiBranding(store, clinic.clinic);
}

module.exports = function setupBillingHandlers(store) {
  ipcMain.handle("retrieve-coupons", async (_event, { page, query }) => {
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const result = await saasClient.listCoupons({ page: safePage, pageSize: 5, search: query || undefined });
    return { data: result.data.map(toLocalCoupon), total: result.total, totalPages: result.totalPages };
  });

  ipcMain.handle("add-coupon", async (_event, coupon) => {
    try {
      const result = await saasClient.createCoupon({
        code: coupon.code,
        discountType: coupon.discount_type,
        discountValue: coupon.discount_value,
        startDate: coupon.start_date || undefined,
        expiryDate: coupon.expiry_date || undefined,
        usageLimit: coupon.usage_limit,
      });
      return { success: true, message: "Coupon added successfully", couponId: result.data.id };
    } catch (err) {
      console.error("[add-coupon]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("edit-coupon", async (_event, coupon) => {
    try {
      await saasClient.updateCoupon(coupon.coupon_id, {
        code: coupon.code,
        discountType: coupon.discount_type,
        discountValue: coupon.discount_value,
        startDate: coupon.start_date || undefined,
        expiryDate: coupon.expiry_date || undefined,
        usageLimit: coupon.usage_limit,
      });
      return { success: true, message: "Coupon updated successfully" };
    } catch (err) {
      console.error("[edit-coupon]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("delete-coupon", async (_event, couponId) => {
    try {
      await saasClient.deleteCoupon(couponId);
      return { success: true, message: "Coupon deleted successfully" };
    } catch (err) {
      return { success: false, message: err.message || "Coupon not found" };
    }
  });

  // Renderer never actually passes `subtotal` (verified against
  // Appointments.jsx's two call sites — both call this with just the
  // code) — it re-multiplies the RAW discountValue by whatever running
  // total it has client-side (calculateDiscount / the product-coupon
  // inline math), so `discountAmount` here must stay the raw stored
  // value, not a pre-computed currency amount.
  ipcMain.handle("apply-coupon", async (_event, couponCode) => {
    try {
      const result = await saasClient.applyCoupon({ code: couponCode, subtotal: 0 });
      return {
        success: true,
        discountAmount: result.data.discountValue,
        couponId: result.data.couponId,
        discountType: result.data.discountType,
      };
    } catch (err) {
      return { success: false, message: err.message || "Invalid coupon" };
    }
  });

  // ── Walk-in POS checkout ─────────────────────────────────────────────
  // paymentMethods: [{method: "Cash"|"Card Payment"|"Bank Transfer", amount}]
  // — a repeatable, split payment-source list matching legacy exactly. An
  // empty/omitted array (or one summing to 0 against a positive total) is
  // a credit sale, which the backend rejects unless client_id is set.
  const paymentModeToApi = { Cash: "CASH", "Card Payment": "CARD_PAYMENT", "Bank Transfer": "BANK_TRANSFER" };
  const paymentStatusToLocal = { PAID: "Paid", UNPAID: "Unpaid", PARTIALLY_PAID: "Partially Paid" };

  ipcMain.handle("complete-payment", async (_event, { cart, subtotal, discount, manualDiscountAmount = 0, finalTotal, coupon, customerName, customerPhone, client_id, paymentMethods = [] }) => {
    try {
      const result = await saasClient.completeWalkInPayment({
        cart: cart.map((item) => ({ id: item.id, cartQty: item.cartQty, price: item.price, total: item.total })),
        subtotal,
        discount,
        manualDiscountAmount,
        finalTotal,
        coupon: coupon || undefined,
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
        // Links this sale to an existing client record when the renderer's
        // customer-name field still matches a confirmed search selection
        // (see Billing.jsx's hasVerifiedClient) — never trusted blindly,
        // the backend re-verifies the id independently regardless.
        clientId: client_id || undefined,
        paymentMethods: paymentMethods.map((p) => ({ method: paymentModeToApi[p.method] || p.method, amount: p.amount })),
      });

      const use12HourTime = store.get("use12HourTime", false);
      const now = new Date();
      const invoiceData = {
        invoice_no: result.data.billingId,
        billing_date: formatDate(now.toISOString().slice(0, 10)),
        billing_time: formatTime(`${now.getHours()}:${now.getMinutes()}`, use12HourTime),
        cart: cart.map((item) => ({ name: item.name, cartQty: item.cartQty, price: item.price, total: item.total })),
        subtotal: result.data.subtotal,
        discount: result.data.discount,
        finalTotal: result.data.finalTotal,
        coupon: coupon || "",
        customer: customerName || customerPhone ? { client_name: customerName || "", contact_number: customerPhone || "" } : null,
        // Same partialPayment shape generate-quick-bill already feeds
        // generate_invoice.js (see its "Paid so far / REMAINING" block) —
        // without this, every invoice PDF renders as if the full amount
        // was collected, even for a credit or partially-paid sale.
        partialPayment: result.data.status !== "PAID"
          ? { totalPaid: result.data.amountPaid, remaining: result.data.finalTotal - result.data.amountPaid }
          : null,
        branding: await buildBranding(store),
        use12HourTime,
      };

      const baseDir = path.join(app.getPath("documents"), "PetVet-Invoices");
      await fs.promises.mkdir(baseDir, { recursive: true });
      const filePath = path.join(baseDir, `Invoice_${result.data.billingId}_${now.toISOString().slice(0, 10)}.pdf`);
      await generateInvoicePDF(invoiceData, filePath);

      const status = paymentStatusToLocal[result.data.status] || result.data.status;
      const message =
        status === "Unpaid"
          ? "Credit sale saved — nothing collected yet."
          : status === "Partially Paid"
            ? `Partial payment saved — PKR ${Math.round(result.data.amountPaid).toLocaleString()} collected, ${Math.round(result.data.finalTotal - result.data.amountPaid).toLocaleString()} still due.`
            : "Payment complete. Invoice saved.";

      return { success: true, message, pdfPath: filePath, billing_id: result.data.billingId, payment_status: status };
    } catch (err) {
      console.error("[complete-payment]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("generate-appointment-invoice", async (_event, appointmentId) => {
    try {
      const result = await saasClient.getAppointmentInvoicePayload(appointmentId);
      const payload = result.data;
      if (!payload.lineItems.length) {
        return { success: false, message: "Nothing to invoice yet (no services or products on file)." };
      }

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

      const baseDir = path.join(app.getPath("documents"), "PetVet-Invoices");
      await fs.promises.mkdir(baseDir, { recursive: true });
      const safeInvoiceNo = String(payload.invoiceNo).replace(/[^\w.-]+/g, "_");
      const filePath = path.join(baseDir, `Invoice_${safeInvoiceNo}_${now.toISOString().slice(0, 10)}_${Date.now()}.pdf`);
      await generateInvoicePDF(invoiceData, filePath);

      return { success: true, message: `Invoice saved to:\n${filePath}`, pdfPath: filePath };
    } catch (err) {
      console.error("[generate-appointment-invoice]", err);
      return { success: false, message: err.message };
    }
  });

  // Mixed-case shape here is deliberate — matches the legacy app's own
  // buildAppointmentInvoicePayload exactly (line_items/coupon_discount/
  // manual_discount are snake_case, finalTotal stays camelCase), since
  // Appointments.jsx's completePaymentWithCoupon reads these fields
  // directly off the returned payload by these exact names.
  ipcMain.handle("get-appointment-invoice-payload", async (_event, appointmentId) => {
    try {
      const result = await saasClient.getAppointmentInvoicePayload(appointmentId);
      const p = result.data;
      return {
        success: true,
        payload: {
          invoice_no: p.invoiceNo,
          billing_id: p.billingId,
          line_items: p.lineItems,
          subtotal: p.subtotal,
          coupon_discount: p.couponDiscount,
          manual_discount: p.manualDiscount,
          finalTotal: p.finalTotal,
          coupon: p.coupon,
          totalPaid: p.totalPaid,
          remaining: p.remaining,
        },
      };
    } catch (err) {
      console.error("[get-appointment-invoice-payload]", err);
      return { success: false, payload: null };
    }
  });

  // Draft-only — no DB writes at all (backend's /api/billing/preview
  // matches this exactly), PDF saved to the OS temp dir.
  ipcMain.handle("preview-billing-invoice", async (_event, { cart, subtotal, discount, manualDiscountAmount, finalTotal, coupon, customerName, customerPhone }) => {
    try {
      const result = await saasClient.previewBillingInvoice({
        cart: cart.map((item) => ({ id: item.id, cartQty: item.cartQty, price: item.price, total: item.total })),
        subtotal,
        discount,
        manualDiscountAmount,
        finalTotal,
        coupon: coupon || undefined,
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
      });

      const use12HourTime = store.get("use12HourTime", false);
      const now = new Date();
      const invoiceData = {
        invoice_no: "DRAFT",
        billing_date: formatDate(now.toISOString().slice(0, 10)),
        billing_time: formatTime(`${now.getHours()}:${now.getMinutes()}`, use12HourTime),
        cart: cart.map((item) => ({ name: item.name, cartQty: item.cartQty, price: item.price, total: item.total })),
        subtotal: result.data.subtotal,
        discount: result.data.discount,
        finalTotal: result.data.finalTotal,
        coupon: coupon || "",
        customer: customerName || customerPhone ? { client_name: customerName || "", contact_number: customerPhone || "" } : null,
        branding: await buildBranding(store),
        use12HourTime,
      };

      const filePath = path.join(app.getPath("temp"), `DraftInvoice_${Date.now()}.pdf`);
      await generateInvoicePDF(invoiceData, filePath);
      return { success: true, pdfPath: filePath };
    } catch (err) {
      console.error("[preview-billing-invoice]", err);
      return { success: false, message: err.message };
    }
  });

  // Formerly "Custom Invoice" — renamed to match the legacy single-tenant
  // EMR's own "Quick Bill" feature this now mirrors (see QuickBill.jsx).
  // The backend record/table/API this saves to is still literally named
  // CustomInvoice — deliberate, storage stays exactly where it already was;
  // only the user-facing name and this IPC channel's own name changed.
  //
  // Not tied to any Client/Pet/Appointment row. Returns raw PDF bytes (not
  // a path) since it's meant to be handed straight to the renderer for
  // print-preview/download. Totals/cart are computed locally rather than
  // trusting the API round-trip for them, because persisting the invoice
  // (saasClient.generateQuickBill, below) must never be able to block
  // or fail this handler — the invoice still gets generated/printed/sent
  // even if the save-to-database call errors out; it just won't show up
  // later in the Payments screen's Quick Bills tab (and, if a line item
  // was a real product, its stock won't decrement either — that only
  // happens as part of the same persist transaction).
  //
  // couponDiscountType/couponDiscountValue are the raw values from an
  // earlier apply-coupon call (QuickBill.jsx applies the coupon as its own
  // separate step, same pattern Billing.jsx's walk-in POS screen already
  // uses), so the PDF's numbers are fully known client-side before this
  // handler ever calls the backend — the persist call only needs to happen
  // at all for the DB write and stock decrement, never for anything the
  // PDF itself displays.
  ipcMain.handle("generate-quick-bill", async (_event, {
    customer, client_id, line_items, couponCode, couponDiscountType, couponDiscountValue,
    manualDiscountAmount, paymentMode, amount,
  }) => {
    try {
      const apiPaymentMode = paymentMode ? PAYMENT_MODE_TO_API[paymentMode] || null : null;

      const cart = line_items.map((item) => {
        const qty = parseFloat(item.quantity) || 0;
        const price = parseFloat(item.price) || 0;
        return { name: item.name || "", cartQty: qty, price, total: qty * price, productId: item.product_id || null };
      });
      const subtotal = Math.round(cart.reduce((sum, item) => sum + item.total, 0));

      let couponDiscount = 0;
      if (couponCode && couponDiscountType) {
        couponDiscount = couponDiscountType === "PERCENT"
          ? (subtotal * (parseFloat(couponDiscountValue) || 0)) / 100
          : parseFloat(couponDiscountValue) || 0;
      }
      const manualDiscount = Math.min(
        Math.max(0, parseFloat(manualDiscountAmount) || 0),
        Math.max(0, subtotal - couponDiscount),
      );
      const discount = Math.round(couponDiscount + manualDiscount);
      const finalTotal = Math.max(0, subtotal - discount);

      // No paymentMode chosen at all -> nothing recorded, treated as fully
      // settled (the original Custom Invoice's only behavior, preserved
      // exactly). paymentMode chosen -> amount may be 0/partial/full.
      let amountPaid = finalTotal;
      if (paymentMode) {
        const amountRaw = amount === undefined || amount === null || amount === "" ? finalTotal : parseFloat(amount);
        amountPaid = Math.min(Math.max(0, Number.isNaN(amountRaw) ? finalTotal : amountRaw), finalTotal);
      }

      // QB- (not CUSTOM-): matches the backend's own displayed invoice
      // number now (billing.service.ts derives `QB-${invoice.id}`) — this
      // is only ever seen if the persist call below fails, so the number
      // on-screen never contradicts what a successful save would have shown.
      let invoiceNo = `QB-${Date.now()}`;
      try {
        const result = await saasClient.generateQuickBill({
          customerName: customer?.client_name || undefined,
          customerPhone: customer?.contact_number || undefined,
          petName: customer?.pet_name || undefined,
          clientId: client_id || undefined,
          lineItems: line_items.map((li) => ({
            name: li.name, quantity: li.quantity, price: li.price, productId: li.product_id || undefined,
          })),
          couponCode: couponCode || undefined,
          manualDiscountAmount: manualDiscountAmount || undefined,
          paymentMode: apiPaymentMode || undefined,
          amountPaid: paymentMode ? amountPaid : undefined,
        });
        invoiceNo = result.data.invoiceNo;
      } catch (persistErr) {
        console.error("[generate-quick-bill] failed to save record (invoice still generated):", persistErr);
      }

      // buildBranding() itself calls the API (saasClient.getMyClinic()) —
      // a total API outage (not just the persist call above) must still
      // never block PDF generation, so this gets the exact same
      // catch-and-fall-back treatment, not just the save call.
      let branding;
      try {
        branding = await buildBranding(store);
      } catch (brandingErr) {
        console.error("[generate-quick-bill] failed to fetch branding (using fallback):", brandingErr);
        branding = { clinicName: "My Clinic", color: null, logoPath: null, address: "", phone: "", bankName: null, bankAccount: null, pos: {} };
      }

      const use12HourTime = store.get("use12HourTime", false);
      const now = new Date();
      const invoiceData = {
        invoice_no: invoiceNo,
        item_column_label: "Description",
        billing_date: formatDate(now.toISOString().slice(0, 10)),
        billing_time: formatTime(`${now.getHours()}:${now.getMinutes()}`, use12HourTime),
        cart,
        subtotal,
        discount,
        finalTotal,
        coupon: couponCode || "",
        customer: (customer?.client_name || customer?.contact_number || customer?.pet_name)
          ? {
              client_name: customer.client_name || "",
              contact_number: customer.contact_number || "",
              pet_name: customer.pet_name || "",
            }
          : null,
        partialPayment: paymentMode && amountPaid < finalTotal
          ? { totalPaid: amountPaid, remaining: finalTotal - amountPaid }
          : null,
        branding,
        use12HourTime,
      };

      const filePath = path.join(app.getPath("temp"), `QuickBill_${Date.now()}.pdf`);
      await generateInvoicePDF(invoiceData, filePath);
      const data = await fs.promises.readFile(filePath);
      return { success: true, data, finalTotal, amountPaid };
    } catch (err) {
      console.error("[generate-quick-bill]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("get-quick-bills", async (_event, { page = 1, limit = 10, search = "" } = {}) => {
    try {
      const result = await saasClient.listQuickBills({ page, pageSize: limit, search: search || undefined });
      const quickBills = result.data.map((inv) => ({
        id: inv.id,
        invoice_no: inv.invoiceNo,
        client_id: inv.clientId,
        customer_name: inv.customerName,
        customer_phone: inv.customerPhone,
        pet_name: inv.petName,
        subtotal: inv.subtotal,
        discount_amount: inv.discountAmount,
        coupon_code: inv.couponCode,
        total: inv.total,
        payment_mode: inv.paymentMode ? PAYMENT_MODE_TO_LOCAL[inv.paymentMode] || inv.paymentMode : null,
        amount_paid: inv.amountPaid,
        status: STATUS_TO_LOCAL[inv.status] || inv.status,
        created_at: inv.createdAt,
        items: inv.items.map((i) => ({
          id: i.id,
          product_id: i.productId,
          name: i.name,
          quantity: i.quantity,
          price: i.price,
          total: i.total,
        })),
      }));
      return { success: true, quickBills, total: result.total, totalPages: result.totalPages };
    } catch (err) {
      console.error("[get-quick-bills]", err);
      return { success: false, message: err.message, quickBills: [], total: 0, totalPages: 1 };
    }
  });

  function mapQuickBillDTO(inv) {
    return {
      id: inv.id,
      invoice_no: inv.invoiceNo,
      client_id: inv.clientId,
      customer_name: inv.customerName,
      customer_phone: inv.customerPhone,
      pet_name: inv.petName,
      subtotal: inv.subtotal,
      discount_amount: inv.discountAmount,
      coupon_code: inv.couponCode,
      total: inv.total,
      payment_mode: inv.paymentMode ? PAYMENT_MODE_TO_LOCAL[inv.paymentMode] || inv.paymentMode : null,
      amount_paid: inv.amountPaid,
      status: STATUS_TO_LOCAL[inv.status] || inv.status,
      created_at: inv.createdAt,
      items: inv.items.map((i) => ({
        id: i.id,
        product_id: i.productId,
        name: i.name,
        quantity: i.quantity,
        price: i.price,
        total: i.total,
      })),
    };
  }

  // Full-replace update — reuses the exact same request-body shape as
  // generate-quick-bill (customer/line_items/coupon/manualDiscountAmount/
  // paymentMode/amount), sent straight through to the backend's PATCH
  // endpoint, which reverses the old stock/coupon effects and recomputes
  // from scratch server-side (see billing.service.ts::updateCustomInvoice).
  ipcMain.handle("update-quick-bill", async (_event, {
    id, customer, client_id, line_items, couponCode, manualDiscountAmount, paymentMode, amount,
  }) => {
    try {
      const apiPaymentMode = paymentMode ? PAYMENT_MODE_TO_API[paymentMode] || null : null;
      const result = await saasClient.updateQuickBill(id, {
        customerName: customer?.client_name || undefined,
        customerPhone: customer?.contact_number || undefined,
        petName: customer?.pet_name || undefined,
        clientId: client_id || undefined,
        lineItems: line_items.map((li) => ({
          name: li.name, quantity: li.quantity, price: li.price, productId: li.product_id || undefined,
        })),
        couponCode: couponCode || undefined,
        manualDiscountAmount: manualDiscountAmount || undefined,
        paymentMode: apiPaymentMode || undefined,
        amountPaid: paymentMode ? amount : undefined,
      });
      return { success: true, quickBill: mapQuickBillDTO(result.data) };
    } catch (err) {
      console.error("[update-quick-bill]", err);
      return { success: false, message: err.message };
    }
  });

  // Reverses the stock decrement and coupon usage the invoice caused at
  // creation time, then removes it — see billing.service.ts::deleteCustomInvoice.
  ipcMain.handle("delete-quick-bill", async (_event, { id }) => {
    try {
      await saasClient.deleteQuickBill(id);
      return { success: true };
    } catch (err) {
      console.error("[delete-quick-bill]", err);
      return { success: false, message: err.message };
    }
  });
};
