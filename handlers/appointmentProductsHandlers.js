const { ipcMain } = require("electron");
const saasClient = require("./saasClient");

// Appointment products (billed), clinic-supply inventory usage (unbilled),
// and pre-payment discounts — backed by the multi-tenant API's
// /api/appointments/:id/(products|inventory-usage|prediscount) and
// /api/appointment-products/:id.

function toLocalUsageRow(u) {
  return { product_id: u.productId, name: u.name, barcode_number: u.barcodeNumber, stock_remaining: u.stockRemaining, total_deducted: u.totalDeducted };
}

function toLocalProductRow(p) {
  return { id: p.id, product_id: p.productId, name: p.name, barcode_number: p.barcodeNumber, quantity: p.quantity, price: p.price, total: p.total, locked: p.locked };
}

function toLocalDiscount(d) {
  if (!d) return null;
  return {
    billing_id: d.billingId,
    raw_total: d.rawTotal,
    discount_amount: d.discountAmount,
    final_amount: d.finalAmount,
    discount_type: d.discountType,
    discount_value: d.discountValue,
  };
}

module.exports = function setupAppointmentProductsHandlers() {
  ipcMain.handle("get-appointment-inventory-usage", async (_event, appointmentId) => {
    try {
      const result = await saasClient.getAppointmentInventoryUsage(appointmentId);
      return { success: true, data: result.data.map(toLocalUsageRow) };
    } catch (err) {
      console.error("[get-appointment-inventory-usage]", err);
      return { success: false, message: err.message, data: [] };
    }
  });

  ipcMain.handle("deduct-appointment-inventory", async (_event, { appointmentId, productId, quantity }) => {
    try {
      const result = await saasClient.deductAppointmentInventory(appointmentId, { productId, quantity });
      return { success: true, message: `Deducted ${quantity} × ${result.data.productName} from inventory` };
    } catch (err) {
      console.error("[deduct-appointment-inventory]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("get-appointment-products", async (_event, appointmentId) => {
    try {
      const result = await saasClient.getAppointmentProducts(appointmentId);
      return { success: true, data: result.data.map(toLocalProductRow) };
    } catch (err) {
      console.error("[get-appointment-products]", err);
      return { success: false, message: err.message, data: [] };
    }
  });

  ipcMain.handle("get-appointment-products-display", async (_event, appointmentId) => {
    try {
      const result = await saasClient.getAppointmentProductsDisplay(appointmentId);
      return { success: true, data: result.data.map(toLocalProductRow) };
    } catch (err) {
      console.error("[get-appointment-products-display]", err);
      return { success: false, message: err.message, data: [] };
    }
  });

  ipcMain.handle("add-appointment-product", async (_event, { appointmentId, productId, quantity }) => {
    try {
      const result = await saasClient.addAppointmentProduct(appointmentId, { productId, quantity });
      return { success: true, message: result.data.message };
    } catch (err) {
      console.error("[add-appointment-product]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("remove-appointment-product", async (_event, { appointmentProductId }) => {
    try {
      await saasClient.removeAppointmentProduct(appointmentProductId);
      return { success: true, message: "Product removed from appointment" };
    } catch (err) {
      console.error("[remove-appointment-product]", err);
      return { success: false, message: err.message };
    }
  });

  // ── Pre-payment discounts (Payments.jsx) ────────────────────────────
  ipcMain.handle("get-appointment-prediscount", async (_event, { appointmentId }) => {
    try {
      const result = await saasClient.getAppointmentPrediscount(appointmentId);
      const d = result.data;
      return {
        success: true,
        appointmentFee: d.appointmentFee,
        productsTotal: d.productsTotal,
        rawTotal: d.rawTotal,
        alreadyPaid: d.alreadyPaid,
        existingDiscount: toLocalDiscount(d.existingDiscount),
        billingId: d.billingId,
      };
    } catch (err) {
      console.error("[get-appointment-prediscount]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("save-appointment-prediscount", async (_event, { appointmentId, discountType, discountValue }) => {
    try {
      const result = await saasClient.saveAppointmentPrediscount(appointmentId, { discountType, discountValue });
      return {
        success: true,
        billingId: result.data.billingId,
        rawTotal: result.data.rawTotal,
        discountAmount: result.data.discountAmount,
        finalAmount: result.data.finalAmount,
        message: "Discount saved",
      };
    } catch (err) {
      console.error("[save-appointment-prediscount]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("remove-appointment-prediscount", async (_event, { appointmentId }) => {
    try {
      const result = await saasClient.removeAppointmentPrediscount(appointmentId);
      return { success: true, message: result.data.removed ? "Discount removed" : "No discount to remove" };
    } catch (err) {
      console.error("[remove-appointment-prediscount]", err);
      return { success: false, message: err.message };
    }
  });
};
