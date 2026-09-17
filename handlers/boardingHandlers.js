const { ipcMain, app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { generateBoardingSummaryPDF } = require("../boardingSummaryPDF");
const { printGeneratedPdf, generateBoardingConsentFormPDF } = require("../generate_invoice");
const { formatDate, toCalendarDateKey, resolveApiBranding } = require("./utils");
const saasClient = require("./saasClient");

// Boarding — backed by the multi-tenant API's /api/boarding/*. PDF
// rendering (consent form, hospitalization/daily summary) stays 100%
// desktop-side, matching every other document in this app — the backend
// only ever returns structured payload data, never a file.

const PAYMENT_MODE_TO_API = { Cash: "CASH", "Card Payment": "CARD_PAYMENT", "Bank Transfer": "BANK_TRANSFER" };
const PAYMENT_MODE_TO_LOCAL = { CASH: "Cash", CARD_PAYMENT: "Card Payment", BANK_TRANSFER: "Bank Transfer" };

async function buildBranding(store) {
  const clinic = await saasClient.getMyClinic();
  return resolveApiBranding(store, clinic.clinic);
}

function toLocalStay(s) {
  return {
    id: s.id,
    branch_id: s.branchId,
    pet_id: s.petId,
    pet_name: s.petName,
    species: s.species,
    breed: s.breed,
    is_neutered: s.isNeutered,
    client_id: s.clientId,
    client_name: s.clientName,
    contact_number: s.contactNumber,
    cage_unit_id: s.cageUnitId,
    cage_label: s.cageLabel,
    type_name: s.cageTypeName,
    is_free_area: s.isFreeArea,
    service_id: s.serviceId,
    service_name: s.serviceName,
    service_rate: s.serviceRate,
    date_in: s.dateIn,
    date_out: s.dateOut,
    expected_checkout_date: s.expectedCheckoutDate,
    purpose: s.purpose === "HOSPITALIZATION" ? s.hospitalizationPurpose : s.purpose,
    requires_monitoring: s.requiresMonitoring,
    notes: s.notes,
    feeding_interval_minutes: s.feedingIntervalMinutes,
    monitoring_interval_minutes: s.monitoringIntervalMinutes,
    needs_vaccination: s.needsVaccination,
    needs_deworming: s.needsDeworming,
    owner_provides_food: s.ownerProvidesFood,
    billing_id: s.billingId,
    amount_paid: s.amountPaid,
    payment_mode: s.paymentMode ? PAYMENT_MODE_TO_LOCAL[s.paymentMode] || s.paymentMode : null,
  };
}

function toLocalSpaceType(t) {
  return {
    id: t.id,
    branch_id: t.branchId,
    type_name: t.typeName,
    quantity: t.quantity,
    is_free_area: t.isFreeArea,
    active_unit_count: t.activeUnitCount,
  };
}

function toLocalSpaceUnit(u) {
  return {
    id: u.id,
    cage_type_id: u.cageTypeId,
    type_name: u.typeName,
    is_free_area: u.isFreeArea,
    unit_label: u.unitLabel,
  };
}

function toLocalUnitWithStatus(u) {
  return {
    ...toLocalSpaceUnit(u),
    stay_id: u.stayId,
    pet_id: u.petId,
    pet_name: u.petName,
    species: u.species,
    is_neutered: u.isNeutered,
    client_name: u.clientName,
    contact_number: u.contactNumber,
    date_in: u.dateIn,
    expected_checkout_date: u.expectedCheckoutDate,
    requires_monitoring: u.requiresMonitoring,
    needs_vaccination: u.needsVaccination,
    needs_deworming: u.needsDeworming,
    owner_provides_food: u.ownerProvidesFood,
    active_checkout_today: u.activeCheckoutToday,
  };
}

function toLocalCareLogEntry(e) {
  return {
    id: e.id,
    stay_id: e.stayId,
    log_type: e.logType,
    logged_at: e.loggedAt,
    logged_by: e.loggedBy,
    notes: e.notes,
    medication_id: e.medicationId,
    medication_name: e.medicationName,
    product_id: e.productId,
    item_name: e.itemName,
    display_name: e.displayName,
    quantity: e.quantity,
    price: e.price,
  };
}

function toLocalMedication(m) {
  return {
    id: m.id,
    stay_id: m.stayId,
    drug_name: m.drugName,
    dose: m.dose,
    interval_minutes: m.intervalMinutes,
    is_active: m.isActive,
    started_at: m.startedAt,
    discontinued_at: m.discontinuedAt,
    price: m.price,
    product_id: m.productId,
    quantity: m.quantity,
  };
}

function extractNumericSuffix(label) {
  const match = (label || "").match(/(\d+)(?!.*\d)/);
  return match ? parseInt(match[1], 10) : Infinity;
}

function sortUnitsByLabel(units) {
  return [...units].sort((a, b) => {
    const aNum = extractNumericSuffix(a.unit_label || a.unitLabel);
    const bNum = extractNumericSuffix(b.unit_label || b.unitLabel);
    if (aNum !== bNum) return aNum - bNum;
    return (a.unit_label || a.unitLabel).localeCompare(b.unit_label || b.unitLabel);
  });
}

module.exports = function setupBoardingHandlers(store) {
  // ── Cage/space configuration ──────────────────────────────────────────────
  ipcMain.handle("boarding-get-cage-types", async () => {
    try {
      const result = await saasClient.listBoardingSpaceTypes();
      return { success: true, cageTypes: result.data.map(toLocalSpaceType) };
    } catch (err) {
      console.error("[boarding-get-cage-types]", err);
      return { success: false, message: err.message, cageTypes: [] };
    }
  });

  ipcMain.handle("boarding-add-cage-type", async (_event, { type_name, quantity, is_free_area, branch_id } = {}) => {
    try {
      const result = await saasClient.createBoardingSpaceType({
        typeName: type_name || undefined,
        quantity: quantity ?? 0,
        isFreeArea: !!is_free_area,
        branchId: branch_id || undefined,
      });
      return { success: true, cageType: toLocalSpaceType(result.data) };
    } catch (err) {
      console.error("[boarding-add-cage-type]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-update-cage-type", async (_event, { id, type_name, quantity } = {}) => {
    try {
      const result = await saasClient.updateBoardingSpaceType(id, {
        ...(type_name !== undefined ? { typeName: type_name } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
      });
      return { success: true, cageType: toLocalSpaceType(result.data) };
    } catch (err) {
      console.error("[boarding-update-cage-type]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-delete-cage-type", async (_event, { id } = {}) => {
    try {
      await saasClient.deleteBoardingSpaceType(id);
      return { success: true };
    } catch (err) {
      console.error("[boarding-delete-cage-type]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-get-settings", async () => {
    try {
      const result = await saasClient.getBoardingSettings();
      return {
        success: true,
        settings: {
          feeding_interval_minutes: result.data.defaultFeedingIntervalMinutes,
          monitoring_interval_minutes: result.data.defaultMonitoringIntervalMinutes,
        },
      };
    } catch (err) {
      console.error("[boarding-get-settings]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-update-settings", async (_event, { feeding_interval_minutes, monitoring_interval_minutes } = {}) => {
    try {
      await saasClient.updateBoardingSettings({
        defaultFeedingIntervalMinutes: feeding_interval_minutes,
        defaultMonitoringIntervalMinutes: monitoring_interval_minutes,
      });
      return { success: true };
    } catch (err) {
      console.error("[boarding-update-settings]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-get-cage-units", async () => {
    try {
      const result = await saasClient.listBoardingSpaceUnits();
      const units = result.data.map(toLocalSpaceUnit);
      return { success: true, units: sortUnitsByLabel(units) };
    } catch (err) {
      console.error("[boarding-get-cage-units]", err);
      return { success: false, message: err.message, units: [] };
    }
  });

  ipcMain.handle("boarding-get-free-units", async () => {
    try {
      const result = await saasClient.listFreeBoardingUnits();
      const units = result.data.map(toLocalSpaceUnit);
      return { success: true, units: sortUnitsByLabel(units) };
    } catch (err) {
      console.error("[boarding-get-free-units]", err);
      return { success: false, message: err.message, units: [] };
    }
  });

  ipcMain.handle("boarding-get-cage-units-with-status", async () => {
    try {
      const result = await saasClient.listBoardingSpaceUnitsWithStatus();
      const units = result.data.map(toLocalUnitWithStatus);
      return { success: true, units: sortUnitsByLabel(units) };
    } catch (err) {
      console.error("[boarding-get-cage-units-with-status]", err);
      return { success: false, message: err.message, units: [] };
    }
  });

  // ── Stay lifecycle ────────────────────────────────────────────────────────
  ipcMain.handle("boarding-create-stay", async (_event, payload = {}) => {
    try {
      const requiresMonitoring = !!payload.requires_monitoring;
      const result = await saasClient.checkInBoardingStay({
        petId: payload.pet_id,
        cageUnitId: payload.cage_unit_id,
        serviceId: payload.service_id || undefined,
        dateIn: payload.date_in,
        expectedCheckoutDate: payload.expected_checkout_date || undefined,
        requiresMonitoring,
        purposeText: payload.purpose || undefined,
        notes: payload.notes || undefined,
        needsVaccination: !!payload.needs_vaccination,
        needsDeworming: !!payload.needs_deworming,
        ownerProvidesFood: !!payload.owner_provides_food,
        feedingIntervalMinutes: payload.feeding_interval_minutes || undefined,
        monitoringIntervalMinutes: requiresMonitoring ? payload.monitoring_interval_minutes || undefined : undefined,
        branchId: payload.branch_id || undefined,
      });
      const stay = toLocalStay(result.data);

      // Best-effort — a consent-form failure never fails check-in itself,
      // matching legacy exactly. Auto-saves to Documents unconditionally.
      try {
        await saveBoardingConsentFormToDocuments(store, stay.id);
      } catch (pdfErr) {
        console.error("[boarding-create-stay] failed to auto-save consent form:", pdfErr);
      }

      return { success: true, stay };
    } catch (err) {
      console.error("[boarding-create-stay]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-get-stay", async (_event, { id } = {}) => {
    try {
      const result = await saasClient.getBoardingStay(id);
      return { success: true, stay: toLocalStay(result.data) };
    } catch (err) {
      console.error("[boarding-get-stay]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-update-stay", async (_event, { id, ...payload } = {}) => {
    try {
      const result = await saasClient.updateBoardingStay(id, {
        ...(payload.date_in !== undefined ? { dateIn: payload.date_in } : {}),
        ...(payload.expected_checkout_date !== undefined ? { expectedCheckoutDate: payload.expected_checkout_date || null } : {}),
        ...(payload.service_id !== undefined ? { serviceId: payload.service_id || null } : {}),
        ...(payload.purpose !== undefined ? { purposeText: payload.purpose } : {}),
        ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
        ...(payload.needs_vaccination !== undefined ? { needsVaccination: !!payload.needs_vaccination } : {}),
        ...(payload.needs_deworming !== undefined ? { needsDeworming: !!payload.needs_deworming } : {}),
        ...(payload.owner_provides_food !== undefined ? { ownerProvidesFood: !!payload.owner_provides_food } : {}),
        ...(payload.feeding_interval_minutes !== undefined ? { feedingIntervalMinutes: payload.feeding_interval_minutes || null } : {}),
        ...(payload.monitoring_interval_minutes !== undefined ? { monitoringIntervalMinutes: payload.monitoring_interval_minutes || null } : {}),
      });
      return { success: true, stay: toLocalStay(result.data) };
    } catch (err) {
      console.error("[boarding-update-stay]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-delete-stay", async (_event, { id } = {}) => {
    try {
      await saasClient.deleteBoardingStay(id);
      return { success: true };
    } catch (err) {
      console.error("[boarding-delete-stay]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-preview-checkout-billing", async (_event, { id } = {}) => {
    try {
      const result = await saasClient.previewBoardingCheckout(id);
      return {
        success: true,
        nights: result.data.nights,
        service: result.data.serviceName ? { name: result.data.serviceName, rate: result.data.serviceRate } : null,
      };
    } catch (err) {
      console.error("[boarding-preview-checkout-billing]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-checkout-stay", async (_event, { stay_id, date_out } = {}) => {
    try {
      const result = await saasClient.checkoutBoardingStay(stay_id, date_out ? { dateOut: date_out } : {});
      return {
        success: true,
        message: "Checked out",
        nights: result.data.nights,
        service: result.data.serviceName ? { name: result.data.serviceName, rate: result.data.serviceRate } : null,
        branch_id: result.data.branchId,
      };
    } catch (err) {
      console.error("[boarding-checkout-stay]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-get-active-stays", async (_event, { search, spaceTypeId, purpose } = {}) => {
    try {
      const result = await saasClient.listActiveBoardingStays({ search, spaceTypeId, purpose });
      return { success: true, stays: result.data.map(toLocalStay) };
    } catch (err) {
      console.error("[boarding-get-active-stays]", err);
      return { success: false, message: err.message, stays: [] };
    }
  });

  ipcMain.handle("boarding-get-stays-for-pet", async (_event, { pet_id } = {}) => {
    try {
      const result = await saasClient.listBoardingStaysForPet(pet_id);
      return { success: true, stays: result.data.map(toLocalStay) };
    } catch (err) {
      console.error("[boarding-get-stays-for-pet]", err);
      return { success: false, message: err.message, stays: [] };
    }
  });

  // ── Care log (feeding) ────────────────────────────────────────────────────
  ipcMain.handle("boarding-log-feeding", async (_event, { stay_id, product_id, item_name, quantity, price, notes, logged_by } = {}) => {
    try {
      const result = await saasClient.logBoardingFeeding(stay_id, {
        productId: product_id || undefined,
        itemName: item_name || undefined,
        quantity: quantity || undefined,
        price: price ?? undefined,
        notes: notes || undefined,
        loggedBy: logged_by || undefined,
      });
      return { success: true, entry: toLocalCareLogEntry(result.data) };
    } catch (err) {
      console.error("[boarding-log-feeding]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-get-care-log", async (_event, { stay_id } = {}) => {
    try {
      const result = await saasClient.listBoardingCareLog(stay_id);
      return { success: true, entries: result.data.map(toLocalCareLogEntry) };
    } catch (err) {
      console.error("[boarding-get-care-log]", err);
      return { success: false, message: err.message, entries: [] };
    }
  });

  // ── Vitals (delegates to the shared SoapNote module) ─────────────────────
  ipcMain.handle("boarding-get-vitals-history", async (_event, { stay_id } = {}) => {
    try {
      const result = await saasClient.listSoapNotesByBoardingStay(stay_id);
      return { success: true, notes: result.data };
    } catch (err) {
      console.error("[boarding-get-vitals-history]", err);
      return { success: false, message: err.message, notes: [] };
    }
  });

  ipcMain.handle("boarding-has-vitals-check", async (_event, { stay_id } = {}) => {
    try {
      const result = await saasClient.hasBoardingVitalsCheck(stay_id);
      return { success: true, hasVitalsCheck: !!result.data };
    } catch (err) {
      console.error("[boarding-has-vitals-check]", err);
      return { success: false, message: err.message, hasVitalsCheck: false };
    }
  });

  // ── Medications ────────────────────────────────────────────────────────────
  ipcMain.handle("boarding-add-medication", async (_event, { stay_id, drug_name, dose, interval_minutes, product_id, quantity, price } = {}) => {
    try {
      const result = await saasClient.addBoardingMedication(stay_id, {
        drugName: drug_name,
        dose: dose || undefined,
        intervalMinutes: interval_minutes || undefined,
        productId: product_id || undefined,
        quantity: quantity || undefined,
        price: price ?? undefined,
      });
      return { success: true, medication: toLocalMedication(result.data) };
    } catch (err) {
      console.error("[boarding-add-medication]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-get-medications", async (_event, { stay_id } = {}) => {
    try {
      const result = await saasClient.listBoardingMedications(stay_id);
      return { success: true, medications: result.data.map(toLocalMedication) };
    } catch (err) {
      console.error("[boarding-get-medications]", err);
      return { success: false, message: err.message, medications: [] };
    }
  });

  ipcMain.handle("boarding-log-medication-administered", async (_event, { medication_id, notes } = {}) => {
    try {
      const result = await saasClient.markBoardingMedicationGiven(medication_id, { notes: notes || undefined });
      return { success: true, entry: toLocalCareLogEntry(result.data) };
    } catch (err) {
      console.error("[boarding-log-medication-administered]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-discontinue-medication", async (_event, { medication_id } = {}) => {
    try {
      await saasClient.discontinueBoardingMedication(medication_id);
      return { success: true };
    } catch (err) {
      console.error("[boarding-discontinue-medication]", err);
      return { success: false, message: err.message };
    }
  });

  // ── Checkout billing ──────────────────────────────────────────────────────
  ipcMain.handle("record-boarding-payment", async (_event, { stay_id, amount, payment_mode, coupon_code, manual_discount_percent, manual_discount_fixed, products_cart } = {}) => {
    try {
      const result = await saasClient.recordBoardingPayment(stay_id, {
        amount,
        paymentMode: PAYMENT_MODE_TO_API[payment_mode] || payment_mode,
        couponCode: coupon_code || undefined,
        manualDiscountPercent: manual_discount_percent || 0,
        manualDiscountFixed: manual_discount_fixed || 0,
        productsCart: (products_cart || []).map((c) => ({ productId: c.id, cartQty: c.cartQty, price: c.price, total: c.total })),
      });

      // Best-effort — auto-saves the checkout invoice PDF unconditionally,
      // reflecting the actual discount applied, matching legacy exactly.
      try {
        await saveBoardingCheckoutInvoiceToDocuments(store, stay_id, result.data);
      } catch (pdfErr) {
        console.error("[record-boarding-payment] failed to auto-save invoice:", pdfErr);
      }

      return { success: true, ...result.data };
    } catch (err) {
      console.error("[record-boarding-payment]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-save-checkout-invoice", async (_event, { stay_id } = {}) => {
    try {
      const stay = await saasClient.getBoardingStay(stay_id);
      const filePath = await saveBoardingCheckoutInvoiceToDocuments(store, stay_id, {
        finalTotal: stay.data.amountPaid,
        amountPaid: stay.data.amountPaid,
      });
      return { success: true, filePath };
    } catch (err) {
      console.error("[boarding-save-checkout-invoice]", err);
      return { success: false, message: err.message };
    }
  });

  // ── Checkout invoice preview (pre-payment) ──────────────────────────────────
  // Distinct from boarding-save-checkout-invoice above, which only runs
  // AFTER a payment is recorded and writes straight to Documents. This one
  // lets the user preview the invoice from step 2 of checkout, before
  // completing payment — mirroring the Preview Hospitalization Summary
  // pattern below. Cart/subtotal/discount are computed client-side in
  // BoardingCheckoutModal.jsx (same numbers shown in the payment step) and
  // passed straight through, matching how the desktop already treats
  // discount math elsewhere as frontend-owned.
  ipcMain.handle(
    "boarding-preview-checkout-invoice",
    async (_event, { stay_id, cart, subtotal, discount, coupon_label, final_total } = {}) => {
      try {
        const data = await bytesForCheckoutInvoice(store, stay_id, {
          cart,
          subtotal,
          discount,
          couponLabel: coupon_label,
          finalTotal: final_total,
        });
        return { success: true, data };
      } catch (err) {
        console.error("[boarding-preview-checkout-invoice]", err);
        return { success: false, message: err.message };
      }
    },
  );

  ipcMain.handle(
    "boarding-print-checkout-invoice",
    async (_event, { stay_id, cart, subtotal, discount, coupon_label, final_total } = {}) => {
      try {
        const filePath = path.join(app.getPath("temp"), `BoardingCheckoutInvoicePreview_${stay_id}_${Date.now()}.pdf`);
        await writeCheckoutInvoicePdf(
          store,
          stay_id,
          { cart, subtotal, discount, couponLabel: coupon_label, finalTotal: final_total },
          filePath,
        );
        return printGeneratedPdf(filePath);
      } catch (err) {
        console.error("[boarding-print-checkout-invoice]", err);
        return { success: false, error: err.message };
      }
    },
  );

  // ── Consent form ───────────────────────────────────────────────────────────
  ipcMain.handle("boarding-preview-consent-form", async (_event, { stay_id } = {}) => {
    try {
      const data = await bytesForConsentForm(store, stay_id, false);
      return { success: true, data };
    } catch (err) {
      console.error("[boarding-preview-consent-form]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-print-consent-form", async (_event, { stay_id } = {}) => {
    try {
      const filePath = path.join(app.getPath("temp"), `BoardingConsent_${stay_id}_${Date.now()}.pdf`);
      await writeBoardingConsentFormPdf(store, stay_id, filePath);
      return printGeneratedPdf(filePath);
    } catch (err) {
      console.error("[boarding-print-consent-form]", err);
      return { success: false, error: err.message };
    }
  });

  // ── Hospitalization / Daily summary ───────────────────────────────────────
  ipcMain.handle("boarding-preview-hospitalization-summary", async (_event, { stay_id } = {}) => {
    try {
      const data = await bytesForSummary(store, stay_id, { dailyOnly: false });
      return { success: true, data };
    } catch (err) {
      console.error("[boarding-preview-hospitalization-summary]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-print-hospitalization-summary", async (_event, { stay_id } = {}) => {
    try {
      const filePath = path.join(app.getPath("temp"), `HospitalizationSummary_${stay_id}_${Date.now()}.pdf`);
      await writeBoardingSummaryPdf(store, stay_id, { dailyOnly: false }, filePath);
      return printGeneratedPdf(filePath);
    } catch (err) {
      console.error("[boarding-print-hospitalization-summary]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("boarding-preview-daily-summary", async (_event, { stay_id, date_from, date_to } = {}) => {
    try {
      const data = await bytesForSummary(store, stay_id, { dailyOnly: true, from: date_from, to: date_to });
      return { success: true, data };
    } catch (err) {
      console.error("[boarding-preview-daily-summary]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("boarding-print-daily-summary", async (_event, { stay_id, date_from, date_to } = {}) => {
    try {
      const filePath = path.join(app.getPath("temp"), `DailySummary_${stay_id}_${Date.now()}.pdf`);
      await writeBoardingSummaryPdf(store, stay_id, { dailyOnly: true, from: date_from, to: date_to }, filePath);
      return printGeneratedPdf(filePath);
    } catch (err) {
      console.error("[boarding-print-daily-summary]", err);
      return { success: false, error: err.message };
    }
  });

  // ── Local helpers (closures over `store`) ─────────────────────────────────
  async function buildConsentFormData(stayId) {
    const payload = await saasClient.getBoardingConsentPayload(stayId);
    const d = payload.data;
    const branding = await buildBranding(store);
    return {
      owner: { name: d.ownerName, phone: d.ownerPhone, address: d.ownerAddress },
      pet: { name: d.petName, species: d.species, breed: d.breed, color: d.color, sex: d.sex, is_neutered: d.isNeutered },
      drop_off_date: d.dropOffDate ? formatDate(toCalendarDateKey(new Date(d.dropOffDate))) : "",
      pick_up_date: d.pickupDate ? formatDate(toCalendarDateKey(new Date(d.pickupDate))) : "",
      needs_vaccination: d.needsVaccination,
      needs_deworming: d.needsDeworming,
      owner_provides_food: false,
      generated_on: formatDate(toCalendarDateKey(new Date())),
      branding,
    };
  }

  async function writeBoardingConsentFormPdf(storeInst, stayId, filePath) {
    const data = await buildConsentFormData(stayId);
    await generateBoardingConsentFormPDF(data, filePath);
    return filePath;
  }

  async function bytesForConsentForm(storeInst, stayId) {
    const filePath = path.join(app.getPath("temp"), `BoardingConsentPreview_${stayId}_${Date.now()}.pdf`);
    await writeBoardingConsentFormPdf(storeInst, stayId, filePath);
    const bytes = await fs.promises.readFile(filePath);
    return bytes;
  }

  async function saveBoardingConsentFormToDocuments(storeInst, stayId) {
    const dir = path.join(app.getPath("documents"), "PetVet-Boarding-Consent-Forms");
    await fs.promises.mkdir(dir, { recursive: true });
    const data = await buildConsentFormData(stayId);
    const safeName = (data.pet?.name || "pet").replace(/[^a-z0-9_-]/gi, "_");
    const filePath = path.join(dir, `BoardingConsentForm_${safeName}_${stayId}_${Date.now()}.pdf`);
    await generateBoardingConsentFormPDF(data, filePath);
    return filePath;
  }

  async function buildSummaryData(stayId, { dailyOnly, from, to }) {
    const payload = await saasClient.getBoardingSummaryPayload(stayId, { dailyOnly, from, to });
    const d = payload.data;
    const branding = await buildBranding(store);
    return {
      branch_id: d.branchId,
      pet_name: d.petName,
      client_name: d.clientName,
      cage_label: d.cageLabel,
      date_in: d.dateIn ? formatDate(toCalendarDateKey(new Date(d.dateIn))) : "",
      date_out: d.dateOut ? formatDate(toCalendarDateKey(new Date(d.dateOut))) : "",
      diagnosis: d.diagnosis,
      condition_status: d.conditionStatus,
      is_daily_summary: d.isDailySummary,
      summary_date_from: d.summaryDateFrom ? toCalendarDateKey(new Date(d.summaryDateFrom)) : null,
      summary_date_to: d.summaryDateTo ? toCalendarDateKey(new Date(d.summaryDateTo)) : null,
      timeline: (d.timeline || []).map((t) => ({
        type: t.type,
        timestamp: formatDate(toCalendarDateKey(new Date(t.timestamp))) + " " + new Date(t.timestamp).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" }),
        description: t.description,
        loggedBy: t.loggedBy,
      })),
      generated_on: formatDate(toCalendarDateKey(new Date())),
      branding,
    };
  }

  async function writeBoardingSummaryPdf(storeInst, stayId, opts, filePath) {
    const data = await buildSummaryData(stayId, opts);
    await generateBoardingSummaryPDF(data, filePath);
    return filePath;
  }

  async function bytesForSummary(storeInst, stayId, opts) {
    const filePath = path.join(app.getPath("temp"), `BoardingSummaryPreview_${stayId}_${Date.now()}.pdf`);
    await writeBoardingSummaryPdf(storeInst, stayId, opts, filePath);
    const bytes = await fs.promises.readFile(filePath);
    return bytes;
  }

  async function saveBoardingCheckoutInvoiceToDocuments(storeInst, stayId, paymentResult) {
    const stay = await saasClient.getBoardingStay(stayId);
    const branding = await buildBranding(storeInst);
    const d = stay.data;
    const dir = path.join(app.getPath("documents"), "PetVet-Invoices");
    await fs.promises.mkdir(dir, { recursive: true });
    const invoiceData = {
      invoice_no: `BRD-${d.billingId ?? d.id}`,
      item_column_label: "Description",
      billing_date: formatDate(toCalendarDateKey(new Date())),
      billing_time: new Date().toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" }),
      cart: [],
      subtotal: paymentResult.subtotal ?? d.amountPaid,
      discount: paymentResult.discount ?? 0,
      finalTotal: paymentResult.finalTotal ?? d.amountPaid,
      coupon: "",
      customer: { client_name: d.clientName, contact_number: d.contactNumber, pet_name: d.petName },
      branding,
    };
    const filePath = path.join(dir, `BoardingInvoice_${d.petName}_${stayId}_${Date.now()}.pdf`);
    const { generateInvoicePDF } = require("../generate_invoice");
    await generateInvoicePDF(invoiceData, filePath);
    return filePath;
  }

  // Preview-only counterpart to saveBoardingCheckoutInvoiceToDocuments —
  // called BEFORE payment is recorded, so there's no completed payment
  // result to read totals from. Takes the cart/subtotal/discount numbers
  // already computed client-side in BoardingCheckoutModal.jsx instead.
  async function buildCheckoutInvoiceData(stayId, { cart, subtotal, discount, couponLabel, finalTotal }) {
    const stay = await saasClient.getBoardingStay(stayId);
    const branding = await buildBranding(store);
    const d = stay.data;
    return {
      invoice_no: `BOARD-${stayId}`,
      item_column_label: "Description",
      billing_date: formatDate(toCalendarDateKey(new Date())),
      billing_time: new Date().toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" }),
      cart: cart || [],
      subtotal: subtotal ?? 0,
      discount: discount ?? 0,
      finalTotal: finalTotal ?? subtotal ?? 0,
      coupon: couponLabel || "",
      customer: { client_name: d.clientName, contact_number: d.contactNumber, pet_name: d.petName },
      branding,
    };
  }

  async function writeCheckoutInvoicePdf(storeInst, stayId, opts, filePath) {
    const invoiceData = await buildCheckoutInvoiceData(stayId, opts);
    const { generateInvoicePDF } = require("../generate_invoice");
    await generateInvoicePDF(invoiceData, filePath);
    return filePath;
  }

  async function bytesForCheckoutInvoice(storeInst, stayId, opts) {
    const filePath = path.join(app.getPath("temp"), `BoardingCheckoutInvoicePreview_${stayId}_${Date.now()}.pdf`);
    await writeCheckoutInvoicePdf(storeInst, stayId, opts, filePath);
    const bytes = await fs.promises.readFile(filePath);
    return bytes;
  }
};
