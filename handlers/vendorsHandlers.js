const { ipcMain } = require("electron");
const saasClient = require("./saasClient");

// Vendors + consignment settlements — backed by the multi-tenant API's
// /api/vendors. Not branch-scoped (legacy never scoped this by branch
// either). The new backend returns one canonical set of lifetime+settled
// aggregate fields per vendor; each legacy channel below picks/renames
// whichever subset it originally exposed.

function toLocalVendorBase(v) {
  return {
    vendor_id: v.id,
    vendor_name: v.vendorName,
    contact_person: v.contactPerson,
    contact_number: v.contactNumber,
    notes: v.notes,
    is_active: v.isActive,
    created_at: v.createdAt,
  };
}

module.exports = function setupVendorsHandlers() {
  ipcMain.handle("retrieve-vendors", async () => {
    try {
      const result = await saasClient.listVendors({ pageSize: 100 });
      const data = result.data.map((v) => ({
        ...toLocalVendorBase(v),
        settled_gross_sales: v.settledGrossSales,
        settled_clinic_share: v.settledClinicShare,
        outstanding_payable: v.settledVendorShare,
        settlements_count: v.settlementsCount,
        units_sold: v.unitsSoldLifetime,
        total_sales: v.grossSalesLifetime,
      }));
      return { success: true, data };
    } catch (err) {
      console.error("[retrieve-vendors]", err);
      return { success: false, message: err.message, data: [] };
    }
  });

  ipcMain.handle("retrieve-vendors-page", async (_event, { page = 1, query = "", limit } = {}) => {
    try {
      const result = await saasClient.listVendors({ page, pageSize: limit || 10, search: query || undefined });
      const data = result.data.map((v) => ({
        ...toLocalVendorBase(v),
        recorded_settlements_vendor_share: v.settledVendorShare,
        units_sold: v.unitsSoldLifetime,
        total_sales: v.grossSalesLifetime,
      }));
      return { success: true, data, total: result.total, totalPages: result.totalPages, page: result.page };
    } catch (err) {
      console.error("[retrieve-vendors-page]", err);
      return { success: false, message: err.message, data: [] };
    }
  });

  ipcMain.handle("get-vendor-consignment-period-summary", async (_event, { startDate, endDate } = {}) => {
    try {
      if (!startDate || !endDate) {
        return { success: true, data: { vendors: [], grandTotal: { gross_sales: 0, clinic_amount: 0, vendor_owed: 0, units_sold: 0 } } };
      }
      const result = await saasClient.getConsignmentPeriodSummary({ startDate, endDate });
      const vendors = result.data.vendors.map((v) => ({
        vendor_id: v.vendorId,
        vendor_name: v.vendorName,
        units_sold: v.unitsSold,
        gross_sales: v.grossSales,
        clinic_amount: v.clinicAmount,
        vendor_owed: v.vendorOwed,
      }));
      const g = result.data.grandTotal;
      return {
        success: true,
        data: { vendors, grandTotal: { gross_sales: g.grossSales, clinic_amount: g.clinicAmount, vendor_owed: g.vendorOwed, units_sold: g.unitsSold } },
      };
    } catch (err) {
      console.error("[get-vendor-consignment-period-summary]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("add-vendor", async (_event, vendor) => {
    try {
      const result = await saasClient.createVendor({
        vendorName: vendor.vendor_name,
        contactPerson: vendor.contact_person || undefined,
        contactNumber: vendor.contact_number || undefined,
        notes: vendor.notes || undefined,
        isActive: !!vendor.is_active,
      });
      return { success: true, message: "Vendor added successfully", vendorId: result.data.id };
    } catch (err) {
      console.error("[add-vendor]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("edit-vendor", async (_event, vendor) => {
    try {
      await saasClient.updateVendor(vendor.vendor_id, {
        vendorName: vendor.vendor_name,
        contactPerson: vendor.contact_person || undefined,
        contactNumber: vendor.contact_number || undefined,
        notes: vendor.notes || undefined,
        isActive: !!vendor.is_active,
      });
      return { success: true, message: "Vendor updated successfully" };
    } catch (err) {
      console.error("[edit-vendor]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("delete-vendor", async (_event, vendorId) => {
    try {
      await saasClient.deleteVendor(vendorId);
      return { success: true, message: "Vendor deleted successfully" };
    } catch (err) {
      console.error("[delete-vendor]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("get-vendor-settlement-preview", async (_event, { vendorId, startDate, endDate }) => {
    try {
      const result = await saasClient.getVendorSettlementPreview(vendorId, { startDate, endDate });
      const items = result.data.items.map((i) => ({
        product_id: i.productId,
        product_name: i.productName,
        units_sold: i.unitsSold,
        gross_sales: i.grossSales,
        clinic_share: i.clinicShare,
        vendor_share: i.vendorShare,
      }));
      const t = result.data.totals;
      return {
        success: true,
        data: { items, totals: { units_sold: t.unitsSold, gross_sales: t.grossSales, vendor_share: t.vendorShare, clinic_share: t.clinicShare } },
      };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("create-vendor-settlement", async (_event, { vendorId, startDate, endDate, notes }) => {
    try {
      await saasClient.createVendorSettlement(vendorId, { startDate, endDate, notes: notes || undefined });
      return { success: true, message: "Vendor settlement created successfully" };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("retrieve-vendor-settlements", async (_event, vendorId) => {
    try {
      const result = await saasClient.listVendorSettlements({ vendorId: vendorId || undefined });
      const data = result.data.map((s) => ({
        settlement_id: s.id,
        vendor_id: s.vendorId,
        vendor_name: s.vendorName,
        start_date: s.startDate,
        end_date: s.endDate,
        gross_sales: s.grossSales,
        clinic_share: s.clinicShare,
        vendor_share: s.vendorShare,
        created_at: s.createdAt,
        notes: s.notes,
      }));
      return { success: true, data };
    } catch (err) {
      console.error("[retrieve-vendor-settlements]", err);
      return { success: false, message: err.message, data: [] };
    }
  });
};
