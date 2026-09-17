const { ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { generatePrescriptionPdf } = require("./prescriptionPdfHandler");
const { resolveApiBranding, downloadAndCacheLogo, saveLocalImage } = require("./utils");
const saasClient = require("./saasClient");

// Clinic-wide settings — backed by the multi-tenant API's PATCH
// /api/clinics/me. Replaces what used to be split across a local
// ClinicSettings table, a local ClinicBranding table, and per-machine
// electron-store (bank details/POS-slip toggles/time format) — every field
// now lives on the one Clinic row, so every employee's machine sees the
// same settings immediately after a save.
//
// 'update-profile' (a user's own name/username) lives in authHandlers.js
// instead — it's backed by PATCH /api/auth/me and needs to refresh the
// cached session the same way login/switch-clinic do.
module.exports = function setupSettingsHandlers(store) {
  ipcMain.handle("get-first-time-fee", async () => {
    try {
      const result = await saasClient.getMyClinic();
      const fee = parseFloat(result.clinic.firstTimeFee);
      return { success: true, firstTimeFee: isNaN(fee) ? 1050 : fee };
    } catch (err) {
      console.error("[get-first-time-fee]", err);
      return { success: true, firstTimeFee: 1050 };
    }
  });

  ipcMain.handle("set-first-time-fee", async (_event, fee) => {
    try {
      const value = parseFloat(fee);
      if (isNaN(value) || value < 0) {
        return { success: false, message: "Invalid fee amount" };
      }
      await saasClient.updateMyClinic({ firstTimeFee: value });
      return { success: true, message: "First-time fee updated successfully", firstTimeFee: value };
    } catch (err) {
      console.error("[set-first-time-fee]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("get-discount-range", async () => {
    try {
      const result = await saasClient.getMyClinic();
      return {
        success: true,
        min: parseFloat(result.clinic.discountMinPercent) || 1,
        max: parseFloat(result.clinic.discountMaxPercent) || 7,
      };
    } catch (err) {
      console.error("[get-discount-range]", err);
      return { success: true, min: 1, max: 7 };
    }
  });

  ipcMain.handle("set-discount-range", async (_event, { minPercent, maxPercent }) => {
    try {
      const min = parseFloat(minPercent);
      const max = parseFloat(maxPercent);
      if (isNaN(min) || isNaN(max) || min < 0 || max < 0 || min > max) {
        return { success: false, message: "Invalid discount range (min must be ≤ max)" };
      }
      await saasClient.updateMyClinic({ discountMinPercent: min, discountMaxPercent: max });
      return { success: true, message: "Discount range updated successfully" };
    } catch (err) {
      console.error("[set-discount-range]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("get-time-format", async () => {
    try {
      const result = await saasClient.getMyClinic();
      return { success: true, use12Hour: !!result.clinic.use12HourTime };
    } catch (err) {
      console.error("[get-time-format]", err);
      return { success: true, use12Hour: false };
    }
  });

  ipcMain.handle("set-time-format", async (_event, { use12Hour }) => {
    try {
      await saasClient.updateMyClinic({ use12HourTime: !!use12Hour });
      return { success: true };
    } catch (err) {
      console.error("[set-time-format]", err);
      return { success: false, message: err.message };
    }
  });

  // Bank details + POS-slip display toggles — now clinic-wide (on the
  // Clinic row) instead of per-machine electron-store.
  ipcMain.handle("set-branding-settings", async (_event, data) => {
    try {
      const pos = data?.pos || {};
      await saasClient.updateMyClinic({
        bankName: data?.bankName || null,
        bankAccountNumber: data?.bankAccount || null,
        posShowLogo: !!pos.showLogo,
        posShowClinicPhone: !!pos.showPhone,
        posShowClientPhone: !!pos.showClientPhone,
        posShowVetName: !!pos.showVet,
        posShowAddress: !!pos.showAddress,
        posShowBankDetails: !!pos.showBank,
        posHeaderShowClinicName: pos.headerStyle !== "invoice",
      });
      return { success: true };
    } catch (err) {
      console.error("[set-branding-settings]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("get-branding-settings", async () => {
    try {
      const result = await saasClient.getMyClinic();
      const c = result.clinic;
      return {
        success: true,
        branding: {
          bankName: c.bankName || "",
          bankAccount: c.bankAccountNumber || "",
          pos: {
            showLogo: c.posShowLogo,
            showPhone: c.posShowClinicPhone,
            showClientPhone: c.posShowClientPhone,
            showVet: c.posShowVetName,
            showAddress: c.posShowAddress,
            showBank: c.posShowBankDetails,
            headerStyle: c.posHeaderShowClinicName ? "clinicName" : "invoice",
          },
        },
      };
    } catch (err) {
      console.error("[get-branding-settings]", err);
      return { success: false };
    }
  });

  // Shared clinic branding — logo/name/color/address/phone/invoice grouping.
  ipcMain.handle("branding-get", async () => {
    try {
      const result = await saasClient.getMyClinic();
      const c = result.clinic;
      const { logoDataUrl, logoPath } = await downloadAndCacheLogo(c.logoUrl);
      return {
        success: true,
        branding: {
          clinicName: c.clinicName || null,
          color: c.brandColor || null,
          logoDataUrl,
          logoPath,
          address: c.address || null,
          phone: c.phone || null,
          groupProductsOnInvoice: !!c.groupProductsOnInvoice,
        },
      };
    } catch (err) {
      console.error("[branding-get]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle(
    "branding-update",
    async (_event, { clinicName, color, logoUrl, address, phone, groupProductsOnInvoice } = {}) => {
      try {
        await saasClient.updateMyClinic({
          clinicName,
          brandColor: color || null,
          address: address || null,
          phone: phone || null,
          groupProductsOnInvoice: !!groupProductsOnInvoice,
          // Only touch logoUrl when a new one was actually uploaded this
          // save — omitting the key entirely must not blank out the
          // clinic's existing logo.
          ...(logoUrl !== undefined ? { logoUrl: logoUrl || null } : {}),
        });
        return { success: true, message: "Branding updated successfully" };
      } catch (err) {
        console.error("[branding-update]", err);
        return { success: false, message: err.message };
      }
    },
  );

  // Uploads a picked logo file into the local uploads folder (served at
  // /uploaded/* by the embedded backend) and hands back its URL — the
  // caller then passes that URL to branding-update; this handler does
  // not itself touch the Clinic row.
  ipcMain.handle("branding-upload-logo", async (_event, dataUrl) => {
    try {
      const url = await saveLocalImage(dataUrl, "clinic_logo_");
      return { success: true, url };
    } catch (err) {
      console.error("[branding-upload-logo]", err);
      return { success: false, message: err.message };
    }
  });

  // Just opens the picker and hands the raw file back as a data URL — no
  // copy, no persistence. Lets the renderer show it in the crop tool before
  // anything is uploaded.
  ipcMain.handle("pick-logo-file-select", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select Clinic Logo",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths.length) return null;

    const srcPath = result.filePaths[0];
    const ext = path.extname(srcPath).slice(1).toLowerCase() || "png";
    const b64 = fs.readFileSync(srcPath, { encoding: "base64" });
    return { dataUrl: `data:image/${ext};base64,${b64}` };
  });

  ipcMain.handle("get-logo-preview", async (_, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const b64 = fs.readFileSync(filePath, { encoding: "base64" });
    return { dataUrl: `data:image/${ext};base64,${b64}` };
  });

  ipcMain.handle("generate-prescription-pdf", async (event, { prescription, pet, orgName, address, phone, vets }) => {
    try {
      // Logo/color are shared clinic-wide; address/phone/orgName are
      // per-record and resolved by the caller (already passed in above).
      const clinicResult = await saasClient.getMyClinic();
      const shared = await resolveApiBranding(store, clinicResult.clinic);
      const branding = { color: shared.color, logoPath: shared.logoPath };
      const pdfBuffer = await generatePrescriptionPdf(prescription, pet, orgName, address, phone, vets, branding);
      return { success: true, data: pdfBuffer };
    } catch (error) {
      console.error("PDF generation error:", error);
      return { success: false, message: error.message };
    }
  });
};
