const { ipcMain } = require('electron');
const saasClient = require('./saasClient');

// Branches — backed by the multi-tenant API's /api/branches. Full CRUD
// (list/add/rename/deactivate/delete) has moved off the per-clinic MySQL.
module.exports = function setupBranchesHandlers() {
  ipcMain.handle('branches-get-all', async () => {
    try {
      const result = await saasClient.listBranches();
      return {
        success: true,
        data: result.data.map((b) => ({
          id: b.id,
          branch_name: b.branchName,
          is_active: b.isActive,
          address: b.address,
          phone: b.phone,
        })),
      };
    } catch (err) {
      console.error('Error retrieving branches:', err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('branches-add', async (event, branch) => {
    try {
      const result = await saasClient.createBranch({
        branchName: branch.branch_name,
        isActive: !!branch.is_active,
      });
      return { success: true, message: 'Branch added successfully', branchId: result.data.id };
    } catch (err) {
      console.error('Error adding branch:', err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('branches-update', async (event, branch) => {
    try {
      await saasClient.updateBranch(branch.id, {
        branchName: branch.branch_name,
        isActive: !!branch.is_active,
      });
      return { success: true, message: 'Branch updated successfully' };
    } catch (err) {
      console.error('Error updating branch:', err);
      return { success: false, message: err.message };
    }
  });

  // Branch's own address/phone — kept as a separate IPC channel from
  // branches-update (Settings.jsx calls both in sequence after a save),
  // but both now resolve through the same combined API update.
  ipcMain.handle('branches-update-contact-info', async (event, { id, address, phone }) => {
    try {
      await saasClient.updateBranch(id, { address: address || null, phone: phone || null });
      return { success: true, message: 'Branch contact info updated successfully' };
    } catch (err) {
      console.error('Error updating branch contact info:', err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('branches-delete', async (event, branchId) => {
    try {
      await saasClient.deleteBranch(branchId);
      return { success: true, message: 'Branch deleted successfully' };
    } catch (err) {
      console.error('Error deleting branch:', err);
      return { success: false, message: err.message };
    }
  });
};
