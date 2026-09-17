const { ipcMain } = require('electron');
const saasClient = require('./saasClient');

// Login accounts for other clinic staff (create/list/edit/remove) — backed
// by the multi-tenant API's /api/users. Distinct from employeesHandlers.js,
// which is HR roster data with no login access.

function toBranchId(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return Number(value);
}

// `role` here is always the raw backend value, lowercased ('owner'/'admin'/
// 'user') — the renderer distinguishes the clinic owner (can't be deleted
// or have their role changed) from a promoted admin, which a single
// legacy-style 'admin' bucket couldn't represent.
function toLegacyUser(member) {
  return {
    id: member.id,
    name: member.name,
    username: member.username,
    email: member.email,
    phone_number: member.phoneNumber,
    role: member.role.toLowerCase(),
    designation: member.designation,
    branch_id: member.branchId,
  };
}

function toLegacyInvitation(invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role.toLowerCase(),
    designation: invitation.designation,
    branch_id: invitation.branchId,
    invited_by_name: invitation.invitedByName,
    status: invitation.status,
    expires_at: invitation.expiresAt,
    created_at: invitation.createdAt,
  };
}

module.exports = function setupClinicUsersHandlers() {
  ipcMain.handle('retrieve-users', async (_event, page = 1, query = '') => {
    try {
      const result = await saasClient.listClinicUsers({ page, pageSize: 5, search: query });
      return {
        data: result.data.map(toLegacyUser),
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      };
    } catch (err) {
      console.error('[retrieve-users]', err);
      throw err;
    }
  });

  ipcMain.handle('create-user', async (_event, user) => {
    try {
      await saasClient.createClinicUser({
        name: user.name,
        username: user.username,
        email: user.email,
        password: user.password,
        phoneNumber: user.phoneNumber || undefined,
        role: String(user.role || '').toUpperCase(),
        designation: user.designation || undefined,
        branchId: toBranchId(user.branchId),
      });
      return { success: true, message: 'User created Successfully!' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not create user' };
    }
  });

  ipcMain.handle('update-user', async (_event, user) => {
    try {
      await saasClient.updateClinicUser(user.id, {
        name: user.name,
        username: user.username,
        email: user.email || undefined,
        phoneNumber: user.phone_number ?? undefined,
        designation: user.designation ?? undefined,
        branchId: user.branch_id === undefined ? undefined : toBranchId(user.branch_id) ?? null,
        ...(user.password ? { password: user.password } : {}),
        // Only ever sent when the renderer actually showed an editable role
        // control (clinic OWNER, editing a non-owner) — the backend itself
        // also enforces this (rejects a role change from anyone but the
        // OWNER), this just avoids sending a stale/empty value otherwise.
        ...(user.role ? { role: String(user.role).toUpperCase() } : {}),
      });
      return { success: true, message: 'User updated successfully' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not update user' };
    }
  });

  ipcMain.handle('delete-user', async (_event, userId) => {
    try {
      await saasClient.deleteClinicUser(userId);
      return { success: true, message: 'User deleted successfully' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not delete user' };
    }
  });

  // Invite-based user creation — replaces create-user in the "Add User"
  // modal. name/username/password are no longer collected here; the
  // invitee sets those themselves on the backend's own accept page.
  ipcMain.handle('invite-user', async (_event, invite) => {
    try {
      const result = await saasClient.createInvitation({
        email: invite.email,
        role: String(invite.role || '').toUpperCase(),
        designation: invite.designation || undefined,
        branchId: toBranchId(invite.branchId),
      });
      return { success: true, message: 'Invitation sent', invitation: toLegacyInvitation(result.data) };
    } catch (err) {
      return { success: false, message: err.message || 'Could not send invitation' };
    }
  });

  ipcMain.handle('list-invitations', async (_event, page = 1, query = '') => {
    try {
      const result = await saasClient.listInvitations({ page, pageSize: 5, search: query });
      return {
        success: true,
        data: result.data.map(toLegacyInvitation),
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      };
    } catch (err) {
      console.error('[list-invitations]', err);
      return { success: false, message: err.message, data: [], total: 0, page: 1, totalPages: 1 };
    }
  });

  ipcMain.handle('resend-invitation', async (_event, invitationId) => {
    try {
      await saasClient.resendInvitation(invitationId);
      return { success: true, message: 'Invitation resent' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not resend invitation' };
    }
  });

  ipcMain.handle('revoke-invitation', async (_event, invitationId) => {
    try {
      await saasClient.revokeInvitation(invitationId);
      return { success: true, message: 'Invitation revoked' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not revoke invitation' };
    }
  });
};
