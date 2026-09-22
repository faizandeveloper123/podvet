const { ipcMain } = require('electron');
const saasClient = require('./saasClient');

// Maps the multi-tenant backend's MembershipRole ('OWNER'/'ADMIN'/'USER')
// down to the lowercase 'admin'/'user' the rest of this app already checks
// (Sidebar, ProtectedRoute, and every screen that reads session.role) —
// OWNER counts as 'admin' so a clinic's owner keeps admin-only access.
const ROLE_MAP = { OWNER: 'admin', ADMIN: 'admin', USER: 'user' };

function toLocalUser({ user, activeClinic }) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    isPlatformAdmin: user.isPlatformAdmin,
    organization_name: activeClinic?.clinicName ?? null,
    clinic_id: activeClinic?.clinicId ?? null,
    clinic_slug: activeClinic?.slug ?? null,
    role: activeClinic ? ROLE_MAP[activeClinic.role] || 'user' : null,
    // Raw MembershipRole ('OWNER'/'ADMIN'/'USER'), kept alongside the
    // collapsed `role` above — `role` treats OWNER and ADMIN alike for the
    // app's existing admin-only-access checks, but some features (e.g.
    // Expenses' branch scoping) need to tell an owner apart from a branch
    // admin specifically.
    membership_role: activeClinic?.role ?? null,
    branch_id: activeClinic?.branchId ?? null,
    // { code, message } | null — same verdict requireActiveSubscription
    // enforces on a gated route, but known immediately here (login already
    // returns it) instead of waiting for some other request to 402. See
    // LoginScreen.jsx's routeAfterAuth.
    access_blocked: activeClinic?.accessBlocked ?? null,
  };
}

module.exports = function setupAuthHandlers(store) {
  saasClient.init({
    store,
    baseUrl: process.env.SAAS_API_BASE_URL || 'http://localhost:4000',
  });

  // /api/auth/login (distinct from the owner portal's /api/auth/admin-login)
  // already rejects any account with zero clinic memberships — a platform
  // admin included, it has none by design — so activeClinic/availableClinics
  // below are never both empty by the time a response actually comes back.
  ipcMain.handle('login', async (_event, { identifier, password, clinicId }) => {
    try {
      const data = await saasClient.login({ identifier, password, clinicId });
      // Platform staff: the backend flags the response so the preload can hand
      // the token to /super-admin instead of building a clinic session.
      if (data && data.superAdmin) {
        return { success: true, superAdmin: true, token: data.token };
      }
      saasClient.saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      const session = { user: data.user, activeClinic: data.activeClinic };
      saasClient.saveSession(session);
      const localUser = toLocalUser(session);
      store.set('user', localUser);

      if (!data.activeClinic && data.availableClinics?.length) {
        return {
          success: true,
          requiresClinicSelection: true,
          availableClinics: data.availableClinics,
          user: localUser,
        };
      }

      return { success: true, message: 'Login successful', user: localUser };
    } catch (err) {
      return { success: false, message: err.message || 'Login failed', code: err.code };
    }
  });

  ipcMain.handle('switch-clinic', async (_event, { clinicId }) => {
    try {
      const data = await saasClient.switchClinic(clinicId);
      saasClient.saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      const session = { user: data.user, activeClinic: data.activeClinic };
      saasClient.saveSession(session);
      const localUser = toLocalUser(session);
      store.set('user', localUser);
      return { success: true, user: localUser };
    } catch (err) {
      return { success: false, message: err.message || 'Could not switch clinic', code: err.code };
    }
  });

  ipcMain.handle('clinic-signup', async (_event, payload) => {
    try {
      const data = await saasClient.signup(payload);
      saasClient.saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      // A brand-new signup always yields exactly one membership (the
      // caller as OWNER) — build the same session shape login/switch-clinic
      // use, from what POST /clinics returns. Some backends return the new
      // clinic as `clinic`, others as `activeClinic`.
      const clinic = data.clinic || data.activeClinic || {};
      const session = {
        user: { ...(data.user || {}), isPlatformAdmin: false },
        activeClinic: {
          clinicId: clinic.id || clinic.clinicId || 1,
          clinicName: clinic.clinicName || clinic.clinic_name || 'PodVet Clinic',
          slug: clinic.slug || 'podvet',
          role: 'OWNER',
          branchId: clinic.branchId || null,
          // A brand-new clinic has no subscription yet, but that's the
          // normal pre-onboarding state, not a block — SignupScreen routes
          // straight to /select-plan itself and never consults this field.
          accessBlocked: clinic.accessBlocked || null,
        },
      };
      saasClient.saveSession(session);
      const localUser = toLocalUser(session);
      store.set('user', localUser);
      return { success: true, message: 'Clinic created successfully', user: localUser };
    } catch (err) {
      return { success: false, message: err.message || 'Signup failed', code: err.code, details: err.details };
    }
  });

  // Referral login: the receiving clinic enters the referral code printed on a
  // shared referral card. The backend validates the code, self-provisions a
  // brand-new clinic + OWNER account, and signs them in — same session shape
  // as login/clinic-signup so the app drops them straight onto their dashboard.
  ipcMain.handle('referral-login', async (_event, payload) => {
    try {
      const data = await saasClient.referralLogin(payload);
      saasClient.saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      const { user, activeClinic } = data;
      const session = { user, activeClinic };
      saasClient.saveSession(session);
      const localUser = toLocalUser(session);
      store.set('user', localUser);
      return {
        success: true,
        message: data.message || 'Referral accepted. Welcome!',
        referredBy: data.referredBy || null,
        user: localUser,
      };
    } catch (err) {
      return { success: false, message: err.message || 'Referral login failed', code: err.code };
    }
  });

  // Mints a referral code for the current clinic (used when generating a card
  // to share with another clinic) and returns it for printing on the card.
  ipcMain.handle('generate-referral', async (_event, payload) => {
    try {
      const data = await saasClient.generateReferral(payload);
      return { success: true, code: data.code };
    } catch (err) {
      return { success: false, message: err.message || 'Could not generate referral code', code: err.code };
    }
  });

  ipcMain.handle('get-session', async () => {
    return store.get('user') || null;
  });

  // Called once on app startup so a valid, previously-logged-in session
  // survives closing and reopening the app — without this, `get-session`
  // above would keep returning stale cached data forever even after the
  // refresh token expired or got revoked server-side, and the renderer
  // never had any reason to call it before rendering LoginScreen anyway.
  ipcMain.handle('resume-session', async () => {
    const tokens = saasClient.loadTokens();
    if (!tokens?.accessToken && !tokens?.refreshToken) {
      return null;
    }

    try {
      // GET /api/auth/me — apiFetch already retries once via /refresh if
      // the access token has expired, so this transparently covers both
      // "still valid" and "expired but refreshable" in one call.
      const data = await saasClient.me();
      if (!data.activeClinic) {
        // Only reachable for an account belonging to multiple clinics with
        // none selected yet — not a flow this app builds a picker for on
        // resume (signup only ever creates one membership today).
        return null;
      }
      const session = { user: data.user, activeClinic: data.activeClinic };
      saasClient.saveSession(session);
      const localUser = toLocalUser(session);
      store.set('user', localUser);
      return localUser;
    } catch (err) {
      if (err.code === 'NETWORK_ERROR') {
        // Can't verify against the server right now — trust the cached
        // session rather than forcing a re-login over a connectivity blip.
        return store.get('user') || null;
      }
      // Refresh already failed inside apiFetch, or the account/session is
      // otherwise genuinely no longer valid — clear everything so the next
      // resume-session call doesn't keep retrying a dead refresh token.
      saasClient.clearTokens();
      saasClient.clearSession();
      store.delete('user');
      return null;
    }
  });

  ipcMain.handle('logout', async () => {
    const tokens = saasClient.loadTokens();
    try {
      await saasClient.logoutRemote(tokens?.refreshToken);
    } catch (err) {
      // Best-effort: still clear the local session below even if the
      // backend couldn't be reached to revoke the tokens server-side.
      console.error('[logout] backend revoke failed:', err.message);
    }
    saasClient.clearTokens();
    saasClient.clearSession();
    store.delete('user');
    return true;
  });

  ipcMain.handle('forgot-password', async (_event, { email }) => {
    try {
      const data = await saasClient.forgotPassword(email);
      return { success: true, message: data.message };
    } catch (err) {
      return { success: false, message: err.message || 'Could not send reset code' };
    }
  });

  ipcMain.handle('reset-password', async (_event, { token, newPassword }) => {
    try {
      const data = await saasClient.resetPassword(token, newPassword);
      return { success: true, message: data.message };
    } catch (err) {
      return { success: false, message: err.message || 'Could not reset password' };
    }
  });

  // `userId` in the payload (Settings.jsx still sends it, a holdover from
  // the legacy local-DB handler) is ignored — the backend identifies the
  // caller from the access token, not a client-supplied id. Same for
  // `organization_name` — that's Clinic.clinicName now, edited via the
  // Branding/Clinic settings flow, not part of a user's own profile.
  ipcMain.handle('update-profile', async (_event, { name, username }) => {
    try {
      const data = await saasClient.updateMyProfile({ name, username });
      const session = { user: data.user, activeClinic: data.activeClinic };
      saasClient.saveSession(session);
      const localUser = toLocalUser(session);
      store.set('user', localUser);
      return { success: true, message: 'Profile updated successfully' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not update profile' };
    }
  });

  ipcMain.handle('change-password', async (_event, { currentPassword, newPassword }) => {
    try {
      const data = await saasClient.changePassword(currentPassword, newPassword);
      return { success: true, message: data.message };
    } catch (err) {
      return { success: false, message: err.message || 'Could not change password' };
    }
  });
};
