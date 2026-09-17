const { ipcMain } = require('electron');
const saasClient = require('./saasClient');

// Plans catalog + the clinic's own subscription — backed by the
// multi-tenant API's /api/plans and /api/clinics/me(/subscription). Plans
// are dummy data for now (seeded via prisma/seed.ts); a platform-owner
// portal will manage these for real later.
module.exports = function setupSubscriptionHandlers() {
  ipcMain.handle('list-plans', async () => {
    try {
      const result = await saasClient.listPlans();
      return { success: true, data: result.data };
    } catch (err) {
      return { success: false, message: err.message || 'Could not load plans' };
    }
  });

  ipcMain.handle('select-plan', async (_event, planId) => {
    try {
      const result = await saasClient.selectPlan(planId);
      return { success: true, data: result.data };
    } catch (err) {
      return { success: false, message: err.message || 'Could not select that plan', code: err.code };
    }
  });

  ipcMain.handle('get-my-clinic', async () => {
    try {
      const result = await saasClient.getMyClinic();
      return { success: true, data: result.clinic };
    } catch (err) {
      return { success: false, message: err.message || 'Could not load clinic details' };
    }
  });
};
