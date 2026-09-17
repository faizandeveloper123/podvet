const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { saveLocalImage } = require('./utils');
const { printGeneratedPdf } = require('../generate_invoice');
const saasClient = require('./saasClient');

// Clinic-defined form templates — backed by the multi-tenant API's
// /api/forms. Checkpoint 1: created from an uploaded PDF only — the
// renderer does the actual PDF-to-images conversion (pdfjs-dist, needs a
// real <canvas>, so it can't happen in the main process) and calls
// upload-form-page-image once per page; the backend only ever stores the
// resulting image URLs + field placements, never PDF/image bytes itself.
//
// `pages`/`fields` are passed straight through camelCase end to end (API
// shape === renderer shape) — unlike every other list screen's top-level
// fields, this nested structure has no other convention to match and
// nothing else in the app touches it, so a snake_case round-trip would
// just be extra mapping for no benefit.

function toBranchId(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return Number(value);
}

function toLocalFormSummary(f) {
  return {
    id: f.id,
    name: f.name,
    branch_id: f.branchId,
    page_count: f.pageCount,
    thumbnail_url: f.thumbnailUrl,
    created_by_name: f.createdByName,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

function toLocalForm(f) {
  return {
    id: f.id,
    name: f.name,
    branch_id: f.branchId,
    pages: f.pages,
    created_by_name: f.createdByName,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

module.exports = function setupFormsHandlers() {
  ipcMain.handle('upload-form-page-image', async (_event, dataUrl) => {
    try {
      const url = await saveLocalImage(dataUrl, 'form_page_');
      return { success: true, url };
    } catch (err) {
      console.error('[upload-form-page-image]', err);
      return { success: false, message: err.message };
    }
  });

  // The filled-out PDF (background page images + typed-in values, already
  // merged) is built entirely in the renderer via jsPDF — that's where the
  // field values and Cloudinary image URLs already live, so there's nothing
  // for the main process to re-fetch or re-render. This just writes the
  // renderer's finished PDF to a temp file and reuses the same native
  // print pipeline every other generated PDF in this app already goes
  // through (printGeneratedPdf — opens a hidden BrowserWindow, waits for
  // the PDF viewer to fully settle, then calls the real OS print dialog).
  ipcMain.handle('print-filled-form', async (_event, { pdfDataUri } = {}) => {
    try {
      // jsPDF's datauristring output includes a filename= parameter before
      // the base64 marker (e.g. "data:application/pdf;filename=generated.pdf;base64,...") —
      // strip everything up to and including the last "base64," regardless
      // of exactly which parameters preceded it.
      const base64 = pdfDataUri.replace(/^data:.*?;base64,/, "");
      const filePath = path.join(app.getPath('temp'), `FilledForm_${Date.now()}.pdf`);
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      return await printGeneratedPdf(filePath);
    } catch (err) {
      console.error('[print-filled-form]', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('create-form', async (_event, form) => {
    try {
      const result = await saasClient.createForm({
        name: form.name,
        branchId: toBranchId(form.branch_id),
        pages: form.pages,
      });
      return { success: true, form: toLocalForm(result.data) };
    } catch (err) {
      // err.details carries the backend's field-by-field Zod validation
      // errors (validate.middleware.ts's AppError.badRequest details) —
      // logging it, not just err.message, is the difference between "which
      // field and why" and a bare "Validation failed" in the console.
      console.error('[create-form]', err.message, err.details ? JSON.stringify(err.details) : '');
      return { success: false, message: err.message || 'Could not create form' };
    }
  });

  ipcMain.handle('list-forms', async (_event, page = 1, query = '') => {
    try {
      const result = await saasClient.listForms({ page, pageSize: 12, search: query });
      return {
        success: true,
        data: result.data.map(toLocalFormSummary),
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      };
    } catch (err) {
      console.error('[list-forms]', err);
      return { success: false, message: err.message, data: [], total: 0, page: 1, totalPages: 1 };
    }
  });

  ipcMain.handle('get-form', async (_event, formId) => {
    try {
      const result = await saasClient.getForm(formId);
      return { success: true, form: toLocalForm(result.data) };
    } catch (err) {
      console.error('[get-form]', err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('update-form', async (_event, form) => {
    try {
      const result = await saasClient.updateForm(form.id, {
        ...(form.name !== undefined && { name: form.name }),
        ...(form.branch_id !== undefined && { branchId: toBranchId(form.branch_id) ?? null }),
        ...(form.pages !== undefined && { pages: form.pages }),
      });
      return { success: true, form: toLocalForm(result.data) };
    } catch (err) {
      console.error('[update-form]', err.message, err.details ? JSON.stringify(err.details) : '');
      return { success: false, message: err.message || 'Could not update form' };
    }
  });

  ipcMain.handle('delete-form', async (_event, formId) => {
    try {
      await saasClient.deleteForm(formId);
      return { success: true, message: 'Form deleted successfully' };
    } catch (err) {
      console.error('[delete-form]', err);
      return { success: false, message: err.message || 'Could not delete form' };
    }
  });
};
