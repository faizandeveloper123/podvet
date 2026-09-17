const { ipcMain } = require("electron");
const saasClient = require("../saasClient");

// Proxies the backend's /api/ai/scan-product-image — the Groq API key and
// vision prompt now live server-side only (ai.service.ts, ported verbatim
// from what used to be here). This used to call Groq directly from this
// process with the key sitting in every desktop install's local .env.
module.exports = function setupAiProductHandlers() {
  ipcMain.handle("scan-product-image", async (_event, { imageBase64 }) => {
    try {
      if (!imageBase64) {
        return { success: false, message: "No image data received." };
      }

      const result = await saasClient.scanProductImage(imageBase64);
      const p = result.data;

      // camelCase (API) -> snake_case (the renderer's product form fields,
      // same convention productsHandlers.js's toLocalProduct/toApiProductPayload use).
      return {
        success: true,
        data: {
          name: p.name,
          barcode_number: p.barcodeNumber,
          price: p.price,
          quantity: p.quantity,
        },
      };
    } catch (err) {
      console.error("[scan-product-image]", err);
      return { success: false, message: err.message || "Unexpected error during AI scan." };
    }
  });
};
