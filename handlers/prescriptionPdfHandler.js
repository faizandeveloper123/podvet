const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { imageSize } = require('image-size');

// ── Branding colour (mirrors generate_invoice.js's parseColor()/makeTints()
// exactly — same fallback default — so every document type renders the same
// brand colour the same way) ────────────────────────────────────────────────
const DEFAULT_BRAND_COLOR = [139, 0, 0]; // #8B0000 deep red — same fallback as the invoice

const parseColor = (value) => {
  if (!value) return DEFAULT_BRAND_COLOR;
  if (Array.isArray(value) && value.length === 3) return value;
  if (typeof value === 'string') {
    const hex = value.replace('#', '');
    if (hex.length === 6) {
      return [
        parseInt(hex.substring(0, 2), 16),
        parseInt(hex.substring(2, 4), 16),
        parseInt(hex.substring(4, 6), 16),
      ];
    }
  }
  return DEFAULT_BRAND_COLOR;
};

const makeTints = ([r, g, b]) => ({
  lightBg: [
    Math.round(255 * 0.95 + r * 0.05),
    Math.round(255 * 0.95 + g * 0.05),
    Math.round(255 * 0.95 + b * 0.05),
  ],
  pinkHint: [
    Math.round(255 * 0.80 + r * 0.20),
    Math.round(255 * 0.80 + g * 0.20),
    Math.round(255 * 0.80 + b * 0.20),
  ],
});

// Same fit-within-box-and-center, aspect-ratio-preserving math as
// generate_invoice.js's addLogo() — ported to pdfkit's doc.image() API
// (jsPDF's addImage()/getImageProperties() aren't available here). No
// bundled-logo fallback on purpose: if the clinic hasn't set one in Settings,
// callers just skip this and the header shows the clinic name only.
const addLogo = (doc, logoFile, x, y, maxW, maxH) => {
  if (!logoFile) return;
  try {
    const buffer = fs.readFileSync(logoFile);
    const dimensions = imageSize(buffer);
    const aspectRatio = dimensions.width / dimensions.height;

    let drawW = maxW;
    let drawH = maxW / aspectRatio;
    if (drawH > maxH) {
      drawH = maxH;
      drawW = maxH * aspectRatio;
    }

    const centeredX = x + (maxW - drawW) / 2;
    const centeredY = y + (maxH - drawH) / 2;

    doc.image(buffer, centeredX, centeredY, { width: drawW, height: drawH });
  } catch (err) {
    console.warn('[prescriptionPdfHandler] Could not add logo:', err.message);
  }
};

const STETHOSCOPE_ICON = (() => {
  const candidates = app.isPackaged
    ? [
        path.join(app.getAppPath(), 'assets', 'stethoscope-solid.png'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'stethoscope-solid.png'),
        path.join(process.resourcesPath, 'assets', 'stethoscope-solid.png'),
      ]
    : [path.join(__dirname, '..', 'assets', 'stethoscope-solid.png')];
  return candidates.find((c) => fs.existsSync(c)) || null;
})();

function formatDate(val) {
  if (!val) return "\u2014";
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${d}-${m}-${y}`;
  }
  const s = String(val);
  const parts = s.slice(0, 10).split("-");
  if (!parts || parts.length < 3) return s;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

function formatDoctorName(name) {
  if (!name) return "";
  if (name.trim().toLowerCase().startsWith("dr")) return name.trim();
  return `Dr. ${name.trim()}`;
}

const TEAL_DARK   = '#0d7377';
const TEAL_MID    = '#14a085';
const TEAL_LIGHT  = '#32c8ae';
const TEAL_PALE   = '#e6f7f5';
const WHITE       = '#ffffff';
const GRAY_DARK   = '#2d3748';
const GRAY_MID    = '#4a5568';
const GRAY_LIGHT  = '#718096';
const GRAY_BORDER = '#e2e8f0';
const FOOTER_BG   = '#f0faf8';

const PAGE_W    = 595.28;
const PAGE_H    = 841.89;
const ML        = 45;
const MR        = PAGE_W - 45;
const CONTENT_W = MR - ML;

function filledRect(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color).restore();
}

function hLine(doc, x1, x2, y, color, lw) {
  doc.save().strokeColor(color || GRAY_BORDER).lineWidth(lw || 0.5)
     .moveTo(x1, y).lineTo(x2, y).stroke().restore();
}


// ── Measure wrapped text height ──────────────────────────────────────────────
function textHeight(doc, text, width, fontSize) {
  // PDFKit's heightOfString is reliable for wrapped text
  return doc.fontSize(fontSize).heightOfString(String(text || ''), { width });
}

// ── Main generator ─────────────────────────────────────────────────────────────
async function generatePrescriptionPdf(prescription, pet, orgName, address, phone, vets, branding = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const BRAND = parseColor(branding.color);
    const { lightBg, pinkHint } = makeTints(BRAND);
    const logoFile = branding.logoPath && fs.existsSync(branding.logoPath) ? branding.logoPath : null;

    // ── HEADER ───────────────────────────────────────────────────────────────
    const HEADER_H = 110;

    filledRect(doc, 0, 0, PAGE_W, HEADER_H, WHITE);


    // Logo — left of the clinic name, fit-and-centered within its box,
    // never stretched. No box/placeholder at all when no logo is set.
    const LOGO_SIZE = 64;
    const LOGO_X = ML;
    const LOGO_Y = (HEADER_H - LOGO_SIZE) / 2;
    if (logoFile) {
      addLogo(doc, logoFile, LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE);
    }
    const nameX = logoFile ? LOGO_X + LOGO_SIZE + 14 : ML;

    // Clinic name (primary, large treatment)
    doc.save().fillColor(BRAND).fontSize(26).font('Helvetica-Bold')
      .text(orgName || 'Clinic Name', nameX, 40)
      .restore();

    // Doctor name + designation (drawn in the footer, computed here for reuse)
    const fullName = formatDoctorName(prescription.prescribed_by) || 'Not specified';

    // Match prescribed_by (name) against the vets list to find their designation.
    const matchedVet = (vets || []).find(
      (v) => (v.name || '').trim().toLowerCase() === (prescription.prescribed_by || '').trim().toLowerCase()
    );
    const designation = matchedVet?.designation || 'Veterinarian';
    const doctorLine   = `${fullName} — ${designation}`;

   // Stethoscope icon
   const cx = PAGE_W - 68;
   const cy = HEADER_H / 2 + 4;
   const r  = 31;
   doc.save().circle(cx, cy, r).fill(BRAND).restore();
   if (STETHOSCOPE_ICON) {
     doc.image(STETHOSCOPE_ICON, cx - 22, cy - 22, { width: 44, height: 44 });
   }

    // Accent bar
    filledRect(doc, 0, HEADER_H, PAGE_W, 4, BRAND);

    // ── PATIENT INFO ─────────────────────────────────────────────────────────
    let y = HEADER_H + 20;

    const col1X = ML;
    const col2X = ML + CONTENT_W / 2 + 8;
    const colW  = CONTENT_W / 2 - 16;

    function infoCell(label, value, x, yPos, fullWidth) {
      const cellW    = fullWidth ? CONTENT_W : colW;
      const dispVal  = (value && String(value).trim()) ? String(value) : '\u2014';

      doc.save().fillColor(GRAY_LIGHT).fontSize(7.5).font('Helvetica')
         .text(label + ':', x, yPos).restore();

      doc.save().fillColor(GRAY_DARK).fontSize(10).font('Helvetica-Bold')
         .text(dispVal, x, yPos + 11, { width: cellW, ellipsis: true }).restore();

      hLine(doc, x, x + cellW, yPos + 24, GRAY_BORDER, 0.5);
    }

    infoCell('Patient Name', pet.pet_name,                           col1X, y, false);
    infoCell('Date',         formatDate(prescription.prescribed_on),  col2X, y, false);
    y += 36;

    infoCell('Species', `${pet.species}${pet.breed ? ` (${pet.breed})` : ''}`, col1X, y, false);
    infoCell('Owner',   pet.client_name,                                          col2X, y, false);
    y += 36;

    infoCell('Notes', prescription.notes || '', col1X, y, true);
    y += 36;

    // ── Rx MARK ───────────────────────────────────────────────────────────────
    doc.save().fillColor(BRAND).fontSize(26).font('Helvetica-Bold')
       .text('Rx', ML, y).restore();
    y += 34;

    // ── MEDICATIONS TABLE ─────────────────────────────────────────────────────
    const medications = prescription.medications || [];

    if (medications.length > 0) {
      // Column definitions
      const cols = [
        { label: 'MEDICATION', x: ML,            w: 148 },
        { label: 'DOSAGE',     x: ML + 148,      w: 100 },
        { label: 'FREQUENCY',  x: ML + 248,      w: 112 },
        { label: 'DURATION',   x: ML + 360,      w: CONTENT_W - 360 },
      ];
      const THEAD_H     = 26;
      const ROW_PAD_V   = 7;   // vertical padding inside each data cell
      const FONT_SIZE   = 9;

      // ── Pre-calculate each row's height based on its tallest cell ──────────
      const rowHeights = medications.map((med) => {
        const vals = [
          med.name      || '\u2014',
          med.dosage    || '\u2014',
          med.frequency || '\u2014',
          med.duration  || '\u2014',
        ];
        const maxH = Math.max(...vals.map((v, ci) =>
          textHeight(doc, v, cols[ci].w - 12, FONT_SIZE)
        ));
        return Math.max(22, maxH + ROW_PAD_V * 2);  // minimum 22pt row
      });

      const totalTableH = THEAD_H + rowHeights.reduce((a, b) => a + b, 0);

      // Outer border
      doc.save().rect(ML, y, CONTENT_W, totalTableH)
         .lineWidth(1).stroke(pinkHint).restore();

      // Header
      filledRect(doc, ML, y, CONTENT_W, THEAD_H, BRAND);
      cols.forEach(col => {
        doc.save().fillColor(WHITE).fontSize(7.5).font('Helvetica-Bold')
           .text(col.label, col.x + 6, y + 9, { width: col.w - 10, characterSpacing: 0.4 })
           .restore();
      });
      y += THEAD_H;

      // Data rows
      medications.forEach((med, idx) => {
        const rowH = rowHeights[idx];
        const rowBg = idx % 2 === 0 ? WHITE : lightBg;

        filledRect(doc, ML, y, CONTENT_W, rowH, rowBg);

        const vals = [
          med.name      || '\u2014',
          med.dosage    || '\u2014',
          med.frequency || '\u2014',
          med.duration  || '\u2014',
        ];

        cols.forEach((col, ci) => {
          doc.save()
             .fillColor(ci === 0 ? GRAY_DARK : GRAY_MID)
             .fontSize(FONT_SIZE)
             .font(ci === 0 ? 'Helvetica-Bold' : 'Helvetica')
             .text(vals[ci], col.x + 6, y + ROW_PAD_V, {
               width: col.w - 12,
               lineBreak: true,         // allow wrapping
             })
             .restore();
        });

        hLine(doc, ML, MR, y + rowH, GRAY_BORDER, 0.3);
        y += rowH;
      });

      y += 20;
    }

    // ── FOOTER ────────────────────────────────────────────────────────────────
    // Order top to bottom: Doctor Name — Designation, Clinic Address,
    // Contact No: {phone}. No clinic name line. Lines with no data
    // (address/phone not set) are skipped rather than leaving a blank line.
    const FOOTER_H = 64;
    const footerY  = PAGE_H - FOOTER_H;

    filledRect(doc, 0, footerY, PAGE_W, FOOTER_H, FOOTER_BG);
    filledRect(doc, 0, footerY, PAGE_W, 1.5, GRAY_BORDER);

    let fy = footerY + 8;

    doc.save().fillColor(GRAY_DARK).fontSize(9.5).font('Helvetica-Bold')
       .text(doctorLine, ML, fy).restore();
    fy += 13;

    if (address) {
      doc.save().fillColor(GRAY_LIGHT).fontSize(7.5).font('Helvetica')
         .text(String(address), ML, fy).restore();
      fy += 13;
    }

    if (phone) {
      doc.save().fillColor(GRAY_LIGHT).fontSize(7.5).font('Helvetica')
         .text(`Contact No: ${phone}`, ML, fy).restore();
      fy += 13;
    }

    doc.save().fillColor(TEAL_LIGHT).fontSize(7.5).font('Helvetica')
       .text('Powered by Parkar Technologies LLC', ML, footerY + 16,
         { width: CONTENT_W, align: 'right' }).restore();

    doc.save().fillColor('#cbd5e0').fontSize(7).font('Helvetica')
       .text('Computer-generated document', ML, footerY + 31,
         { width: CONTENT_W, align: 'right' }).restore();

    doc.end();
  });
}

module.exports = { generatePrescriptionPdf };