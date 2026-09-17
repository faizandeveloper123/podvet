const { ipcMain } = require("electron");
const saasClient = require("./saasClient");

// Services — backed by the multi-tenant API's /api/services. The legacy
// app split "regular services" and "Grooming services" into 3 channels
// each (add/retrieve/edit) purely as a UI convenience; category is a
// value, not a distinct backend concept, so all 6 legacy channels here
// call the same underlying resource with a category filter/value.

function toLocalService(s) {
  return { service_id: s.id, name: s.name, category: s.category, base_rate: s.baseRate, purchasing_price: s.purchasePrice };
}

function isConflict(err) {
  return err?.status === 409 || err?.code === "CONFLICT";
}

// Empty string (untouched field, or user cleared it) -> null so the API
// explicitly clears any previously-set cost price; a real value gets
// coerced to a number. Never send `undefined` here — that would mean
// "leave alone", which isn't what a form re-submit intends.
function toApiPurchasePrice(value) {
  if (value === "" || value === null || value === undefined) return null;
  return Number(value);
}

module.exports = function setupServicesHandlers() {
  ipcMain.handle("add-service", async (_event, service) => {
    try {
      await saasClient.createService({
        name: service.name,
        category: service.category,
        baseRate: service.base_rate,
        purchasePrice: toApiPurchasePrice(service.purchasing_price),
      });
      return { success: true, message: "Service added Successfully!" };
    } catch (err) {
      if (isConflict(err)) return { success: false, message: "Service already exists" };
      console.error("[add-service]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("retrieve-services", async () => {
    const result = await saasClient.listServices({ excludeCategory: "Grooming" });
    return { data: result.data.map(toLocalService) };
  });

  ipcMain.handle("edit-service", async (_event, service) => {
    try {
      await saasClient.updateService(service.service_id, {
        name: service.name,
        category: service.category,
        baseRate: service.base_rate,
        purchasePrice: toApiPurchasePrice(service.purchasing_price),
      });
      return { success: true, message: "Successfully Updated Service" };
    } catch (err) {
      console.error("[edit-service]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("delete-service", async (_event, serviceId) => {
    try {
      await saasClient.deleteService(serviceId);
      return { success: true, message: "Successfully Deleted Service" };
    } catch (err) {
      console.error("[delete-service]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("add-grooming", async (_event, service) => {
    try {
      await saasClient.createService({ name: service.name, category: "Grooming", baseRate: service.base_rate });
      return { success: true, message: "Grooming Added Successfully!" };
    } catch (err) {
      if (isConflict(err)) return { success: false, message: "Grooming Type already exists" };
      console.error("[add-grooming]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("retrieve-grooming", async () => {
    const result = await saasClient.listServices({ category: "Grooming" });
    return { data: result.data.map(toLocalService) };
  });

  ipcMain.handle("edit-grooming", async (_event, service) => {
    try {
      await saasClient.updateService(service.service_id, { name: service.name, category: "Grooming", baseRate: service.base_rate });
      return { success: true, message: "Successfully Updated Grooming Service" };
    } catch (err) {
      console.error("[edit-grooming]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("get-services", async () => {
    try {
      const result = await saasClient.listServices();
      return { success: true, services: result.data.map(toLocalService) };
    } catch (err) {
      console.error("[get-services]", err);
      return { success: false, error: err.message };
    }
  });
};
