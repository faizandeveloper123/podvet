const { safeStorage, BrowserWindow } = require('electron');

// Thin HTTP client for the centralized PetVet multi-tenant backend.
// Tokens never leave the main process — the renderer only ever talks to
// this through ipcMain handlers in authHandlers.js, never directly.

let store;
let baseUrl;

function init({ store: injectedStore, baseUrl: injectedBaseUrl }) {
  store = injectedStore;
  baseUrl = injectedBaseUrl;
}

function encrypt(value) {
  return safeStorage.encryptString(value).toString('base64');
}

function decrypt(value) {
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}

function saveTokens({ accessToken, refreshToken }) {
  if (safeStorage.isEncryptionAvailable()) {
    store.set('saasTokens', {
      accessToken: encrypt(accessToken),
      refreshToken: encrypt(refreshToken),
      encrypted: true,
    });
  } else {
    // Only reachable on unusual setups without OS keychain access — still
    // persist the session rather than silently failing to log the user in.
    store.set('saasTokens', { accessToken, refreshToken, encrypted: false });
  }
}

function loadTokens() {
  const raw = store.get('saasTokens');
  if (!raw) return null;
  if (!raw.encrypted) return { accessToken: raw.accessToken, refreshToken: raw.refreshToken };
  try {
    return { accessToken: decrypt(raw.accessToken), refreshToken: decrypt(raw.refreshToken) };
  } catch {
    return null;
  }
}

function clearTokens() {
  store.delete('saasTokens');
}

function saveSession(session) {
  store.set('saasSession', session);
}

function loadSession() {
  return store.get('saasSession') || null;
}

function clearSession() {
  store.delete('saasSession');
}

class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const SUBSCRIPTION_BLOCK_CODES = new Set(['SUBSCRIPTION_REQUIRED', 'SUBSCRIPTION_INACTIVE', 'CLINIC_SUSPENDED']);

// The backend revokes the offending access token itself when it returns one
// of these — this broadcast is just how the main process tells every
// renderer window to stop showing normal app screens and go explain why,
// instead of leaving each screen's own error handling (a toast, a blank
// table) to paper over what's actually a hard access block.
function broadcastSubscriptionBlocked({ code, message }) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('subscription-blocked', { code, message });
  }
}

// Fired when tryRefresh() determines the session is genuinely dead (refresh
// token expired, revoked, or blacklisted) so every renderer window can drop
// back to the login screen instead of each screen independently surfacing
// its own "Not signed in" error.
function broadcastSessionExpired() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('session-expired');
  }
}

async function apiFetch(path, { method = 'GET', body, auth = false, retry = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };

  if (auth) {
    const tokens = loadTokens();
    if (!tokens?.accessToken) {
      throw new ApiError('Not signed in', { status: 401, code: 'UNAUTHORIZED' });
    }
    headers.Authorization = `Bearer ${tokens.accessToken}`;
  }

  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError('Could not reach the server. Check your internet connection.', { code: 'NETWORK_ERROR' });
  }

  if (res.status === 401 && auth && retry) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return apiFetch(path, { method, body, auth, retry: false });
    }
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // e.g. 204 No Content
  }

  if (!res.ok) {
    if (res.status === 402 && SUBSCRIPTION_BLOCK_CODES.has(data?.error?.code)) {
      broadcastSubscriptionBlocked({ code: data.error.code, message: data.error.message });
    }
    throw new ApiError(data?.error?.message || `Request failed (${res.status})`, {
      status: res.status,
      code: data?.error?.code,
      details: data?.error?.details,
    });
  }

  return data;
}

function queryString(params = {}) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

// The backend rotates refresh tokens (single-use — blacklisted the instant
// they're used, see auth.service.ts::refresh). Several screens routinely
// fire parallel authenticated requests at once (e.g. a dashboard loading
// multiple widgets via Promise.all); if the access token has expired, each
// one would otherwise call tryRefresh() independently with the same stored
// refresh token — only the first reaches the backend before it's rotated,
// and every other concurrent call fails and wipes out the valid tokens the
// first one just saved. This dedupes all concurrent callers onto one
// in-flight refresh so only a single /api/auth/refresh request is ever made
// at a time.
let refreshInFlight = null;

async function tryRefresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const tokens = loadTokens();
    if (!tokens?.refreshToken) return false;
    try {
      const data = await apiFetch('/api/auth/refresh', {
        method: 'POST',
        body: { refreshToken: tokens.refreshToken },
      });
      saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      saveSession({ user: data.user, activeClinic: data.activeClinic });
      return true;
    } catch {
      // Refresh token itself is invalid/expired/revoked — the session is
      // genuinely over, not just racing another refresh. Clear local state
      // and tell every window to drop back to login.
      clearTokens();
      clearSession();
      broadcastSessionExpired();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

module.exports = {
  init,
  saveTokens,
  loadTokens,
  clearTokens,
  saveSession,
  loadSession,
  clearSession,
  ApiError,
  // Which backend this install is currently pointed at (e.g. a local dev
  // API vs the production one) — set once via init(). Used by
  // reminderNotifications.js to scope its local notification cache, so
  // switching backends can't surface stale data from a different one.
  getBaseUrl: () => baseUrl,
  signup: (payload) => apiFetch('/api/clinics', { method: 'POST', body: payload }),
  login: (payload) => apiFetch('/api/auth/login', { method: 'POST', body: payload }),
  logoutRemote: (refreshToken) =>
    apiFetch('/api/auth/logout', { method: 'POST', auth: true, body: { refreshToken } }),
  me: () => apiFetch('/api/auth/me', { auth: true }),
  updateMyProfile: (payload) => apiFetch('/api/auth/me', { method: 'PATCH', auth: true, body: payload }),
  switchClinic: (clinicId) =>
    apiFetch('/api/auth/switch-clinic', { method: 'POST', auth: true, body: { clinicId } }),
  forgotPassword: (email) => apiFetch('/api/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (token, newPassword) =>
    apiFetch('/api/auth/reset-password', { method: 'POST', body: { token, newPassword } }),
  changePassword: (currentPassword, newPassword) =>
    apiFetch('/api/auth/change-password', { method: 'POST', auth: true, body: { currentPassword, newPassword } }),

  listBranches: () => apiFetch('/api/branches', { auth: true }),
  createBranch: (payload) => apiFetch('/api/branches', { method: 'POST', auth: true, body: payload }),
  updateBranch: (id, payload) => apiFetch(`/api/branches/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteBranch: (id) => apiFetch(`/api/branches/${id}`, { method: 'DELETE', auth: true }),

  listExpenseCategories: () => apiFetch('/api/expense-categories', { auth: true }),
  createExpenseCategory: (payload) => apiFetch('/api/expense-categories', { method: 'POST', auth: true, body: payload }),
  updateExpenseCategory: (id, payload) =>
    apiFetch(`/api/expense-categories/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteExpenseCategory: (id) => apiFetch(`/api/expense-categories/${id}`, { method: 'DELETE', auth: true }),

  listExpenses: (params) => apiFetch(`/api/expenses${queryString(params)}`, { auth: true }),
  createExpense: (payload) => apiFetch('/api/expenses', { method: 'POST', auth: true, body: payload }),
  updateExpense: (id, payload) => apiFetch(`/api/expenses/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteExpense: (id) => apiFetch(`/api/expenses/${id}`, { method: 'DELETE', auth: true }),

  listEmployees: (params) => apiFetch(`/api/employees${queryString(params)}`, { auth: true }),
  createEmployee: (payload) => apiFetch('/api/employees', { method: 'POST', auth: true, body: payload }),
  updateEmployee: (id, payload) =>
    apiFetch(`/api/employees/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteEmployee: (id) => apiFetch(`/api/employees/${id}`, { method: 'DELETE', auth: true }),

  listClients: (params) => apiFetch(`/api/clients${queryString(params)}`, { auth: true }),
  createClient: (payload) => apiFetch('/api/clients', { method: 'POST', auth: true, body: payload }),
  createClientWithPet: (payload) =>
    apiFetch('/api/clients/with-pet', { method: 'POST', auth: true, body: payload }),
  getClient: (id) => apiFetch(`/api/clients/${id}`, { auth: true }),
  updateClient: (id, payload) => apiFetch(`/api/clients/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteClient: (id) => apiFetch(`/api/clients/${id}`, { method: 'DELETE', auth: true }),
  listClientPets: (clientId) => apiFetch(`/api/clients/${clientId}/pets`, { auth: true }),
  createClientPet: (clientId, payload) =>
    apiFetch(`/api/clients/${clientId}/pets`, { method: 'POST', auth: true, body: payload }),

  listPets: (params) => apiFetch(`/api/pets${queryString(params)}`, { auth: true }),
  listPetSpecies: () => apiFetch('/api/pets/species', { auth: true }),
  listUpcomingBirthdays: () => apiFetch('/api/pets/upcoming-birthdays', { auth: true }),
  getPet: (id) => apiFetch(`/api/pets/${id}`, { auth: true }),
  updatePet: (id, payload) => apiFetch(`/api/pets/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deletePet: (id) => apiFetch(`/api/pets/${id}`, { method: 'DELETE', auth: true }),

  // ── Medical records (EMR) ──────────────────────────────────────────────
  listSoapNotesByPet: (petId) => apiFetch(`/api/pets/${petId}/soap-notes`, { auth: true }),
  getSoapNoteByAppointment: (appointmentId) =>
    apiFetch(`/api/soap-notes/by-appointment/${appointmentId}`, { auth: true }),
  createSoapNote: (petId, payload) =>
    apiFetch(`/api/pets/${petId}/soap-notes`, { method: 'POST', auth: true, body: payload }),
  getSoapNote: (id) => apiFetch(`/api/soap-notes/${id}`, { auth: true }),
  updateSoapNote: (id, payload) =>
    apiFetch(`/api/soap-notes/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteSoapNote: (id) => apiFetch(`/api/soap-notes/${id}`, { method: 'DELETE', auth: true }),
  getSoapTestsAdvised: (soapNoteId) => apiFetch(`/api/soap-notes/${soapNoteId}/tests-advised`, { auth: true }),
  setSoapTestsAdvised: (soapNoteId, tests) =>
    apiFetch(`/api/soap-notes/${soapNoteId}/tests-advised`, { method: 'PUT', auth: true, body: { tests } }),

  listVaccinationsByPet: (petId) => apiFetch(`/api/pets/${petId}/vaccinations`, { auth: true }),
  createVaccination: (petId, payload) =>
    apiFetch(`/api/pets/${petId}/vaccinations`, { method: 'POST', auth: true, body: payload }),
  updateVaccination: (id, payload) =>
    apiFetch(`/api/vaccinations/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteVaccination: (id) => apiFetch(`/api/vaccinations/${id}`, { method: 'DELETE', auth: true }),

  listDewormingsByPet: (petId) => apiFetch(`/api/pets/${petId}/dewormings`, { auth: true }),
  createDeworming: (petId, payload) =>
    apiFetch(`/api/pets/${petId}/dewormings`, { method: 'POST', auth: true, body: payload }),
  updateDeworming: (id, payload) =>
    apiFetch(`/api/dewormings/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteDeworming: (id) => apiFetch(`/api/dewormings/${id}`, { method: 'DELETE', auth: true }),

  listPrescriptionsByPet: (petId) => apiFetch(`/api/pets/${petId}/prescriptions`, { auth: true }),
  createPrescription: (petId, payload) =>
    apiFetch(`/api/pets/${petId}/prescriptions`, { method: 'POST', auth: true, body: payload }),
  updatePrescription: (id, payload) =>
    apiFetch(`/api/prescriptions/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deletePrescription: (id) => apiFetch(`/api/prescriptions/${id}`, { method: 'DELETE', auth: true }),

  listLabResultsByPet: (petId) => apiFetch(`/api/pets/${petId}/lab-results`, { auth: true }),
  createLabResult: (petId, payload) =>
    apiFetch(`/api/pets/${petId}/lab-results`, { method: 'POST', auth: true, body: payload }),
  updateLabResult: (id, payload) =>
    apiFetch(`/api/lab-results/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteLabResult: (id) => apiFetch(`/api/lab-results/${id}`, { method: 'DELETE', auth: true }),

  listProceduresByPet: (petId) => apiFetch(`/api/pets/${petId}/procedures`, { auth: true }),
  createProcedure: (petId, payload) =>
    apiFetch(`/api/pets/${petId}/procedures`, { method: 'POST', auth: true, body: payload }),
  updateProcedure: (id, payload) =>
    apiFetch(`/api/procedures/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteProcedure: (id) => apiFetch(`/api/procedures/${id}`, { method: 'DELETE', auth: true }),

  listBodyWeightRecordsByPet: (petId) => apiFetch(`/api/pets/${petId}/body-weight-records`, { auth: true }),
  createBodyWeightRecord: (petId, payload) =>
    apiFetch(`/api/pets/${petId}/body-weight-records`, { method: 'POST', auth: true, body: payload }),
  updateBodyWeightRecord: (id, payload) =>
    apiFetch(`/api/body-weight-records/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteBodyWeightRecord: (id) => apiFetch(`/api/body-weight-records/${id}`, { method: 'DELETE', auth: true }),

  listReportsByPet: (petId) => apiFetch(`/api/pets/${petId}/reports`, { auth: true }),
  createReport: (petId, payload) =>
    apiFetch(`/api/pets/${petId}/reports`, { method: 'POST', auth: true, body: payload }),
  updateReport: (id, payload) => apiFetch(`/api/reports/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteReport: (id) => apiFetch(`/api/reports/${id}`, { method: 'DELETE', auth: true }),

  listVeterinarians: () => apiFetch('/api/veterinarians', { auth: true }),
  listRecentRecords: (limit) => apiFetch(`/api/records/recent${queryString({ limit })}`, { auth: true }),
  getRecordStats: () => apiFetch('/api/records/stats', { auth: true }),

  listDueReminders: (today) => apiFetch(`/api/reminders${queryString({ today })}`, { auth: true }),
  getReminderByEntity: (entityType, entityId) =>
    apiFetch(`/api/reminders/by-entity${queryString({ entityType, entityId })}`, { auth: true }),
  // Unlike getReminderByEntity above (returns one row, arbitrarily — fine
  // when there's at most one), this returns every non-dismissed reminder
  // for the entity — needed for 'pet', which can have several.
  listRemindersByEntity: (entityType, entityId) =>
    apiFetch(`/api/reminders/by-entity/list${queryString({ entityType, entityId })}`, { auth: true }),
  upsertReminder: (payload) => apiFetch('/api/reminders', { method: 'PUT', auth: true, body: payload }),
  dismissReminder: (id) => apiFetch(`/api/reminders/${id}/dismiss`, { method: 'PATCH', auth: true }),
  deleteReminderByEntity: (entityType, entityId) =>
    apiFetch(`/api/reminders${queryString({ entityType, entityId })}`, { method: 'DELETE', auth: true }),
  // Individually addressable by id — needed for pet-direct reminders,
  // which can be several per pet (deleteReminderByEntity/upsertReminder
  // above operate on "the" reminder for an entity, which only makes sense
  // when there's at most one).
  updateReminderById: (id, payload) => apiFetch(`/api/reminders/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteReminderById: (id) => apiFetch(`/api/reminders/${id}`, { method: 'DELETE', auth: true }),

  listClinicUsers: (params) => apiFetch(`/api/users${queryString(params)}`, { auth: true }),
  createClinicUser: (payload) => apiFetch('/api/users', { method: 'POST', auth: true, body: payload }),
  updateClinicUser: (userId, payload) =>
    apiFetch(`/api/users/${userId}`, { method: 'PATCH', auth: true, body: payload }),
  deleteClinicUser: (userId) => apiFetch(`/api/users/${userId}`, { method: 'DELETE', auth: true }),

  // Invite-based user creation — /api/invitations. Replaces the old
  // "Add User" direct-create flow in the desktop UI (username/password were
  // never collectible for someone who might already have an account on a
  // different clinic); the invitee sets those themselves on the backend's
  // own accept page.
  createInvitation: (payload) => apiFetch('/api/invitations', { method: 'POST', auth: true, body: payload }),
  listInvitations: (params) => apiFetch(`/api/invitations${queryString(params)}`, { auth: true }),
  resendInvitation: (invitationId) =>
    apiFetch(`/api/invitations/${invitationId}/resend`, { method: 'POST', auth: true }),
  revokeInvitation: (invitationId) => apiFetch(`/api/invitations/${invitationId}`, { method: 'DELETE', auth: true }),

  // Clinic-defined form templates (consent forms, waivers, intake forms) —
  // /api/forms. The backend only ever stores page image URLs + field
  // placements; the actual PDF-to-images conversion and Cloudinary upload
  // happen client-side (see handlers/formsHandlers.js).
  createForm: (payload) => apiFetch('/api/forms', { method: 'POST', auth: true, body: payload }),
  listForms: (params) => apiFetch(`/api/forms${queryString(params)}`, { auth: true }),
  getForm: (formId) => apiFetch(`/api/forms/${formId}`, { auth: true }),
  updateForm: (formId, payload) => apiFetch(`/api/forms/${formId}`, { method: 'PATCH', auth: true, body: payload }),
  deleteForm: (formId) => apiFetch(`/api/forms/${formId}`, { method: 'DELETE', auth: true }),

  listPlans: () => apiFetch('/api/plans', { auth: true }),
  selectPlan: (planId) =>
    apiFetch('/api/clinics/me/subscription', { method: 'POST', auth: true, body: { planId } }),
  getMyClinic: () => apiFetch('/api/clinics/me', { auth: true }),
  updateMyClinic: (payload) => apiFetch('/api/clinics/me', { method: 'PATCH', auth: true, body: payload }),

  listBankAccounts: () => apiFetch('/api/bank-accounts'),
  submitPaymentProof: (payload) =>
    apiFetch('/api/clinics/me/payment-submissions', { method: 'POST', auth: true, body: payload }),
  listMyPaymentSubmissions: (params) =>
    apiFetch(`/api/clinics/me/payment-submissions${queryString(params)}`, { auth: true }),

  // ── Services ────────────────────────────────────────────────────────────
  listServices: (params) => apiFetch(`/api/services${queryString(params)}`, { auth: true }),
  createService: (payload) => apiFetch('/api/services', { method: 'POST', auth: true, body: payload }),
  updateService: (id, payload) => apiFetch(`/api/services/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteService: (id) => apiFetch(`/api/services/${id}`, { method: 'DELETE', auth: true }),

  // ── Coupons ─────────────────────────────────────────────────────────────
  listCoupons: (params) => apiFetch(`/api/coupons${queryString(params)}`, { auth: true }),
  createCoupon: (payload) => apiFetch('/api/coupons', { method: 'POST', auth: true, body: payload }),
  updateCoupon: (id, payload) => apiFetch(`/api/coupons/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteCoupon: (id) => apiFetch(`/api/coupons/${id}`, { method: 'DELETE', auth: true }),
  applyCoupon: (payload) => apiFetch('/api/coupons/apply', { method: 'POST', auth: true, body: payload }),

  // ── Vendors ─────────────────────────────────────────────────────────────
  listVendors: (params) => apiFetch(`/api/vendors${queryString(params)}`, { auth: true }),
  createVendor: (payload) => apiFetch('/api/vendors', { method: 'POST', auth: true, body: payload }),
  updateVendor: (id, payload) => apiFetch(`/api/vendors/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteVendor: (id) => apiFetch(`/api/vendors/${id}`, { method: 'DELETE', auth: true }),
  getVendorSettlementPreview: (id, params) =>
    apiFetch(`/api/vendors/${id}/settlement-preview${queryString(params)}`, { auth: true }),
  createVendorSettlement: (id, payload) =>
    apiFetch(`/api/vendors/${id}/settlements`, { method: 'POST', auth: true, body: payload }),
  listVendorSettlements: (params) => apiFetch(`/api/vendors/settlements${queryString(params)}`, { auth: true }),
  getConsignmentPeriodSummary: (params) =>
    apiFetch(`/api/vendors/consignment-period-summary${queryString(params)}`, { auth: true }),

  // ── Products ────────────────────────────────────────────────────────────
  listProducts: (params) => apiFetch(`/api/products${queryString(params)}`, { auth: true }),
  createProduct: (payload) => apiFetch('/api/products', { method: 'POST', auth: true, body: payload }),
  updateProduct: (id, payload) => apiFetch(`/api/products/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteProduct: (id) => apiFetch(`/api/products/${id}`, { method: 'DELETE', auth: true }),
  searchProducts: (term) => apiFetch(`/api/products/search${queryString({ term })}`, { auth: true }),
  searchProductsByCategory: (term, category) =>
    apiFetch(`/api/products/search-by-category${queryString({ term, category })}`, { auth: true }),
  findProduct: (term) => apiFetch(`/api/products/find${queryString({ term })}`, { auth: true }),
  listProductTransactions: (params) => apiFetch(`/api/products/transactions${queryString(params)}`, { auth: true }),
  returnProductTransaction: (itemId, payload) =>
    apiFetch(`/api/products/transactions/${itemId}/return`, { method: 'POST', auth: true, body: payload }),

  // ── Billing (walk-in POS) ───────────────────────────────────────────────
  completeWalkInPayment: (payload) =>
    apiFetch('/api/billing/complete-payment', { method: 'POST', auth: true, body: payload }),
  previewBillingInvoice: (payload) => apiFetch('/api/billing/preview', { method: 'POST', auth: true, body: payload }),
  // Outstanding (credit/partial) product sales — parallel to the
  // appointment-scoped listClientUnpaidSummary/payAllClientAppointments
  // below, but sourced from Billing rows instead of Appointments.
  listProductBillingUnpaidClients: (params) =>
    apiFetch(`/api/billing/clients/unpaid-summary${queryString(params)}`, { auth: true }),
  getProductBillingUnpaidDetail: (clientId) =>
    apiFetch(`/api/billing/clients/${clientId}/unpaid-detail`, { auth: true }),
  payAllClientBilling: (clientId, payload) =>
    apiFetch(`/api/billing/clients/${clientId}/pay-all`, { method: 'POST', auth: true, body: payload }),
  // "Quick Bill" (desktop app's user-facing name) -> /api/billing/custom-invoice(s)
  // (the backend's storage/API name, deliberately unchanged — see billingHandlers.js).
  generateQuickBill: (payload) =>
    apiFetch('/api/billing/custom-invoice', { method: 'POST', auth: true, body: payload }),
  listQuickBills: (params) => apiFetch(`/api/billing/custom-invoices${queryString(params)}`, { auth: true }),
  updateQuickBill: (id, payload) =>
    apiFetch(`/api/billing/custom-invoice/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteQuickBill: (id) => apiFetch(`/api/billing/custom-invoice/${id}`, { method: 'DELETE', auth: true }),
  // Outstanding (credit/partial) quick bills — parallel to
  // listProductBillingUnpaidClients above, sourced from CustomInvoice rows.
  listQuickBillUnpaidClients: (params) =>
    apiFetch(`/api/billing/custom-invoices/clients/unpaid-summary${queryString(params)}`, { auth: true }),
  getQuickBillUnpaidDetail: (clientId) =>
    apiFetch(`/api/billing/custom-invoices/clients/${clientId}/unpaid-detail`, { auth: true }),
  payAllClientQuickBills: (clientId, payload) =>
    apiFetch(`/api/billing/custom-invoices/clients/${clientId}/pay-all`, { method: 'POST', auth: true, body: payload }),

  // ── Appointments ────────────────────────────────────────────────────────
  createAppointment: (payload) => apiFetch('/api/appointments', { method: 'POST', auth: true, body: payload }),
  listAppointments: (params) => apiFetch(`/api/appointments${queryString(params)}`, { auth: true }),
  getAppointmentForBilling: (id) => apiFetch(`/api/appointments/${id}/for-billing`, { auth: true }),
  getAppointmentInvoicePayload: (id) => apiFetch(`/api/appointments/${id}/invoice-payload`, { auth: true }),
  addAppointmentServiceLine: (id, payload) =>
    apiFetch(`/api/appointments/${id}/services`, { method: 'POST', auth: true, body: payload }),
  updateAppointmentServiceLine: (id, serviceLineId, payload) =>
    apiFetch(`/api/appointments/${id}/services/${serviceLineId}`, { method: 'PATCH', auth: true, body: payload }),
  removeAppointmentServiceLine: (id, serviceLineId) =>
    apiFetch(`/api/appointments/${id}/services/${serviceLineId}`, { method: 'DELETE', auth: true }),
  removeAppointmentServiceLineById: (serviceLineId) =>
    apiFetch(`/api/appointments/services/${serviceLineId}`, { method: 'DELETE', auth: true }),
  updateAppointmentStatus: (id, status) =>
    apiFetch(`/api/appointments/${id}/status`, { method: 'PATCH', auth: true, body: { status } }),
  updateAppointment: (id, payload) => apiFetch(`/api/appointments/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteAppointment: (id) => apiFetch(`/api/appointments/${id}`, { method: 'DELETE', auth: true }),

  // ── Appointment Payments ────────────────────────────────────────────────
  recordAppointmentPayment: (id, payload) =>
    apiFetch(`/api/appointments/${id}/payments`, { method: 'POST', auth: true, body: payload }),
  listAppointmentPayments: (params) => apiFetch(`/api/appointment-payments${queryString(params)}`, { auth: true }),
  getAppointmentPaymentDetails: (id) => apiFetch(`/api/appointments/${id}/payment-details`, { auth: true }),
  updateAppointmentPaymentStatus: (id, payload) =>
    apiFetch(`/api/appointments/${id}/payment-status`, { method: 'PATCH', auth: true, body: payload }),

  // ── Appointment Products (billed products, inventory usage, prediscount) ─
  getAppointmentInventoryUsage: (id) => apiFetch(`/api/appointments/${id}/inventory-usage`, { auth: true }),
  deductAppointmentInventory: (id, payload) =>
    apiFetch(`/api/appointments/${id}/inventory-usage`, { method: 'POST', auth: true, body: payload }),
  getAppointmentProducts: (id) => apiFetch(`/api/appointments/${id}/products`, { auth: true }),
  getAppointmentProductsDisplay: (id) => apiFetch(`/api/appointments/${id}/products/display`, { auth: true }),
  addAppointmentProduct: (id, payload) =>
    apiFetch(`/api/appointments/${id}/products`, { method: 'POST', auth: true, body: payload }),
  removeAppointmentProduct: (appointmentProductId) =>
    apiFetch(`/api/appointment-products/${appointmentProductId}`, { method: 'DELETE', auth: true }),
  getAppointmentPrediscount: (id) => apiFetch(`/api/appointments/${id}/prediscount`, { auth: true }),
  saveAppointmentPrediscount: (id, payload) =>
    apiFetch(`/api/appointments/${id}/prediscount`, { method: 'PUT', auth: true, body: payload }),
  removeAppointmentPrediscount: (id) => apiFetch(`/api/appointments/${id}/prediscount`, { method: 'DELETE', auth: true }),

  // ── Client Billing ──────────────────────────────────────────────────────
  getClientUnpaidLedger: (clientId) => apiFetch(`/api/clients/${clientId}/unpaid-ledger`, { auth: true }),
  listClientUnpaidSummary: (params) => apiFetch(`/api/clients/unpaid-summary${queryString(params)}`, { auth: true }),
  payAllClientAppointments: (clientId, payload) =>
    apiFetch(`/api/clients/${clientId}/pay-all`, { method: 'POST', auth: true, body: payload }),

  // ── Reports (financial/appointment/client analytics) ───────────────────
  getReportsData: (params) => apiFetch(`/api/reports${queryString(params)}`, { auth: true }),

  // ── AI text refinement / vision ─────────────────────────────────────────
  // Unlike the legacy EMR (which called Groq directly from the Electron
  // main process with the API key sitting in every desktop install's local
  // .env), this goes through the backend — the key lives server-side only.
  refineReminderNote: (text) =>
    apiFetch('/api/ai/refine-reminder-note', { method: 'POST', auth: true, body: { text } }),
  refineSoapText: ({ text, fieldLabel, context }) =>
    apiFetch('/api/ai/refine-soap-text', { method: 'POST', auth: true, body: { text, fieldLabel, context } }),
  scanProductImage: (imageBase64) =>
    apiFetch('/api/ai/scan-product-image', { method: 'POST', auth: true, body: { imageBase64 } }),

  // ── Boarding ─────────────────────────────────────────────────────────────
  listBoardingSpaceTypes: () => apiFetch('/api/boarding/space-types', { auth: true }),
  createBoardingSpaceType: (payload) => apiFetch('/api/boarding/space-types', { method: 'POST', auth: true, body: payload }),
  updateBoardingSpaceType: (id, payload) =>
    apiFetch(`/api/boarding/space-types/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteBoardingSpaceType: (id) => apiFetch(`/api/boarding/space-types/${id}`, { method: 'DELETE', auth: true }),
  listBoardingSpaceUnits: () => apiFetch('/api/boarding/space-units', { auth: true }),
  listFreeBoardingUnits: () => apiFetch('/api/boarding/space-units/free', { auth: true }),
  listBoardingSpaceUnitsWithStatus: () => apiFetch('/api/boarding/space-units/with-status', { auth: true }),

  getBoardingSettings: () => apiFetch('/api/boarding/settings', { auth: true }),
  updateBoardingSettings: (payload) => apiFetch('/api/boarding/settings', { method: 'PATCH', auth: true, body: payload }),

  checkInBoardingStay: (payload) => apiFetch('/api/boarding/stays', { method: 'POST', auth: true, body: payload }),
  listActiveBoardingStays: (params) => apiFetch(`/api/boarding/stays/active${queryString(params)}`, { auth: true }),
  listBoardingStaysForPet: (petId) => apiFetch(`/api/boarding/pets/${petId}/stays`, { auth: true }),
  getBoardingStay: (id) => apiFetch(`/api/boarding/stays/${id}`, { auth: true }),
  updateBoardingStay: (id, payload) => apiFetch(`/api/boarding/stays/${id}`, { method: 'PATCH', auth: true, body: payload }),
  deleteBoardingStay: (id) => apiFetch(`/api/boarding/stays/${id}`, { method: 'DELETE', auth: true }),
  previewBoardingCheckout: (id) => apiFetch(`/api/boarding/stays/${id}/checkout-preview`, { auth: true }),
  checkoutBoardingStay: (id, payload) =>
    apiFetch(`/api/boarding/stays/${id}/checkout`, { method: 'POST', auth: true, body: payload }),

  logBoardingFeeding: (stayId, payload) =>
    apiFetch(`/api/boarding/stays/${stayId}/feeding`, { method: 'POST', auth: true, body: payload }),
  listBoardingCareLog: (stayId) => apiFetch(`/api/boarding/stays/${stayId}/care-log`, { auth: true }),

  addBoardingMedication: (stayId, payload) =>
    apiFetch(`/api/boarding/stays/${stayId}/medications`, { method: 'POST', auth: true, body: payload }),
  listBoardingMedications: (stayId) => apiFetch(`/api/boarding/stays/${stayId}/medications`, { auth: true }),
  markBoardingMedicationGiven: (medicationId, payload) =>
    apiFetch(`/api/boarding/medications/${medicationId}/administer`, { method: 'POST', auth: true, body: payload }),
  discontinueBoardingMedication: (medicationId) =>
    apiFetch(`/api/boarding/medications/${medicationId}/discontinue`, { method: 'POST', auth: true }),

  recordBoardingPayment: (stayId, payload) =>
    apiFetch(`/api/boarding/stays/${stayId}/payment`, { method: 'POST', auth: true, body: payload }),

  getBoardingConsentPayload: (stayId) => apiFetch(`/api/boarding/stays/${stayId}/consent-payload`, { auth: true }),
  getBoardingSummaryPayload: (stayId, params) =>
    apiFetch(`/api/boarding/stays/${stayId}/summary-payload${queryString(params)}`, { auth: true }),

  // Boarding-scoped vitals reads — createSoapNote (with a boardingStayId in
  // its payload) already exists above for pet-scoped SOAP notes generally.
  listSoapNotesByBoardingStay: (boardingStayId) =>
    apiFetch(`/api/soap-notes/by-boarding-stay/${boardingStayId}`, { auth: true }),
  hasBoardingVitalsCheck: (boardingStayId) =>
    apiFetch(`/api/soap-notes/by-boarding-stay/${boardingStayId}/exists`, { auth: true }),
};
