const { ipcMain, BrowserWindow } = require("electron");
const { saveLocalImage } = require("./utils");
const saasClient = require("./saasClient");

const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Medical records (EMR) — backed by the multi-tenant API's /api/pets/:petId/
// soap-notes, /api/vaccinations, /api/prescriptions, etc. Not branch-scoped
// (same as Clients/Pets — see handlers/clientsHandlers.js): a record can be
// seen and edited from any branch of the same clinic, since branch-level
// data scoping hasn't been carried over to the new backend for any module
// yet. See handlers/patientHandlers.js — now retired, its one read
// (patients-get-soap-notes) merged in here since SOAP notes moved too.

// API responses are camelCase; every renderer screen (Records.jsx,
// Patients.jsx, generateSummaryPDF.js, etc.) still expects the legacy
// snake_case shape — translated here so nothing downstream needs to change
// just because the data now comes from HTTP instead of SQL.

function toDateOnlyStr(isoString) {
  if (!isoString) return null;
  return String(isoString).slice(0, 10);
}

function isNotFound(err) {
  return err?.status === 404 || err?.code === "NOT_FOUND";
}

// ─── SOAP Notes ─────────────────────────────────────────────────────────
function toLocalSoapNote(n) {
  return {
    id: n.id,
    pet_id: n.petId,
    appointment_id: n.appointmentId,
    doctor: n.doctor,
    subjective: n.subjective,
    objective: n.objective,
    assessment: n.assessment,
    diagnosis: n.diagnosis,
    plan: n.plan,
    temperature: n.temperature,
    temperature_input_unit: n.temperatureInputUnit,
    heart_rate: n.heartRate,
    respiratory_rate: n.respiratoryRate,
    weight: n.weight,
    weight_input_unit: n.weightInputUnit,
    bcs: n.bcs,
    mucous_membrane: n.mucousMembrane,
    crt: n.crt,
    crt_under_2: n.crtUnder2,
    pulse_quality: n.pulseQuality,
    hydration_status: n.hydrationStatus,
    mentation: n.mentation,
    visit_type: n.visitType,
    condition_status: n.conditionStatus,
    is_pregnant: n.isPregnant,
    has_anemia: n.hasAnemia,
    vaccination_given: n.vaccinationGiven,
    deworming_given: n.dewormingGiven,
    diarrhea_type: n.diarrheaType,
    vomit_type: n.vomitType,
    ddx: n.ddx,
    prognosis: n.prognosis,
    next_visit_days: n.nextVisitDays,
    exam_eyes_normal: n.examEyesNormal,
    exam_eyes_note: n.examEyesNote,
    exam_ears_normal: n.examEarsNormal,
    exam_ears_note: n.examEarsNote,
    exam_oral_normal: n.examOralNormal,
    exam_oral_note: n.examOralNote,
    exam_skin_normal: n.examSkinNormal,
    exam_skin_note: n.examSkinNote,
    exam_lymph_normal: n.examLymphNormal,
    exam_lymph_note: n.examLymphNote,
    exam_cardio_normal: n.examCardioNormal,
    exam_cardio_note: n.examCardioNote,
    exam_resp_normal: n.examRespNormal,
    exam_resp_note: n.examRespNote,
    exam_gi_normal: n.examGiNormal,
    exam_gi_note: n.examGiNote,
    exam_musculo_normal: n.examMusculoNormal,
    exam_musculo_note: n.examMusculoNote,
    exam_neuro_normal: n.examNeuroNormal,
    exam_neuro_note: n.examNeuroNote,
    exam_uro_normal: n.examUroNormal,
    exam_uro_note: n.examUroNote,
    exam_eyes_discharge_type: n.examEyesDischargeType,
    exam_eyes_color: n.examEyesColor,
    exam_eyes_cornea: n.examEyesCornea,
    exam_eyes_pupils: n.examEyesPupils,
    exam_ears_discharge_type: n.examEarsDischargeType,
    exam_ears_odor: n.examEarsOdor,
    exam_ears_appearance: n.examEarsAppearance,
    exam_ears_pain: n.examEarsPain,
    doctor_notes: n.doctorNotes,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    tests_advised: n.testsAdvised || [],
  };
}

function toApiSoapNotePayload(p) {
  return {
    appointmentId: p.appointment_id ?? null,
    // Set from the Boarding screen's "Check Vitals" flow (see
    // BoardingVitalsModal.jsx) — links this note back to the stay it was
    // taken during, same nullable convention as appointmentId.
    boardingStayId: p.boarding_stay_id ?? null,
    doctor: p.doctor || undefined,
    subjective: p.subjective || undefined,
    objective: p.objective || undefined,
    assessment: p.assessment || undefined,
    diagnosis: p.diagnosis || undefined,
    plan: p.plan || undefined,
    temperature: p.temperature ?? undefined,
    temperatureInputUnit: p.temperature_input_unit || undefined,
    heartRate: p.heart_rate ?? undefined,
    respiratoryRate: p.respiratory_rate ?? undefined,
    weight: p.weight ?? undefined,
    weightInputUnit: p.weight_input_unit || undefined,
    bcs: p.bcs ?? undefined,
    mucousMembrane: p.mucous_membrane || undefined,
    crt: p.crt ?? undefined,
    crtUnder2: p.crt_under_2 ?? undefined,
    pulseQuality: p.pulse_quality || undefined,
    hydrationStatus: p.hydration_status || undefined,
    mentation: p.mentation || undefined,
    visitType: p.visit_type || undefined,
    conditionStatus: p.condition_status || undefined,
    isPregnant: p.is_pregnant ?? undefined,
    hasAnemia: p.has_anemia ?? undefined,
    vaccinationGiven: p.vaccination_given ?? undefined,
    dewormingGiven: p.deworming_given ?? undefined,
    diarrheaType: p.diarrhea_type || undefined,
    vomitType: p.vomit_type || undefined,
    ddx: p.ddx || undefined,
    prognosis: p.prognosis || undefined,
    nextVisitDays: p.next_visit_days ?? undefined,
    examEyesNormal: p.exam_eyes_normal ?? undefined,
    examEyesNote: p.exam_eyes_note || undefined,
    examEarsNormal: p.exam_ears_normal ?? undefined,
    examEarsNote: p.exam_ears_note || undefined,
    examOralNormal: p.exam_oral_normal ?? undefined,
    examOralNote: p.exam_oral_note || undefined,
    examSkinNormal: p.exam_skin_normal ?? undefined,
    examSkinNote: p.exam_skin_note || undefined,
    examLymphNormal: p.exam_lymph_normal ?? undefined,
    examLymphNote: p.exam_lymph_note || undefined,
    examCardioNormal: p.exam_cardio_normal ?? undefined,
    examCardioNote: p.exam_cardio_note || undefined,
    examRespNormal: p.exam_resp_normal ?? undefined,
    examRespNote: p.exam_resp_note || undefined,
    examGiNormal: p.exam_gi_normal ?? undefined,
    examGiNote: p.exam_gi_note || undefined,
    examMusculoNormal: p.exam_musculo_normal ?? undefined,
    examMusculoNote: p.exam_musculo_note || undefined,
    examNeuroNormal: p.exam_neuro_normal ?? undefined,
    examNeuroNote: p.exam_neuro_note || undefined,
    examUroNormal: p.exam_uro_normal ?? undefined,
    examUroNote: p.exam_uro_note || undefined,
    examEyesDischargeType: p.exam_eyes_discharge_type || undefined,
    examEyesColor: p.exam_eyes_color || undefined,
    examEyesCornea: p.exam_eyes_cornea || undefined,
    examEyesPupils: p.exam_eyes_pupils || undefined,
    examEarsDischargeType: p.exam_ears_discharge_type || undefined,
    examEarsOdor: p.exam_ears_odor || undefined,
    examEarsAppearance: p.exam_ears_appearance || undefined,
    examEarsPain: p.exam_ears_pain ?? undefined,
    doctorNotes: p.doctor_notes || undefined,
  };
}

module.exports = function setupRecordHandlers() {
ipcMain.handle("records-get-soap-notes", async (_event, petId) => {
  try {
    const result = await saasClient.listSoapNotesByPet(petId);
    return { success: true, data: result.data.map(toLocalSoapNote) };
  } catch (err) {
    console.error("[records-get-soap-notes]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-get-soap-note-by-appointment", async (_event, appointmentId) => {
  try {
    const result = await saasClient.getSoapNoteByAppointment(appointmentId);
    return { success: true, data: toLocalSoapNote(result.data) };
  } catch (err) {
    if (isNotFound(err)) return { success: true, data: null };
    console.error("[records-get-soap-note-by-appointment]", err);
    return { success: false, message: err.message, data: null };
  }
});

ipcMain.handle("records-add-soap-note", async (_event, payload) => {
  try {
    const result = await saasClient.createSoapNote(payload.pet_id, toApiSoapNotePayload(payload));
    return { success: true, id: result.data.id, message: "SOAP note saved." };
  } catch (err) {
    console.error("[records-add-soap-note]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-update-soap-note", async (_event, payload) => {
  try {
    await saasClient.updateSoapNote(payload.id, toApiSoapNotePayload(payload));
    return { success: true, message: "SOAP note updated." };
  } catch (err) {
    console.error("[records-update-soap-note]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-delete-soap-note", async (_event, id) => {
  try {
    await saasClient.deleteSoapNote(id);
    return { success: true, message: "SOAP note deleted." };
  } catch (err) {
    console.error("[records-delete-soap-note]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-get-soap-tests-advised", async (_event, soapNoteId) => {
  try {
    const result = await saasClient.getSoapTestsAdvised(soapNoteId);
    return { success: true, data: result.data };
  } catch (err) {
    console.error("[records-get-soap-tests-advised]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-set-soap-tests-advised", async (_event, { soap_note_id, test_names }) => {
  try {
    await saasClient.setSoapTestsAdvised(soap_note_id, Array.isArray(test_names) ? test_names : []);
    return { success: true, message: "Tests advised updated." };
  } catch (err) {
    console.error("[records-set-soap-tests-advised]", err);
    return { success: false, message: err.message };
  }
});

// patients-get-soap-notes (formerly handlers/patientHandlers.js) — used for
// the PDF summary flow. Same data as records-get-soap-notes.
ipcMain.handle("patients-get-soap-notes", async (_event, petId) => {
  try {
    const result = await saasClient.listSoapNotesByPet(petId);
    return { success: true, data: result.data.map(toLocalSoapNote) };
  } catch (err) {
    console.error("[patients-get-soap-notes]", err);
    return { success: false, message: err.message, data: [] };
  }
});

// ─── Vaccinations ───────────────────────────────────────────────────────
function toLocalVaccination(v) {
  return {
    id: v.id,
    pet_id: v.petId,
    soap_note_id: v.soapNoteId,
    vaccine_name: v.vaccineName,
    administered_on: toDateOnlyStr(v.administeredOn),
    next_due_date: toDateOnlyStr(v.nextDueDate),
    batch_number: v.batchNumber,
    notes: v.notes,
    administered_by: v.administeredBy,
    created_at: v.createdAt,
  };
}

ipcMain.handle("records-get-vaccinations", async (_event, petId) => {
  try {
    const result = await saasClient.listVaccinationsByPet(petId);
    return { success: true, data: result.data.map(toLocalVaccination) };
  } catch (err) {
    console.error("[records-get-vaccinations]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-add-vaccination", async (_event, p) => {
  try {
    const result = await saasClient.createVaccination(p.pet_id, {
      soapNoteId: p.soap_note_id ?? undefined,
      vaccineName: p.vaccine_name,
      administeredOn: p.administered_on,
      nextDueDate: p.next_due_date ?? undefined,
      batchNumber: p.batch_number || undefined,
      notes: p.notes || undefined,
      administeredBy: p.administered_by || undefined,
    });
    return { success: true, id: result.data.id, message: "Vaccination added." };
  } catch (err) {
    console.error("[records-add-vaccination]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-update-vaccination", async (_event, p) => {
  try {
    await saasClient.updateVaccination(p.id, {
      vaccineName: p.vaccine_name,
      administeredOn: p.administered_on,
      nextDueDate: p.next_due_date ?? null,
      batchNumber: p.batch_number || undefined,
      notes: p.notes || undefined,
      administeredBy: p.administered_by || undefined,
    });
    return { success: true, message: "Vaccination updated." };
  } catch (err) {
    console.error("[records-update-vaccination]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-delete-vaccination", async (_event, id) => {
  try {
    await saasClient.deleteVaccination(id);
    return { success: true };
  } catch (err) {
    console.error("[records-delete-vaccination]", err);
    return { success: false, message: err.message };
  }
});

// ─── Dewormings ─────────────────────────────────────────────────────────
function toLocalDeworming(d) {
  return {
    id: d.id,
    pet_id: d.petId,
    soap_note_id: d.soapNoteId,
    product_name: d.productName,
    administered_on: toDateOnlyStr(d.administeredOn),
    next_due_date: toDateOnlyStr(d.nextDueDate),
    batch_number: d.batchNumber,
    notes: d.notes,
    administered_by: d.administeredBy,
    created_at: d.createdAt,
  };
}

ipcMain.handle("records-get-dewormings", async (_event, petId) => {
  try {
    const result = await saasClient.listDewormingsByPet(petId);
    return { success: true, data: result.data.map(toLocalDeworming) };
  } catch (err) {
    console.error("[records-get-dewormings]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-add-deworming", async (_event, p) => {
  try {
    const result = await saasClient.createDeworming(p.pet_id, {
      soapNoteId: p.soap_note_id ?? undefined,
      productName: p.product_name,
      administeredOn: p.administered_on,
      nextDueDate: p.next_due_date ?? undefined,
      batchNumber: p.batch_number || undefined,
      notes: p.notes || undefined,
      administeredBy: p.administered_by || undefined,
    });
    return { success: true, id: result.data.id, message: "Deworming added." };
  } catch (err) {
    console.error("[records-add-deworming]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-update-deworming", async (_event, p) => {
  try {
    await saasClient.updateDeworming(p.id, {
      productName: p.product_name,
      administeredOn: p.administered_on,
      nextDueDate: p.next_due_date ?? null,
      batchNumber: p.batch_number || undefined,
      notes: p.notes || undefined,
      administeredBy: p.administered_by || undefined,
    });
    return { success: true, message: "Deworming updated." };
  } catch (err) {
    console.error("[records-update-deworming]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-delete-deworming", async (_event, id) => {
  try {
    await saasClient.deleteDeworming(id);
    return { success: true };
  } catch (err) {
    console.error("[records-delete-deworming]", err);
    return { success: false, message: err.message };
  }
});

// ─── Prescriptions with Junction Table ─────────────────────────────────
// Medication items already match field-for-field ({name, dosage, frequency,
// duration}) on both the renderer's payload shape and the API's — no
// per-item translation needed, unlike every other entity here.
function toLocalPrescription(pr) {
  return {
    id: pr.id,
    pet_id: pr.petId,
    soap_note_id: pr.soapNoteId,
    prescribed_by: pr.prescribedBy,
    prescribed_on: toDateOnlyStr(pr.prescribedOn),
    notes: pr.notes,
    created_at: pr.createdAt,
    medications: pr.medications,
  };
}

ipcMain.handle("records-get-prescriptions", async (_event, petId) => {
  try {
    const result = await saasClient.listPrescriptionsByPet(petId);
    return { success: true, data: result.data.map(toLocalPrescription) };
  } catch (err) {
    console.error("[records-get-prescriptions]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-add-prescription", async (_event, p) => {
  try {
    const meds = Array.isArray(p.medications) ? p.medications : JSON.parse(p.medications);
    const result = await saasClient.createPrescription(p.pet_id, {
      soapNoteId: p.soap_note_id ?? undefined,
      prescribedBy: p.prescribed_by || undefined,
      prescribedOn: p.prescribed_on,
      notes: p.notes || undefined,
      medications: meds,
    });
    return { success: true, id: result.data.id, message: "Prescription added." };
  } catch (err) {
    console.error("[records-add-prescription]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-update-prescription", async (_event, p) => {
  try {
    const meds = Array.isArray(p.medications) ? p.medications : JSON.parse(p.medications);
    await saasClient.updatePrescription(p.id, {
      prescribedBy: p.prescribed_by || undefined,
      prescribedOn: p.prescribed_on,
      notes: p.notes || undefined,
      medications: meds,
    });
    return { success: true, message: "Prescription updated." };
  } catch (err) {
    console.error("[records-update-prescription]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-delete-prescription", async (_event, id) => {
  try {
    await saasClient.deletePrescription(id);
    return { success: true, message: "Prescription deleted." };
  } catch (err) {
    console.error("[records-delete-prescription]", err);
    return { success: false, message: err.message };
  }
});

// ─── Lab Results ────────────────────────────────────────────────────────
function toLocalLabResult(l) {
  return {
    id: l.id,
    pet_id: l.petId,
    soap_note_id: l.soapNoteId,
    test_name: l.testName,
    test_date: toDateOnlyStr(l.testDate),
    result_summary: l.resultSummary,
    result_value: l.resultValue,
    reference_range: l.referenceRange,
    status: l.status,
    lab_name: l.labName,
    notes: l.notes,
    created_at: l.createdAt,
  };
}

ipcMain.handle("records-get-lab-results", async (_event, petId) => {
  try {
    const result = await saasClient.listLabResultsByPet(petId);
    return { success: true, data: result.data.map(toLocalLabResult) };
  } catch (err) {
    console.error("[records-get-lab-results]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-add-lab-result", async (_event, p) => {
  try {
    const result = await saasClient.createLabResult(p.pet_id, {
      soapNoteId: p.soap_note_id ?? undefined,
      testName: p.test_name,
      testDate: p.test_date,
      resultSummary: p.result_summary || undefined,
      resultValue: p.result_value || undefined,
      referenceRange: p.reference_range || undefined,
      status: p.status || undefined,
      labName: p.lab_name || undefined,
      notes: p.notes || undefined,
    });
    return { success: true, id: result.data.id, message: "Lab result added." };
  } catch (err) {
    console.error("[records-add-lab-result]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-update-lab-result", async (_event, p) => {
  try {
    await saasClient.updateLabResult(p.id, {
      testName: p.test_name,
      testDate: p.test_date,
      resultSummary: p.result_summary || undefined,
      resultValue: p.result_value || undefined,
      referenceRange: p.reference_range || undefined,
      status: p.status || undefined,
      labName: p.lab_name || undefined,
      notes: p.notes || undefined,
    });
    return { success: true, message: "Lab result updated." };
  } catch (err) {
    console.error("[records-update-lab-result]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-delete-lab-result", async (_event, id) => {
  try {
    await saasClient.deleteLabResult(id);
    return { success: true };
  } catch (err) {
    console.error("[records-delete-lab-result]", err);
    return { success: false, message: err.message };
  }
});

// ─── Procedures ────────────────────────────────────────────────────────
// Materials used (injections, bandages, any supply) are logged inline as
// part of a procedure rather than as their own tab — each procedure can
// carry zero or more material line items, optionally linked to a real
// Product for stock tracking (see the materials handling in
// procedure.service.ts on the backend).
function toLocalMaterial(m) {
  return {
    id: m.id,
    product_id: m.productId,
    material_name: m.materialName,
    quantity: m.quantity,
    dose: m.dose,
    route: m.route,
    batch_number: m.batchNumber,
    notes: m.notes,
  };
}

function toMaterialPayload(m) {
  return {
    productId: m.product_id ?? undefined,
    materialName: m.material_name,
    quantity: m.quantity ?? undefined,
    dose: m.dose || undefined,
    route: m.route || undefined,
    batchNumber: m.batch_number || undefined,
    notes: m.notes || undefined,
  };
}

function toLocalProcedure(pc) {
  return {
    id: pc.id,
    pet_id: pc.petId,
    soap_note_id: pc.soapNoteId,
    procedure_name: pc.procedureName,
    performed_on: toDateOnlyStr(pc.performedOn),
    performed_by: pc.performedBy,
    notes: pc.notes,
    outcome: pc.outcome,
    created_at: pc.createdAt,
    materials: (pc.materials || []).map(toLocalMaterial),
  };
}

ipcMain.handle("records-get-procedures", async (_event, petId) => {
  try {
    const result = await saasClient.listProceduresByPet(petId);
    return { success: true, data: result.data.map(toLocalProcedure) };
  } catch (err) {
    console.error("[records-get-procedures]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-add-procedure", async (_event, p) => {
  try {
    const result = await saasClient.createProcedure(p.pet_id, {
      soapNoteId: p.soap_note_id ?? undefined,
      procedureName: p.procedure_name,
      performedOn: p.performed_on,
      performedBy: p.performed_by || undefined,
      notes: p.notes || undefined,
      outcome: p.outcome || undefined,
      materials: (p.materials || []).map(toMaterialPayload),
    });
    return { success: true, id: result.data.id, message: "Procedure added." };
  } catch (err) {
    console.error("[records-add-procedure]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-update-procedure", async (_event, p) => {
  try {
    await saasClient.updateProcedure(p.id, {
      procedureName: p.procedure_name,
      performedOn: p.performed_on,
      performedBy: p.performed_by || undefined,
      outcome: p.outcome || undefined,
      notes: p.notes || undefined,
      materials: (p.materials || []).map(toMaterialPayload),
    });
    return { success: true, message: "Procedure updated." };
  } catch (err) {
    console.error("[records-update-procedure]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-delete-procedure", async (_event, id) => {
  try {
    await saasClient.deleteProcedure(id);
    return { success: true };
  } catch (err) {
    console.error("[records-delete-procedure]", err);
    return { success: false, message: err.message };
  }
});

// ─── Body Weight Records ────────────────────────────────────────────────
function toLocalBodyWeightRecord(w) {
  return {
    id: w.id,
    pet_id: w.petId,
    soap_note_id: w.soapNoteId,
    weight: w.weight,
    weight_unit: w.weightUnit,
    recorded_on: toDateOnlyStr(w.recordedOn),
    notes: w.notes,
    recorded_by: w.recordedBy,
    created_at: w.createdAt,
  };
}

ipcMain.handle("records-get-body-weight-records", async (_event, petId) => {
  try {
    const result = await saasClient.listBodyWeightRecordsByPet(petId);
    return { success: true, data: result.data.map(toLocalBodyWeightRecord) };
  } catch (err) {
    console.error("[records-get-body-weight-records]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-add-body-weight-record", async (_event, p) => {
  try {
    const result = await saasClient.createBodyWeightRecord(p.pet_id, {
      soapNoteId: p.soap_note_id ?? undefined,
      weight: p.weight,
      weightUnit: p.weight_unit || undefined,
      recordedOn: p.recorded_on,
      notes: p.notes || undefined,
      recordedBy: p.recorded_by || undefined,
    });
    return { success: true, id: result.data.id, message: "Body weight record added." };
  } catch (err) {
    console.error("[records-add-body-weight-record]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-update-body-weight-record", async (_event, p) => {
  try {
    await saasClient.updateBodyWeightRecord(p.id, {
      weight: p.weight,
      weightUnit: p.weight_unit || undefined,
      recordedOn: p.recorded_on,
      notes: p.notes || undefined,
      recordedBy: p.recorded_by || undefined,
    });
    return { success: true, message: "Body weight record updated." };
  } catch (err) {
    console.error("[records-update-body-weight-record]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("records-delete-body-weight-record", async (_event, id) => {
  try {
    await saasClient.deleteBodyWeightRecord(id);
    return { success: true };
  } catch (err) {
    console.error("[records-delete-body-weight-record]", err);
    return { success: false, message: err.message };
  }
});

// ─── Reports (Cloudinary-backed medical file uploads) ──────────────────
// The backend never touches the file itself — same pattern already
// established for payment-submission proofs: this main-process handler
// uploads straight to Cloudinary using the clinic's own credentials, then
// hands the backend only the resulting URL/public ID to persist.
function toLocalReport(r) {
  return {
    id: r.id,
    pet_id: r.petId,
    test_type: r.testType,
    custom_test_type: r.customTestType,
    file_url: r.fileUrl,
    file_type: r.fileType,
    original_filename: r.originalFilename,
    notes: r.notes,
    created_at: r.createdAt,
  };
}

ipcMain.handle("records-get-reports", async (_event, petId) => {
  try {
    const result = await saasClient.listReportsByPet(petId);
    return { success: true, data: result.data.map(toLocalReport) };
  } catch (err) {
    console.error("[records-get-reports]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle(
  "records-add-report",
  async (_event, { pet_id, test_type, custom_test_type, notes, file_data, file_name, mime_type }) => {
    try {
      if (!file_data) {
        return { success: false, message: "No file was provided." };
      }
      if (!test_type) {
        return { success: false, message: "Test type is required." };
      }

      const base64Payload = file_data.split(",")[1] || "";
      const approxBytes = Math.ceil((base64Payload.length * 3) / 4);
      if (approxBytes > MAX_FILE_BYTES) {
        return { success: false, message: "File exceeds the 10 MB limit." };
      }

      const isPdf = mime_type === "application/pdf";

      const fileUrl = await saveLocalImage(file_data, `report_pet${pet_id}_`);

      const result = await saasClient.createReport(pet_id, {
        testType: test_type,
        customTestType: test_type === "Other" ? custom_test_type || undefined : undefined,
        fileUrl,
        fileType: isPdf ? "pdf" : "image",
        originalFilename: file_name || undefined,
        notes: notes || undefined,
      });

      return { success: true, id: result.data.id, message: "Report uploaded." };
    } catch (err) {
      console.error("[records-add-report]", err);
      return { success: false, message: err.message || "Failed to upload report." };
    }
  },
);

ipcMain.handle("records-update-report", async (_event, { id, notes }) => {
  try {
    await saasClient.updateReport(id, { notes: notes || undefined });
    return { success: true, message: "Report updated." };
  } catch (err) {
    console.error("[records-update-report]", err);
    return { success: false, message: err.message || "Failed to update report." };
  }
});

ipcMain.handle("records-delete-report", async (_event, id) => {
  try {
    const result = await saasClient.deleteReport(id);
    const report = result?.data;

    if (report?.cloudinaryPublicId) {
      try {
        ensureCloudinaryConfigured();
        await cloudinary.uploader.destroy(report.cloudinaryPublicId, {
          resource_type: report.fileType === "pdf" ? "raw" : "image",
        });
      } catch (cloudErr) {
        // Don't block the delete if Cloudinary cleanup fails — log and continue.
        console.error("[records-delete-report] Cloudinary cleanup failed:", cloudErr);
      }
    }

    return { success: true, message: "Report deleted." };
  } catch (err) {
    console.error("[records-delete-report]", err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle("open-external-link", async (_event, url) => {
  const win = new BrowserWindow({
    width: 900,
    height: 1000,
    webPreferences: {
      plugins: true,
    },
  });
  win.loadURL(url);
});

// ─── Cross-cutting: veterinarians, search, recent activity ──────────────
ipcMain.handle("get-veterinarians", async () => {
  try {
    const result = await saasClient.listVeterinarians();
    return { success: true, data: result.data };
  } catch (err) {
    console.error("[get-veterinarians]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-search-pets", async (_event, query) => {
  try {
    if (!query || !query.trim()) return { success: true, data: [] };
    const result = await saasClient.listPets({ search: query.trim(), pageSize: 20 });
    const data = result.data.map((pet) => ({
      pet_id: pet.id,
      pet_name: pet.petName,
      species: pet.species,
      breed: pet.breed,
      sex: pet.sex,
      age: pet.age,
      date_of_birth: pet.dateOfBirth ? pet.dateOfBirth.slice(0, 10) : null,
      color: pet.color,
      client_id: pet.clientId,
      client_name: pet.clientName,
      contact_number: pet.contactNumber,
    }));
    return { success: true, data };
  } catch (err) {
    console.error("[records-search-pets]", err);
    return { success: false, message: err.message, data: [] };
  }
});

ipcMain.handle("records-get-recent", async (_event, { limit = 50 } = {}) => {
  try {
    const result = await saasClient.listRecentRecords(limit);
    const data = result.data.map((r) => ({
      id: r.id,
      pet_id: r.petId,
      pet_name: r.petName,
      record_type: r.recordType,
      created_at: r.createdAt,
    }));
    return { success: true, data };
  } catch (err) {
    console.error("[records-get-recent]", err);
    return { success: false, message: err.message, data: [] };
  }
});

// Clinic-wide counts for the Records landing view's stats row (Total
// Records / This Month / Active Patients). Unlike getReportsData this isn't
// OWNER-restricted, so every role that can see the Records screen gets it.
ipcMain.handle("records-get-stats", async () => {
  try {
    const result = await saasClient.getRecordStats();
    const d = result.data;
    return {
      success: true,
      data: {
        total_records: d.totalRecords,
        records_this_month: d.recordsThisMonth,
        active_patients: d.activePatients,
      },
    };
  } catch (err) {
    console.error("[records-get-stats]", err);
    return {
      success: false,
      message: err.message,
      data: { total_records: 0, records_this_month: 0, active_patients: 0 },
    };
  }
});

// ─── Recent visit summary (most-recent-date + short proximity window) ──
// Powers the Records/Patients "Download Recent Record" button. Mirrors EMR's
// records-get-recent-visit-summary — same "the pet's latest calendar date
// with ANY medical record on file, plus everything on that date, plus a
// short window immediately after it" idea (e.g. a 1 Aug follow-up to a
// 31 Jul visit is the same episode of care) — but reimplemented in JS over
// the already-mapped per-entity API responses instead of a single SQL
// date-window query, since there's no direct DB access from this process.
function toDateOnlyStrLocal(v) {
  if (!v) return null;
  return String(v).slice(0, 10);
}

ipcMain.handle("records-get-recent-visit-summary", async (_event, petId) => {
  try {
    const [soapNotesAll, vaccinationsAll, dewormingsAll, reportsAll, proceduresAll, bodyWeightAll, labResultsAll] = await Promise.all([
      saasClient.listSoapNotesByPet(petId).then((r) => r.data.map(toLocalSoapNote)).catch(() => []),
      saasClient.listVaccinationsByPet(petId).then((r) => r.data.map(toLocalVaccination)).catch(() => []),
      saasClient.listDewormingsByPet(petId).then((r) => r.data.map(toLocalDeworming)).catch(() => []),
      saasClient.listReportsByPet(petId).then((r) => r.data.map(toLocalReport)).catch(() => []),
      saasClient.listProceduresByPet(petId).then((r) => r.data.map(toLocalProcedure)).catch(() => []),
      saasClient.listBodyWeightRecordsByPet(petId).then((r) => r.data.map(toLocalBodyWeightRecord)).catch(() => []),
      saasClient.listLabResultsByPet(petId).then((r) => r.data.map(toLocalLabResult)).catch(() => []),
    ]);

    // Latest calendar date across every record type — vaccinations/dewormings
    // are their own systems of record, not visit-scoped, so a same-day
    // vaccination with no SOAP note still counts, same rule as EMR.
    const allDates = [
      ...soapNotesAll.map((n) => toDateOnlyStrLocal(n.created_at)),
      ...vaccinationsAll.map((v) => v.administered_on),
      ...dewormingsAll.map((d) => d.administered_on),
      ...reportsAll.map((r) => toDateOnlyStrLocal(r.created_at)),
      ...proceduresAll.map((p) => p.performed_on),
      ...bodyWeightAll.map((w) => w.recorded_on),
      ...labResultsAll.map((l) => l.test_date),
    ].filter(Boolean);

    if (allDates.length === 0) {
      // No medical record of any kind on file for this pet yet.
      return {
        success: true,
        latestDate: null,
        data: { soapNotes: [], vaccinations: [], dewormings: [], reports: [], procedures: [], bodyWeightRecords: [], labResults: [] },
      };
    }

    const startDate = allDates.reduce((max, d) => (d > max ? d : max));

    // Short proximity window AFTER the latest date — a couple of calendar
    // days, not an arbitrary large range, since the goal is "everything
    // relevant to the last visit," not the pet's whole recent history.
    const windowEndObj = new Date(`${startDate}T00:00:00`);
    windowEndObj.setDate(windowEndObj.getDate() + 2);
    const windowEnd = toDateOnlyStrLocal(windowEndObj);

    const inWindow = (d) => !!d && d >= startDate && d <= windowEnd;

    return {
      success: true,
      latestDate: startDate,
      data: {
        soapNotes: soapNotesAll.filter((n) => inWindow(toDateOnlyStrLocal(n.created_at))),
        vaccinations: vaccinationsAll.filter((v) => inWindow(v.administered_on)),
        dewormings: dewormingsAll.filter((d) => inWindow(d.administered_on)),
        reports: reportsAll.filter((r) => inWindow(toDateOnlyStrLocal(r.created_at))),
        procedures: proceduresAll.filter((p) => inWindow(p.performed_on)),
        bodyWeightRecords: bodyWeightAll.filter((w) => inWindow(w.recorded_on)),
        labResults: labResultsAll.filter((l) => inWindow(l.test_date)),
      },
    };
  } catch (err) {
    console.error("[records-get-recent-visit-summary]", err);
    return { success: false, message: err.message };
  }
});
};
