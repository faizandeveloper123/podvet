const { ipcMain } = require('electron');
const saasClient = require('./saasClient');
const { saveLocalImage } = require('./utils');

// Bank-transfer payment proof for a paid plan. The file itself never
// touches the backend API — it's stored locally (served at /uploaded/* by
// the embedded backend) from here. Only the resulting URL is sent to the
// backend — see clinic.service.ts's submitPayment.
module.exports = function setupPaymentSubmissionHandlers() {
  ipcMain.handle('list-bank-accounts', async () => {
    try {
      const result = await saasClient.listBankAccounts();
      return { success: true, data: result.data };
    } catch (err) {
      return { success: false, message: err.message || 'Could not load bank account details' };
    }
  });

  ipcMain.handle('list-my-payment-submissions', async (_event, params) => {
    try {
      const result = await saasClient.listMyPaymentSubmissions(params);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, message: err.message || 'Could not load payment history' };
    }
  });

  ipcMain.handle('submit-payment-proof', async (_event, { planId, dataUrl }) => {
    try {
      const proofUrl = await saveLocalImage(dataUrl, 'payment_proof_');

      const result = await saasClient.submitPaymentProof({
        planId,
        proofUrl,
      });
      return { success: true, data: result.data };
    } catch (err) {
      return { success: false, message: err.message || 'Could not submit your payment proof' };
    }
  });
};
