const { ipcMain } = require("electron");
const saasClient = require("./saasClient");

const EMPTY_REPORT_DATA = {
  monthlyRevenue:     [],
  totalRevenue:       0,
  grossRevenue:       0,
  totalExpenses:      0,
  totalAppointments:  0,
  totalBilling:       0,
  appointmentRevenue: 0,
  billingRevenue:     0,
  totalClients:       0,
  totalPets:          0,
  serviceBreakdown:   [],
  recentTransactions: [],
  topServices:        [],
  clientGrowth:       [],
};

module.exports = function setupReportsHandlers() {
// Get reports data — OWNER-only on the backend (ADMIN/USER get a 403);
// the desktop side additionally hides the Reports nav entry and route for
// non-owners (see Sidebar.jsx/ProtectedRoute.jsx) so this call is only
// ever made by an owner in practice. `period` is accepted from the
// frontend's filter panel but never forwarded — it's been a no-op since
// the legacy handler too (the backend always computes monthly buckets).
ipcMain.handle('get-reports-data', async (_event, filters) => {
  try {
    const { startDate, endDate, branchId } = filters;
    const result = await saasClient.getReportsData({ startDate, endDate, branchId });
    return { success: true, data: result.data };
  } catch (error) {
    console.error('Error fetching reports data:', error);
    return { success: true, error: error.message, data: EMPTY_REPORT_DATA };
  }
});
};
