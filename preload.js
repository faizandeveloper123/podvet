const { contextBridge, ipcRenderer } = require('electron');

// contextBridge can't serialize undefined through the structured-clone
// boundary — wrap every invoke so callers never break.
const invoke = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args.map(a => a === undefined ? null : a));

//PetVet Pro

contextBridge.exposeInMainWorld('electronAPI', {
    // Multi-tenant auth (centralized backend, not the per-clinic MySQL)
    login: (credentials) => invoke('login', credentials),
    clinicSignup: (payload) => invoke('clinic-signup', payload),
    switchClinic: (payload) => invoke('switch-clinic', payload),
    getSession: () => invoke("get-session"),
    resumeSession: () => invoke("resume-session"),
    forgotPassword: (payload) => invoke('forgot-password', payload),
    listPlans: () => invoke('list-plans'),
    selectPlan: (planId) => invoke('select-plan', planId),
    getMyClinic: () => invoke('get-my-clinic'),
    listBankAccounts: () => invoke('list-bank-accounts'),
    submitPaymentProof: (payload) => invoke('submit-payment-proof', payload),
    listMyPaymentSubmissions: (params) => invoke('list-my-payment-submissions', params),
    insertUser: (user) => invoke("create-user", user),
    inviteUser: (invite) => invoke("invite-user", invite),
    listInvitations: (page, query) => invoke("list-invitations", page, query),
    resendInvitation: (invitationId) => invoke("resend-invitation", invitationId),
    revokeInvitation: (invitationId) => invoke("revoke-invitation", invitationId),
    uploadFormPageImage: (dataUrl) => invoke("upload-form-page-image", dataUrl),
    createForm: (form) => invoke("create-form", form),
    listForms: (page, query) => invoke("list-forms", page, query),
    getForm: (formId) => invoke("get-form", formId),
    updateForm: (form) => invoke("update-form", form),
    deleteForm: (formId) => invoke("delete-form", formId),
    printFilledForm: (pdfDataUri) => invoke("print-filled-form", { pdfDataUri }),
    addEmployee: (employee) => invoke("add-employee", employee),
    retrieveEmployees: (page, query) => invoke("retrieve-employees", page, query),
    retrieveUsers: (page, query) => invoke("retrieve-users", page, query),
    editEmployee : (employee) => invoke('edit-employee',employee),
    deleteEmployee: (employeeId) => invoke("delete-employee", employeeId),
    deleteUser: (userId) => invoke("delete-user", userId),
    addService : (service) => invoke('add-service',service),
    retrieveServices : () => invoke('retrieve-services'),
    editService : (service) => invoke('edit-service',service),
    deleteService : (serviceId) => invoke('delete-service',serviceId),
    getServices: () => invoke('get-services'),
    // Grooming 
    addGrooming : (service) => invoke('add-grooming',service),
    retrieveGrooming : () => invoke('retrieve-grooming'),
    editGrooming : (service) => invoke('edit-grooming',service),
    // Profile management
    updateProfile: (profileData) => invoke('update-profile', profileData),
    changePassword: (passwordData) => invoke('change-password', passwordData),
    getFirstTimeFee: () => invoke('get-first-time-fee'),
    setFirstTimeFee: (fee) => invoke('set-first-time-fee', fee),
    getDiscountRange: () => invoke('get-discount-range'),
    setDiscountRange: (data) => invoke('set-discount-range', data),
    recordAppointmentPayment: (data) => invoke('record-appointment-payment', data),
    getAppointmentInventoryUsage: (appointmentId) =>
      invoke('get-appointment-inventory-usage', appointmentId),
    deductAppointmentInventory: (data) => invoke('deduct-appointment-inventory', data),
    getPaymentsList: (params) => invoke('get-payments-list', params),
    getAppointmentPaymentDetails: (appointmentId) => invoke('get-appointment-payment-details', appointmentId),
    resetPassword: (payload) => invoke('reset-password', payload),
  
    // Data management
    exportData: (options) => invoke('export-data', options),
    importData: (filePath) => invoke('import-data', filePath),
  
    // Client Management
    retrieveClients: (page, query) => invoke('retrieve-clients', page, query),
    addClient: (clientData) => invoke('add-client', clientData),
    updateClient: (clientId, clientData) => invoke('update-client', clientId, clientData),
    deleteClient: (clientId) => invoke('delete-client', clientId),
    searchClients: (query) => invoke('search-clients', query),
    createClientAndPet: (data) => invoke('create-client-and-pet', data),
    checkDuplicatePhoneNumber: (phoneNumber, excludeClientId) => invoke('check-duplicate-phone-number', phoneNumber, excludeClientId),
     
    // Pet Management
    retrievePetsByClient: (clientId) => invoke('retrieve-pets-by-client', clientId),
    addPet: (petData) => invoke('add-pet', petData),
    updatePet: (petId, petData) => invoke('update-pet', petId, petData),
    deletePet: (petId) => invoke('delete-pet', petId),
    getClientPets: (clientId) => invoke('get-client-pets', clientId),

    // Products Management
    retrieveProducts: (params) => invoke("retrieve-products", params),
    addProduct: (product) => invoke("add-product", product),
    editProduct: (product) => invoke("edit-product", product),
    deleteProduct: (productId) => invoke("delete-product", productId),
    scanProductsCsv: () => invoke("scan-products-csv"),
    confirmProductsImport: (payloads) => invoke("confirm-products-import", payloads),
    retrieveVendors: () => invoke("retrieve-vendors"),
    retrieveVendorsPage: (params) => invoke("retrieve-vendors-page", params),
    getVendorConsignmentPeriodSummary: (params) =>
      invoke("get-vendor-consignment-period-summary", params),
    addVendor: (vendor) => invoke("add-vendor", vendor),
    editVendor: (vendor) => invoke("edit-vendor", vendor),
    deleteVendor: (vendorId) => invoke("delete-vendor", vendorId),
    getVendorSettlementPreview: (params) => invoke("get-vendor-settlement-preview", params),
    createVendorSettlement: (payload) => invoke("create-vendor-settlement", payload),
    retrieveVendorSettlements: (vendorId) => invoke("retrieve-vendor-settlements", vendorId),
    // Add to your existing contextBridge.exposeInMainWorld
    getClientUnpaidSummary: (params) => invoke('get-client-unpaid-summary', params),
    generateClientUnpaidLedger: (params) => invoke('generate-client-unpaid-ledger', params),
    payAllClientAppointments: (data) => invoke('pay-all-client-appointments', data),

    // Outstanding Product Sales (walk-in Billing credit/partial sales)
    getProductBillingUnpaidClients: (params) => invoke('get-product-billing-unpaid-clients', params),
    getProductBillingUnpaidDetail: (clientId) => invoke('get-product-billing-unpaid-detail', clientId),
    payAllClientBilling: (data) => invoke('pay-all-client-billing', data),

    // Coupons Management
    retrieveCoupons: (params) => invoke("retrieve-coupons", params),
    addCoupon: (coupon) => invoke("add-coupon", coupon),
    editCoupon: (coupon) => invoke("edit-coupon", coupon),
    deleteCoupon: (couponId) => invoke("delete-coupon", couponId),
    searchProducts: (term) => invoke("search-products", term),
    searchProductsByCategory: (term, category) => invoke("search-products-by-category", term, category),
    // Find product by barcode or name
    findProduct: (searchTerm) => invoke("find-product", searchTerm),
    // Apply coupon
    applyCoupon: (couponCode) => invoke("apply-coupon", couponCode),
    // Save completed invoice
    completePayment: (data) => invoke("complete-payment", data),

    // Preview Billing Invoice
    previewBillingInvoice: (data) => invoke("preview-billing-invoice", data),
    generateQuickBill: (data) => invoke('generate-quick-bill', data),
    getQuickBills: (params) => invoke('get-quick-bills', params),
    updateQuickBill: (data) => invoke('update-quick-bill', data),
    deleteQuickBill: (id) => invoke('delete-quick-bill', { id }),

    // Outstanding Quick Bills (custom-invoice credit/partial sales)
    getQuickBillUnpaidClients: (params) => invoke('get-quick-bill-unpaid-clients', params),
    getQuickBillUnpaidDetail: (clientId) => invoke('get-quick-bill-unpaid-detail', clientId),
    payAllClientQuickBills: (data) => invoke('pay-all-client-quick-bills', data),

    generateAppointmentInvoice: (appointmentId) =>
      invoke("generate-appointment-invoice", appointmentId),

    // Appointment Management
    getAppointments: (params) => invoke('get-appointments', params),
    createAppointment: (appointmentData) => invoke('create-appointment', appointmentData),
    updateAppointmentStatus: (appointmentId, status) => invoke('update-appointment-status', appointmentId, status),
    updateAppointment: (data) => invoke('update-appointment', data),
    deleteAppointment: (appointmentId) => invoke('delete-appointment', appointmentId),
    updateAppointmentPaymentStatus: (appointmentId, paymentStatus, couponCode = null) => invoke('update-appointment-payment-status', appointmentId, paymentStatus, couponCode),
    getAppointmentForBilling: (appointmentId) => invoke('get-appointment-for-billing', appointmentId),
    updateAppointmentService: (data) => invoke('update-appointment-service', data),
    removeAppointmentService: (appointmentServiceId) => invoke('remove-appointment-service', appointmentServiceId),
    addServiceToAppointment: (data) => invoke('add-service-to-appointment', data),
    reprintAppointmentInvoice: (id) => invoke("reprint-appointment-invoice", id),
    // Consent Form Generation
    generateConsentForm: (appointmentData) => invoke('generate-consent-form', appointmentData),

    // File management
    openFileDialog: () => invoke('open-file-dialog'),
    debugExcel: (filePath) => invoke('debug-excel', filePath),

    // Reports Management
    getReportsData: (filters) => invoke('get-reports-data', filters),
    getUpcomingBirthdays: () => invoke('get-upcoming-birthdays'),

    // Reminders
    getReminders: (params) => invoke('get-reminders', params),
    getReminderByEntity: (entity_type, entity_id) => invoke('get-reminder-by-entity', { entity_type, entity_id }),
    listRemindersByEntity: (entity_type, entity_id) => invoke('list-reminders-by-entity', { entity_type, entity_id }),
    addReminder: (data) => invoke('add-reminder', data),
    dismissReminder: (id) => invoke('dismiss-reminder', id),
    deleteReminder: (entity_type, entity_id) => invoke('delete-reminder', { entity_type, entity_id }),
    // By-id — for individually editing/removing one pet-direct reminder
    // out of several (deleteReminder above deletes ALL reminders for an
    // entity, which is wrong once an entity can carry more than one).
    updateReminder: (data) => invoke('update-reminder', data),
    deleteReminderById: (id) => invoke('delete-reminder-by-id', id),

    // Expense Categories
    getExpenseCategories: () => invoke('get-expense-categories'),
    addExpenseCategory: (data) => invoke('add-expense-category', data),
    updateExpenseCategory: (data) => invoke('update-expense-category', data),
    deleteExpenseCategory: (id) => invoke('delete-expense-category', id),

    // Expenses
    getExpenses: (filters) => invoke('get-expenses', filters),
    addExpense: (data) => invoke('add-expense', data),
    updateExpense: (data) => invoke('update-expense', data),
    deleteExpense: (id) => invoke('delete-expense', id),
    getExpenseTotal: (filters) => invoke('get-expense-total', filters),
    downloadExpensePDF: (filters) => invoke('download-expense-pdf', filters),
    
    openWhatsApp: (url) => invoke('open-whatsapp', url),

    updateUser: (data) => invoke('update-user', data),

    printPOSSlip: (data) => invoke("print-pos-slip", data),
    
    isLabPrintEnabled: () => invoke("is-lab-print-enabled"),
    printLabSlip: (data) => invoke("print-lab-slip", data),
    printPdfBuffer: (data, fileName) => invoke("print-pdf-buffer", { data, fileName }),
    printPdfFile: (filePath) => invoke("print-pdf-file", filePath),

    deleteTransaction: (data) => invoke('delete-transaction', data),

    getAppointmentInvoicePayload: (appointmentId) =>
  invoke("get-appointment-invoice-payload", appointmentId),

  getProductsTransactions: (filters) => invoke('get-products-transactions', filters),
deleteProductTransaction: (payload) => invoke('delete-product-transaction', payload),
getExpensesList: (filters) => invoke('get-expenses-list', filters),

getTimeFormat: () => invoke("get-time-format"),
setTimeFormat: (data) => invoke("set-time-format", data),

  // EMR handlers
  recordsSearchPets:      (query) => invoke('records-search-pets', query),
  recordsGetRecent:       (opts)  => invoke('records-get-recent', opts),
  recordsGetStats:        ()      => invoke('records-get-stats'),
  recordsGetRecentVisitSummary: (petId) => invoke('records-get-recent-visit-summary', petId),
  recordsGetSoapNotes:    (petId) => invoke('records-get-soap-notes', petId),
  recordsGetSoapNoteByAppointment: (appointmentId) => invoke('records-get-soap-note-by-appointment', appointmentId),
  recordsAddSoapNote:     (data)  => invoke('records-add-soap-note', data),
  recordsUpdateSoapNote:  (data)  => invoke('records-update-soap-note', data),
  recordsDeleteSoapNote:  (id)    => invoke('records-delete-soap-note', id),
  recordsGetVaccinations:   (petId) => invoke('records-get-vaccinations', petId),
  recordsAddVaccination:    (data)  => invoke('records-add-vaccination', data),
  recordsDeleteVaccination: (id)    => invoke('records-delete-vaccination', id),
  recordsGetPrescriptions:   (petId) => invoke('records-get-prescriptions', petId),
  recordsAddPrescription:    (data)  => invoke('records-add-prescription', data),
  recordsDeletePrescription: (id)    => invoke('records-delete-prescription', id),
  recordsGetLabResults:   (petId) => invoke('records-get-lab-results', petId),
  recordsAddLabResult:    (data)  => invoke('records-add-lab-result', data),
  recordsDeleteLabResult: (id)    => invoke('records-delete-lab-result', id),
  recordsGetProcedures:   (petId) => invoke('records-get-procedures', petId),
  recordsAddProcedure:    (data)  => invoke('records-add-procedure', data),
  recordsDeleteProcedure: (id)    => invoke('records-delete-procedure', id),
  recordsUpdateVaccination: (data) => invoke('records-update-vaccination', data),
  recordsUpdatePrescription: (data) => invoke('records-update-prescription', data),
  recordsUpdateLabResult: (data) => invoke('records-update-lab-result', data),
  recordsUpdateProcedure: (data) => invoke('records-update-procedure', data),
  getVeterinarians: () => invoke('get-veterinarians'),
  generatePrescriptionPdf: (data) => invoke('generate-prescription-pdf', data),
  recordsGetSoapTestsAdvised: (soapNoteId) => invoke('records-get-soap-tests-advised', soapNoteId),
recordsSetSoapTestsAdvised: (data)       => invoke('records-set-soap-tests-advised', data),
recordsGetDewormings:    (petId) => invoke('records-get-dewormings', petId),
recordsAddDeworming:     (data)  => invoke('records-add-deworming', data),
recordsUpdateDeworming:  (data)  => invoke('records-update-deworming', data),
recordsDeleteDeworming:  (id)    => invoke('records-delete-deworming', id),
recordsGetBodyWeightRecords:    (petId) => invoke('records-get-body-weight-records', petId),
recordsAddBodyWeightRecord:     (data)  => invoke('records-add-body-weight-record', data),
recordsUpdateBodyWeightRecord:  (data)  => invoke('records-update-body-weight-record', data),
recordsDeleteBodyWeightRecord:  (id)    => invoke('records-delete-body-weight-record', id),
  
  pickLogoFileSelect: () => invoke("pick-logo-file-select"),
getLogoPreview: (filePath) => invoke("get-logo-preview", filePath),

setBrandingSettings: (data) => invoke("set-branding-settings", data),
getBrandingSettings: ()     => invoke("get-branding-settings"),

// Pre-payment discounts
getAppointmentPrediscount:    (data) => invoke('get-appointment-prediscount', data),
saveAppointmentPrediscount:   (data) => invoke('save-appointment-prediscount', data),
removeAppointmentPrediscount: (data) => invoke('remove-appointment-prediscount', data),

  getAppointmentProducts: (appointmentId) =>
  invoke('get-appointment-products', appointmentId),
  getAppointmentProductsDisplay: (appointmentId) =>
  invoke("get-appointment-products-display", appointmentId),
  addAppointmentProduct: (data) => invoke('add-appointment-product', data),
  removeAppointmentProduct: (data) => invoke('remove-appointment-product', data),


  patientsGetList:     (opts)  => invoke('patients-get-list', opts),
  patientsGetSpecies:  ()      => invoke('patients-get-species'),
  patientsGetPet:      (id)    => invoke('patients-get-pet', id),
  patientsGetSoapNotes:(id)    => invoke('patients-get-soap-notes', id),

  scanProductImage: (args) => invoke("scan-product-image", args),
  refineSoapText: (data) => invoke("refine-soap-text", data),
  refineReminderNote: (data) => invoke("refine-reminder-note", data),

  recordsGetReports: (petId) => invoke("records-get-reports", petId),
  recordsAddReport: (payload) => invoke("records-add-report", payload),
  recordsUpdateReport: (payload) => invoke("records-update-report", payload),
  recordsDeleteReport: (id) => invoke("records-delete-report", id),
  openExternalLink: (url) => invoke("open-external-link", url),

  // Auto-update
  onUpdateEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update-event', listener);
    return () => ipcRenderer.removeListener('update-event', listener);
  },
  restartAppToUpdate: () => invoke('restart-app-to-update'),

  // Subscription enforcement — fired whenever any SaaS API call comes back
  // 402 (no plan / expired / clinic suspended); see handlers/saasClient.js.
  onSubscriptionBlocked: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('subscription-blocked', listener);
    return () => ipcRenderer.removeListener('subscription-blocked', listener);
  },

  // Session expiry — fired when tryRefresh() determines the refresh token
  // itself is dead (expired/revoked/blacklisted), not just racing another
  // refresh; see handlers/saasClient.js.
  onSessionExpired: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('session-expired', listener);
    return () => ipcRenderer.removeListener('session-expired', listener);
  },

  // Fired when the user clicks a native reminder notification (see
  // handlers/reminderNotifications.js) — payload is the route to switch to.
  onNavigateTo: (callback) => {
    const listener = (_event, targetPath) => callback(targetPath);
    ipcRenderer.on('navigate-to', listener);
    return () => ipcRenderer.removeListener('navigate-to', listener);
  },

  // Notification bell (top nav) — same fired-reminder records that drive
  // the native OS notifications, see handlers/reminderNotifications.js.
  getReminderNotifications: () => invoke('get-reminder-notifications'),
  markReminderNotificationRead: (id) => invoke('mark-reminder-notification-read', id),
  // No payload — just a signal that the background checker fired a new
  // notification, so the bell should refetch getReminderNotifications().
  onReminderNotificationsUpdated: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('reminder-notifications-updated', listener);
    return () => ipcRenderer.removeListener('reminder-notifications-updated', listener);
  },

  // Branches
  branchesGetAll: () => invoke('branches-get-all'),
  branchesAdd: (branch) => invoke('branches-add', branch),
  branchesUpdate: (branch) => invoke('branches-update', branch),
  branchesUpdateContactInfo: (data) => invoke('branches-update-contact-info', data),
  branchesDelete: (branchId) => invoke('branches-delete', branchId),

  // Clinic branding (shared logo/name/color — see get-branding-settings/
  // set-branding-settings for the legacy per-machine electron-store version,
  // still used for bank details/POS toggles which this migration didn't touch)
  brandingGet: () => invoke('branding-get'),
  brandingUpdate: (data) => invoke('branding-update', data),
  brandingUploadLogo: (dataUrl) => invoke('branding-upload-logo', dataUrl),

  logout: () => invoke("logout"),

  // Boarding
  boardingGetCageTypes: () => invoke("boarding-get-cage-types"),
  boardingAddCageType: (data) => invoke("boarding-add-cage-type", data),
  boardingUpdateCageType: (data) => invoke("boarding-update-cage-type", data),
  boardingDeleteCageType: (id) => invoke("boarding-delete-cage-type", { id }),
  boardingGetSettings: () => invoke("boarding-get-settings"),
  boardingUpdateSettings: (data) => invoke("boarding-update-settings", data),
  boardingGetCageUnits: () => invoke("boarding-get-cage-units"),
  boardingGetFreeUnits: () => invoke("boarding-get-free-units"),
  boardingGetCageUnitsWithStatus: () => invoke("boarding-get-cage-units-with-status"),
  boardingCreateStay: (data) => invoke("boarding-create-stay", data),
  boardingGetStay: (id) => invoke("boarding-get-stay", { id }),
  boardingUpdateStay: (data) => invoke("boarding-update-stay", data),
  boardingDeleteStay: (id) => invoke("boarding-delete-stay", { id }),
  boardingPreviewCheckoutBilling: (id) => invoke("boarding-preview-checkout-billing", { id }),
  boardingCheckoutStay: (data) => invoke("boarding-checkout-stay", data),
  boardingGetActiveStays: (params) => invoke("boarding-get-active-stays", params),
  boardingGetStaysForPet: (petId) => invoke("boarding-get-stays-for-pet", { pet_id: petId }),
  boardingLogFeeding: (data) => invoke("boarding-log-feeding", data),
  boardingGetCareLog: (stayId) => invoke("boarding-get-care-log", { stay_id: stayId }),
  boardingGetVitalsHistory: (stayId) => invoke("boarding-get-vitals-history", { stay_id: stayId }),
  boardingHasVitalsCheck: (stayId) => invoke("boarding-has-vitals-check", { stay_id: stayId }),
  boardingAddMedication: (data) => invoke("boarding-add-medication", data),
  boardingGetMedications: (stayId) => invoke("boarding-get-medications", { stay_id: stayId }),
  boardingLogMedicationAdministered: (data) => invoke("boarding-log-medication-administered", data),
  boardingDiscontinueMedication: (medicationId) => invoke("boarding-discontinue-medication", { medication_id: medicationId }),
  recordBoardingPayment: (data) => invoke("record-boarding-payment", data),
  boardingSaveCheckoutInvoice: (stayId) => invoke("boarding-save-checkout-invoice", { stay_id: stayId }),
  boardingPreviewCheckoutInvoice: (data) => invoke("boarding-preview-checkout-invoice", data),
  boardingPrintCheckoutInvoice: (data) => invoke("boarding-print-checkout-invoice", data),
  boardingPreviewConsentForm: (stayId) => invoke("boarding-preview-consent-form", { stay_id: stayId }),
  boardingPrintConsentForm: (stayId) => invoke("boarding-print-consent-form", { stay_id: stayId }),
  boardingPreviewHospitalizationSummary: (stayId) => invoke("boarding-preview-hospitalization-summary", { stay_id: stayId }),
  boardingPrintHospitalizationSummary: (stayId) => invoke("boarding-print-hospitalization-summary", { stay_id: stayId }),
  boardingPreviewDailySummary: (data) => invoke("boarding-preview-daily-summary", data),
  boardingPrintDailySummary: (data) => invoke("boarding-print-daily-summary", data)
});