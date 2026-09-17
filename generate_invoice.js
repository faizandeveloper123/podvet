const { jsPDF } = require("jspdf");
const fs        = require("fs");
const path      = require("path");
const { app }   = require("electron");
const { exec }  = require("child_process");
const os        = require("os");
const { imageSize } = require("image-size");

// ── Fallback brand defaults (used if no branding settings saved yet) ──────────
const DEFAULTS = {
  color:       [139, 0, 0],    // #8B0000 deep red
  clinicName:  "My Clinic",
  address:     "",
  phone:       "",
  bankName:    "",
  bankAccount: "",
  logoPath:    null,
};

// ── Fixed palette entries that are always derived from the brand colour ────────
const WHITE     = [255, 255, 255];
const DARK_GREY = [ 51,  51,  51];
const MID_GREY  = [102, 102, 102];
const RULE_GREY = [204, 204, 204];

// ── Colour helpers ─────────────────────────────────────────────────────────────
/**
 * Parse a stored colour value into an [r, g, b] triple.
 * Accepts "#RRGGBB" strings (from the settings UI) or [r,g,b] arrays.
 */
const parseColor = (value) => {
  if (!value) return DEFAULTS.color;
  if (Array.isArray(value) && value.length === 3) return value;
  if (typeof value === "string") {
    const hex = value.replace("#", "");
    if (hex.length === 6) {
      return [
        parseInt(hex.substring(0, 2), 16),
        parseInt(hex.substring(2, 4), 16),
        parseInt(hex.substring(4, 6), 16),
      ];
    }
  }
  return DEFAULTS.color;
};

/**
 * Blend brandColor 5 % into white → very light tinted row background.
 * 20 % blend → "pink hint" for label text on dark bars.
 */
const makeTints = ([r, g, b]) => ({
  lightBg:  [
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

const setRGB  = (doc, [r, g, b]) => doc.setTextColor(r, g, b);
const fillRGB = (doc, [r, g, b]) => doc.setFillColor(r, g, b);
const drawRGB = (doc, [r, g, b]) => doc.setDrawColor(r, g, b);

// ── PRINT-MODE (low-ink) shared primitives ──────────────────────────────────
// A branded document draws its color chrome — title bars, table header rows,
// a highlighted totals row — through these primitives instead of calling
// doc.rect()/doc.roundedRect() with a solid fill directly, so a single
// `data.printMode` flag can flip an element from "solid brand-colour fill"
// (the default) to "outline/border + text only" (physical low-ink printing)
// in one place, rather than every document type hand-rolling its own switch.

// A colored "bar": a title bar, a table header row, or a highlighted totals
// row. Full-color: solid brand-colour fill (callers draw WHITE text on top).
// Print mode: no fill at all — just a bold brand-colour bottom border — so
// callers must switch their text colour too (see barTextColor below), or it
// would render invisible (white-on-white).
const drawBar = (doc, x, y, w, h, color, printMode, radius = 0) => {
  if (printMode) {
    drawRGB(doc, color);
    doc.setLineWidth(0.6);
    doc.line(x, y + h, x + w, y + h);
  } else {
    fillRGB(doc, color);
    if (radius > 0) doc.roundedRect(x, y, w, h, radius, radius, "F");
    else doc.rect(x, y, w, h, "F");
  }
};
// Text drawn on a drawBar() — WHITE on the solid fill, or the brand colour
// itself once that fill is gone (print mode).
const barTextColor = (printMode, color) => (printMode ? color : WHITE);

// ── Misc helpers ───────────────────────────────────────────────────────────────
const fmtPKR = (v) => {
  const n = parseFloat(v) || 0;
  return `PKR ${n.toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
};

const fmtQty = (val) => {
  const n = parseFloat(val ?? 0);
  if (isNaN(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, "");
};

const ellipsis = (doc, text, maxWidth) => {
  let t = String(text);
  if (doc.getTextWidth(t) <= maxWidth) return t;
  while (t.length > 0 && doc.getTextWidth(t + "…") > maxWidth) t = t.slice(0, -1);
  return t + "…";
};

const isOddRow = (idx) => idx % 2 === 0;

// ── Logo resolution ────────────────────────────────────────────────────────────
/**
 * Resolve the logo file to use.
 *
 * Priority:
 *  1. branding.logoPath  — absolute path chosen by admin in Settings
 *  2. Fallback candidates alongside the app bundle (legacy behaviour)
 *
 * Returns null if no valid file is found, so callers can skip the addImage call
 * safely rather than crashing with a missing-file error.
 */
const resolveLogoPath = (brandingLogoPath) => {
  // 1. Admin-chosen logo
  if (brandingLogoPath && fs.existsSync(brandingLogoPath)) {
    return brandingLogoPath;
  }

  // 2. Legacy bundled fallback
  const candidates = app.isPackaged
    ? [
        path.join(app.getAppPath(), "clinic_logo.png"),
        path.join(process.resourcesPath, "app.asar.unpacked", "clinic_logo.png"),
        path.join(process.resourcesPath, "clinic_logo.png"),
      ]
    : [path.join(__dirname, "clinic_logo.png")];

  return candidates.find((p) => fs.existsSync(p)) ?? null;
};

/**
 * Add a logo image to `doc`, fit within the (maxW, maxH) bounding box at
 * (x, y) while preserving its real aspect ratio, and centered within that box.
 * Silently skips if the file cannot be found or read.
 */
const addLogo = (doc, logoFile, x, y, maxW, maxH) => {
  if (!logoFile) return;
  try {
    const ext = path.extname(logoFile).slice(1).toUpperCase() || "PNG";
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

    const b64 = buffer.toString("base64");
    doc.addImage(`data:image/${ext.toLowerCase()};base64,${b64}`, ext, centeredX, centeredY, drawW, drawH);
  } catch (err) {
    console.warn("[pdfGenerator] Could not load logo:", err.message);
  }
};

// ── Shared A4 clinic header (logo + name block + red rule) ─────────────────────
function drawClinicHeader(doc, yStart, branding, printMode = false) {
  const PW = 210;
  const M  = 18;
  const UW = PW - 2 * M;
  let y = yStart;

  const RED = parseColor(branding.color);

  const LOGO_W = 32, LOGO_H = 28;
  // The clinic's actual logo prints in both modes — embedding a small raster
  // image costs negligible ink next to the solid colour fills print mode is
  // actually about, so print mode never had a reason to swap it out for a
  // placeholder initials box.
  const logoFile = resolveLogoPath(branding.logoPath);
  if (logoFile) {
    addLogo(doc, logoFile, M, y, LOGO_W, LOGO_H);
  }

  // Clinic name — use organization_name from branding (which comes from the profile)
  const clinicName = String(branding.clinicName || DEFAULTS.clinicName).toUpperCase();
  doc.setFont("helvetica", "bold");

  // Auto-shrink to fit above the logo — this text is right-aligned and grows
  // leftward from the page's right margin with no width limit, so a longer
  // clinic/organization name (real names run well past "My Clinic") at a
  // fixed 16pt could run into the logo box (M to M+LOGO_W) or even past the
  // left margin. Steps down in 0.5pt increments to a 9pt floor before giving
  // up, rather than leaving every document's masthead sized for the
  // shortest possible name.
  const maxNameWidth = UW - LOGO_W - 4;
  let nameFontSize = 16;
  doc.setFontSize(nameFontSize);
  while (nameFontSize > 9 && doc.getTextWidth(clinicName) > maxNameWidth) {
    nameFontSize -= 0.5;
    doc.setFontSize(nameFontSize);
  }
  setRGB(doc, RED);
  doc.text(clinicName, M + UW, y + 5, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  setRGB(doc, MID_GREY);

  if (branding.address) {
    doc.text(String(branding.address), M + UW, y + 10, { align: "right" });
  }
  if (branding.phone) {
    doc.text(`Phone: ${branding.phone}`, M + UW, branding.address ? y + 15 : y + 10, { align: "right" });
  }

  y += LOGO_H + 2;

  fillRGB(doc, RED);
  drawRGB(doc, RED);
  doc.setLineWidth(0.8);
  doc.line(M, y, M + UW, y);

  return y + 5;
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 INVOICE
// ─────────────────────────────────────────────────────────────────────────────
function generateInvoiceJS(data, outputPath) {
  // branding object injected into data by the caller, or empty object as fallback
  const branding = data.branding || {};
  const RED      = parseColor(branding.color);
  const { lightBg, pinkHint } = makeTints(RED);

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const PW  = 210;
  const M   = 18;
  const UW  = PW - 2 * M;

  let y = M;

  // Header
  y = drawClinicHeader(doc, y, branding);

  // ── INVOICE title bar ──────────────────────────────────────────────────────
  const BAR_H = 14;
  fillRGB(doc, RED);
  doc.roundedRect(M, y, UW, BAR_H, 2, 2, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  setRGB(doc, WHITE);
  doc.text("INVOICE", M + 5, y + 9.5);

  const META_X    = M + UW - 58;
  const metaLabelX = META_X + 2;
  const metaValX   = M + UW - 3;

  const metaRows = [
    ["Invoice No.", String(data.invoice_no   ?? "N/A")],
    ["Date",        String(data.billing_date  ?? "")],
    ["Time",        String(data.billing_time  ?? "")],
  ];

  doc.setFontSize(7.5);
  metaRows.forEach(([label, val], i) => {
    const rowY = y + 3.5 + i * 3.8;
    setRGB(doc, pinkHint);
    doc.setFont("helvetica", "normal");
    doc.text(label, metaLabelX, rowY);
    setRGB(doc, WHITE);
    doc.setFont("helvetica", "bold");
    doc.text(val, metaValX, rowY, { align: "right" });
  });

  y += BAR_H + 5;

// ── Customer / appointment block ───────────────────────────────────────────
const customer = data.customer || null;
const appointmentNotes = String(customer?.notes ?? "").trim();

if (customer && Object.values(customer).some(Boolean)) {
  const blockStartY = y;

  // LEFT column — existing client/appointment lines
  const LEFT_W = UW * 0.6;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  setRGB(doc, RED);
  doc.text("Bill to / Visit", M, y);
  y += 4;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  setRGB(doc, DARK_GREY);

  const lines = [];
  if (customer.client_name)      lines.push(`Client: ${customer.client_name}`);
  if (customer.contact_number)   lines.push(`Contact: ${customer.contact_number}`);
  if (customer.pet_name)         lines.push(`Pet: ${customer.pet_name}`);
  if (customer.appointment_date) lines.push(`Appointment date: ${customer.appointment_date}`);
  if (customer.appointment_time) lines.push(`Time: ${customer.appointment_time}`);
  if (customer.doctor)           lines.push(`Veterinarian: ${customer.doctor}`);

  lines.forEach((ln) => { doc.text(ln, M, y); y += 4.5; });
  const leftBottomY = y;

  // RIGHT column — Notes, capped to roughly the same height as the left column
// RIGHT column — Notes, aligned with the Invoice No./Date/Time meta block above
if (appointmentNotes) {
  const RIGHT_X = META_X;
  const RIGHT_W = M + UW - RIGHT_X; // extends to the same right edge as the meta block
  let ny = blockStartY;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    setRGB(doc, RED);
    doc.text("Notes", RIGHT_X, ny);
    ny += 4;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    setRGB(doc, MID_GREY);

    const maxNoteLines = Math.max(1, Math.floor((leftBottomY - ny) / 3.6) || 6);
    let wrapped = doc.splitTextToSize(appointmentNotes, RIGHT_W);
    if (wrapped.length > maxNoteLines) {
      wrapped = wrapped.slice(0, maxNoteLines);
      const lastIdx = wrapped.length - 1;
      wrapped[lastIdx] = ellipsis(doc, wrapped[lastIdx] + "…", RIGHT_W);
    }
    doc.text(wrapped, RIGHT_X, ny);
  }

  y = Math.max(leftBottomY, y) + 3;
}

  // ── Items table ────────────────────────────────────────────────────────────
  const COL = {
    num:   UW * 0.05,
    name:  UW * 0.42,
    qty:   UW * 0.13,
    price: UW * 0.20,
    amt:   UW * 0.20,
  };
  const colX = {
    num:   M,
    name:  M + COL.num,
    qty:   M + COL.num + COL.name,
    price: M + COL.num + COL.name + COL.qty,
    amt:   M + COL.num + COL.name + COL.qty + COL.price,
  };

  const ROW_H = 7;
  const HDR_H = 7;
  const itemColLabel = String(data.item_column_label || "Product");

  fillRGB(doc, RED);
  doc.rect(M, y, UW, HDR_H, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  setRGB(doc, WHITE);
  doc.text("#",           colX.num   + COL.num   / 2,   y + 4.8, { align: "center" });
  doc.text(itemColLabel,  colX.name  + 1.5,              y + 4.8);
  doc.text("Qty",         colX.qty   + COL.qty   - 1.5, y + 4.8, { align: "right" });
  doc.text("Unit Price",  colX.price + COL.price - 1.5, y + 4.8, { align: "right" });
  doc.text("Amount",      colX.amt   + COL.amt   - 1.5, y + 4.8, { align: "right" });

  y += HDR_H;

  const lineItems = data.line_items ?? data.cart ?? [];
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);

  lineItems.forEach((item, idx) => {
    if (isOddRow(idx)) {
      fillRGB(doc, lightBg);
      doc.rect(M, y, UW, ROW_H, "F");
    }
    drawRGB(doc, [221, 221, 221]);
    doc.setLineWidth(0.1);
    doc.line(M, y + ROW_H, M + UW, y + ROW_H);

    setRGB(doc, DARK_GREY);
    const qtyDisplay = fmtQty(item.cartQty ?? item.quantity);
    // null price is a deliberate sentinel for grouped category rows with no
    // single real unit price (see buildAppointmentInvoicePayload) — shown as
    // "-" rather than fabricating an average.
    const price = item.price == null ? "-" : fmtPKR(item.price);
    const total = fmtPKR(item.total ?? 0);
    const name  = ellipsis(doc, item.name ?? "", COL.name - 3);

    doc.text(String(idx + 1), colX.num + COL.num / 2,       y + 4.8, { align: "center" });
    doc.text(name,            colX.name  + 1.5,              y + 4.8);
    doc.text(qtyDisplay,      colX.qty   + COL.qty   - 1.5, y + 4.8, { align: "right" });
    doc.text(price,           colX.price + COL.price - 1.5, y + 4.8, { align: "right" });
    doc.text(total,           colX.amt   + COL.amt   - 1.5, y + 4.8, { align: "right" });

    y += ROW_H;
  });

  // ── Totals box ─────────────────────────────────────────────────────────────
  const subtotal   = parseFloat(data.subtotal   ?? 0);
  const discount   = parseFloat(data.discount   ?? 0);
  const finalTotal = parseFloat(data.finalTotal ?? 0);
  const coupon     = data.coupon ?? "";

  y += discount > 0 ? 5 : 2;

  const TOT_W  = 75;
  const TOT_X  = M + UW - TOT_W;
  const CELL_H = 6.5;

  const totRows = [
    { label: "Subtotal", val: fmtPKR(subtotal), isTotal: false, isDisc: false },
    ...(discount > 0
      ? [{ label: coupon ? `Coupon (${coupon})` : "Discount", val: `- ${fmtPKR(discount)}`, isTotal: false, isDisc: true }]
      : []),
    { label: "TOTAL", val: fmtPKR(finalTotal), isTotal: true, isDisc: false },
  ];

  totRows.forEach((row, i) => {
    const rowY = y + i * CELL_H;
    if (row.isTotal) {
      fillRGB(doc, RED);
      doc.roundedRect(TOT_X, rowY, TOT_W, CELL_H, 0, 0, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      setRGB(doc, WHITE);
    } else {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      setRGB(doc, row.isDisc ? RED : DARK_GREY);
    }
    doc.text(row.label, TOT_X + 40 - 2, rowY + 4.3, { align: "right" });
    doc.text(row.val,   TOT_X + TOT_W - 2,  rowY + 4.3, { align: "right" });
  });

  const totalRowY = y + (totRows.length - 1) * CELL_H;
  drawRGB(doc, RED);
  doc.setLineWidth(0.5);
  doc.line(TOT_X, totalRowY, TOT_X + TOT_W, totalRowY);

  y += totRows.length * CELL_H + 8;

  // ── Partial payment block ──────────────────────────────────────────────────
  if (data.partialPayment) {
    const { totalPaid, remaining } = data.partialPayment;

    const PP_W = 75;
    const PP_X = M + UW - PP_W;

    // Paid so far row
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    setRGB(doc, [22, 101, 52]);
    doc.text("Paid so far", PP_X + 40 - 2, y + 4.3, { align: "right" });
    doc.text(`- ${fmtPKR(totalPaid)}`, PP_X + PP_W - 2, y + 4.3, { align: "right" });
    y += CELL_H;

    // Remaining balance row — highlighted
    fillRGB(doc, RED);
    doc.roundedRect(PP_X, y, PP_W, CELL_H, 0, 0, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    setRGB(doc, WHITE);
    doc.text("REMAINING", PP_X + 40 - 2, y + 4.3, { align: "right" });
    doc.text(fmtPKR(remaining), PP_X + PP_W - 2, y + 4.3, { align: "right" });

    drawRGB(doc, RED);
    doc.setLineWidth(0.5);
    doc.line(PP_X, y, PP_X + PP_W, y);

    y += CELL_H + 8;
  }

// ── Bank details ───────────────────────────────────────────────────────────
drawRGB(doc, RULE_GREY);
doc.setLineWidth(0.3);
doc.line(M, y, M + UW, y);
y += 4;

const bankName    = String(branding.bankName    || "");
const bankAccount = String(branding.bankAccount || "");

if (bankName || bankAccount) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  setRGB(doc, RED);
  doc.text("Bank Details", M, y);
  y += 4;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  setRGB(doc, MID_GREY);

  const bankLine = [bankName, bankAccount ? `Account: ${bankAccount}` : ""]
    .filter(Boolean)
    .join("   |   ");
  doc.text(bankLine, M, y);
  y += 8;
}

// ── Footer ─────────────────────────────────────────────────────────────────
drawRGB(doc, RULE_GREY);
doc.setLineWidth(0.3);
doc.line(M, y, M + UW, y);
y += 4;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  setRGB(doc, MID_GREY);
  doc.text("Thank you for trusting us with your pet's care!", M + UW / 2, y, { align: "center" });
  y += 4;

  doc.setFontSize(7);
  setRGB(doc, [170, 170, 170]);
  doc.text("Developed by hifi.", M + UW / 2, y, { align: "center" });

  const pdfBytes = doc.output("arraybuffer");
  fs.writeFileSync(outputPath, Buffer.from(pdfBytes));
  return outputPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 EXPENSE REPORT
// ─────────────────────────────────────────────────────────────────────────────
function generateExpenseReportPDF(data, outputPath) {
  const branding = data.branding || {};
  const RED      = parseColor(branding.color);
  const { lightBg, pinkHint } = makeTints(RED);

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const PW  = 210;
  const M   = 18;
  const UW  = PW - 2 * M;

  let y = drawClinicHeader(doc, M, branding);

  const BAR_H = 14;
  fillRGB(doc, RED);
  doc.roundedRect(M, y, UW, BAR_H, 2, 2, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  setRGB(doc, WHITE);
  doc.text("EXPENSE REPORT", M + 5, y + 9.5);

  const periodText  = data.date ? String(data.date) : `${data.startDate || ""} – ${data.endDate || ""}`;
  const generatedAt = new Date().toLocaleString("en-PK", { hour12: true });

  const META_X = M + UW - 62;
  const metaRows = [
    ["Period",    periodText],
    ["Generated", generatedAt],
  ];

  doc.setFontSize(7.5);
  metaRows.forEach(([label, val], i) => {
    const rowY = y + 3.5 + i * 3.8;
    setRGB(doc, pinkHint);
    doc.setFont("helvetica", "normal");
    doc.text(label, META_X + 2, rowY);
    setRGB(doc, WHITE);
    doc.setFont("helvetica", "bold");
    doc.text(ellipsis(doc, val, 55), M + UW - 3, rowY, { align: "right" });
  });

  y += BAR_H + 5;

  const COL = {
    num:   UW * 0.05,
    date:  UW * 0.13,
    name:  UW * 0.22,
    cat:   UW * 0.18,
    amt:   UW * 0.14,
    notes: UW * 0.28,
  };
  const colX = {
    num:   M,
    date:  M + COL.num,
    name:  M + COL.num + COL.date,
    cat:   M + COL.num + COL.date + COL.name,
    amt:   M + COL.num + COL.date + COL.name + COL.cat,
    notes: M + COL.num + COL.date + COL.name + COL.cat + COL.amt,
  };

  const ROW_H = 7;
  const HDR_H = 7;

  fillRGB(doc, RED);
  doc.rect(M, y, UW, HDR_H, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  setRGB(doc, WHITE);
  doc.text("#",        colX.num   + COL.num / 2,      y + 4.8, { align: "center" });
  doc.text("Date",     colX.date  + 1.5,               y + 4.8);
  doc.text("Name",     colX.name  + 1.5,               y + 4.8);
  doc.text("Category", colX.cat   + 1.5,               y + 4.8);
  doc.text("Amount",   colX.amt   + COL.amt   - 1.5,   y + 4.8, { align: "right" });
  doc.text("Notes",    colX.notes + 1.5,               y + 4.8);

  y += HDR_H;

  const expenses = data.expenses ?? [];
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);

  expenses.forEach((row, idx) => {
    if (isOddRow(idx)) {
      fillRGB(doc, lightBg);
      doc.rect(M, y, UW, ROW_H, "F");
    }
    drawRGB(doc, [221, 221, 221]);
    doc.setLineWidth(0.1);
    doc.line(M, y + ROW_H, M + UW, y + ROW_H);

    setRGB(doc, DARK_GREY);
    doc.text(String(idx + 1),                                         colX.num   + COL.num / 2, y + 4.8, { align: "center" });
    doc.text(ellipsis(doc, row.date          ?? "", COL.date  - 2),   colX.date  + 1.5,         y + 4.8);
    doc.text(ellipsis(doc, row.name          ?? "", COL.name  - 2),   colX.name  + 1.5,         y + 4.8);
    doc.text(ellipsis(doc, row.category_name ?? "", COL.cat   - 2),   colX.cat   + 1.5,         y + 4.8);
    doc.text(fmtPKR(row.amount ?? 0),                                 colX.amt   + COL.amt - 1.5, y + 4.8, { align: "right" });
    doc.text(ellipsis(doc, row.notes || "—",        COL.notes - 2),   colX.notes + 1.5,         y + 4.8);

    y += ROW_H;
  });

  if (expenses.length === 0) {
    setRGB(doc, MID_GREY);
    doc.setFontSize(9);
    doc.text("No expenses recorded for this period.", M + UW / 2, y + 5, { align: "center" });
    y += 12;
  }

  y += 5;

  const TOT_W = 75;
  const TOT_X = M + UW - TOT_W;
  const CELL_H = 7;
  fillRGB(doc, RED);
  doc.roundedRect(TOT_X, y, TOT_W, CELL_H, 0, 0, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  setRGB(doc, WHITE);
  doc.text("TOTAL",                    TOT_X + 8,          y + 4.8);
  doc.text(fmtPKR(data.total ?? 0),   TOT_X + TOT_W - 3,  y + 4.8, { align: "right" });

  y += CELL_H + 10;

  drawRGB(doc, RULE_GREY);
  doc.setLineWidth(0.3);
  doc.line(M, y, M + UW, y);
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  setRGB(doc, MID_GREY);
  doc.text(
    branding.clinicName
      ? `${branding.clinicName} — Daily expense summary`
      : "Daily expense summary",
    M + UW / 2, y, { align: "center" }
  );
  y += 4;
  doc.setFontSize(7);
  setRGB(doc, [170, 170, 170]);
  doc.text("Developed by hifi.", M + UW / 2, y, { align: "center" });

  const pdfBytes = doc.output("arraybuffer");
  fs.writeFileSync(outputPath, Buffer.from(pdfBytes));
  return outputPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// THERMAL / POS SLIP  (72 mm wide)
// ─────────────────────────────────────────────────────────────────────────────
function generatePOSSlipPDF(data, outputPath) {
  const branding = data.branding || {};
  const pos = branding.pos || {};
  const posShowLogo        = pos.showLogo        ?? true;
  const posShowPhone       = pos.showPhone       ?? true;
  const posShowClientPhone = pos.showClientPhone ?? true;
  const posShowVet         = pos.showVet         ?? true;
  const posShowAddress     = pos.showAddress     ?? true;
  const posShowBank        = pos.showBank        ?? true;
  const posHeaderStyle     = pos.headerStyle     ?? "clinicName";

  const clinicName = posHeaderStyle === "invoice"
    ? "INVOICE"
    : String(branding.clinicName || DEFAULTS.clinicName);

  // POS slip uses a simpler 3-int array for inline setTextColor calls
  const RED_RGB = parseColor(branding.color);
  const redCss  = `rgb(${RED_RGB.join(",")})`;  // for HTML version

  const W_MM = 72;
  const M    = 2;
  const UW   = W_MM - M * 2;

  const items = data.line_items ?? data.cart ?? [];
  const c     = data.customer;

  const logoFile   = resolveLogoPath(branding.logoPath);
  const LOGO_SIZE  = 18;

  // ── Height estimation ──────────────────────────────────────────────────────
  let calculatedHeight = M;
  if (logoFile && posShowLogo) calculatedHeight += LOGO_SIZE + 2;
  calculatedHeight += 5 + 3 + 3; // name, space, divider
  if (branding.address && posShowAddress) calculatedHeight += 4;
  if (branding.phone && posShowPhone) calculatedHeight += 4;

  if (data.invoice_no)   calculatedHeight += 4;
  if (data.billing_date) calculatedHeight += 4;
  if (data.billing_time) calculatedHeight += 4;

  if (c && Object.values(c).some(Boolean)) {
    calculatedHeight += 3;
    if (c.client_name)      calculatedHeight += 4;
    if (c.contact_number && posShowClientPhone) calculatedHeight += 4;
    if (c.pet_name)         calculatedHeight += 4;
    if (c.appointment_date) calculatedHeight += 4;
    if (c.appointment_time) calculatedHeight += 4;
    if (c.doctor && posShowVet) calculatedHeight += 4;
  }

  calculatedHeight += 3 + 4 + 3; // divider + header + divider
  items.forEach(() => { calculatedHeight += 4 + 4; });

  calculatedHeight += 3 + 4; // divider + subtotal

  const couponDiscount = parseFloat(data.discount             ?? 0);
  const manualDiscount = parseFloat(data.manualDiscountAmount ?? 0);
  if (couponDiscount > 0) calculatedHeight += 4;
  if (manualDiscount > 0) calculatedHeight += 4;

  calculatedHeight += 3 + 7 + 10; // divider + total bar + spacing

  const bankName    = String(branding.bankName    || "");
  const bankAccount = String(branding.bankAccount || "");
  if (posShowBank && (bankName || bankAccount)) {
    calculatedHeight += 3; // divider
    if (bankName)    calculatedHeight += 4;
    if (bankAccount) calculatedHeight += 4;
    calculatedHeight += 2;
  }

  calculatedHeight += 4 + 1 + 4 + M; // thank you + gap + dev credit + bottom margin

  // ── Build PDF ──────────────────────────────────────────────────────────────
  const doc = new jsPDF({
    unit:     "mm",
    format:   [W_MM, calculatedHeight],
    compress: true,
  });

  let y = 2;

  if (logoFile && posShowLogo) {
    addLogo(doc, logoFile, (W_MM - LOGO_SIZE) / 2, y, LOGO_SIZE, LOGO_SIZE);
    y += LOGO_SIZE + 2;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...RED_RGB);
  doc.text(clinicName.toUpperCase(), W_MM / 2, y, { align: "center" });
  y += 5;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(100, 100, 100);

  if (branding.address && posShowAddress) {
    doc.text(String(branding.address), W_MM / 2, y, { align: "center" });
    y += 4;
  }
  if (branding.phone && posShowPhone) {
    doc.text(String(branding.phone), W_MM / 2, y, { align: "center" });
    y += 3;
  } else {
    y += 3;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const drawDivider = (style = "dashed") => {
    doc.setDrawColor(style === "solid" ? RED_RGB[0] : 180, style === "solid" ? RED_RGB[1] : 180, style === "solid" ? RED_RGB[2] : 180);
    doc.setLineWidth(style === "solid" ? 0.4 : 0.2);
    doc.line(M, y, M + UW, y);
    y += 3;
  };

  const row = (label, value, opts = {}) => {
    const { bold = false, size = 8, color = [40, 40, 40] } = opts;
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(String(label), M, y);
    doc.text(String(value), M + UW, y, { align: "right" });
    y += 4;
  };

  const singleLine = (text, opts = {}) => {
    const { bold = false, size = 8, color = [40, 40, 40], align = "left" } = opts;
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const x = align === "center" ? W_MM / 2 : align === "right" ? M + UW : M;
    doc.text(String(text), x, y, { align });
    y += 4;
  };

  const fmtAmt = (num) =>
    `Rs${parseFloat(num || 0).toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  drawDivider("solid");

  if (data.invoice_no)   row("Invoice#", `#${data.invoice_no}`);
  if (data.billing_date) row("Date", data.billing_date);
  if (data.billing_time) row("Time", data.billing_time);

  if (c && Object.values(c).some(Boolean)) {
    drawDivider();
    if (c.client_name)      row("Client", c.client_name);
    if (c.contact_number && posShowClientPhone) row("Phone",  c.contact_number);
    if (c.pet_name)         row("Pet",    c.pet_name);
    if (c.appointment_date) row("Appt",   c.appointment_date);
    if (c.appointment_time) row("Time",   c.appointment_time);
    if (c.doctor && posShowVet) row("Vet", c.doctor);
  }

  drawDivider();
  row("ITEM", "TOTAL", { bold: true, color: RED_RGB });
  drawDivider();

  items.forEach((item) => {
    const qty     = parseFloat(item.cartQty ?? item.quantity ?? 1);
    // null price is a deliberate sentinel for grouped category rows with no
    // single real unit price (see buildAppointmentInvoicePayload) — shown as
    // "-" rather than fabricating an average.
    const price   = item.price == null ? null : parseFloat(item.price);
    const total   = parseFloat(item.total ?? qty * (price ?? 0));
    const qtyDisp = fmtQty(qty);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(40, 40, 40);
    doc.text(String(item.name ?? "Item"), M, y);
    y += 4;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(30, 30, 30);
    doc.text(`  ${qtyDisp} x ${price == null ? "-" : fmtAmt(price)}`, M, y);
    doc.text(fmtAmt(total), M + UW, y, { align: "right" });
    y += 4;
  });

  drawDivider();
  row("Subtotal", fmtAmt(data.subtotal ?? 0));

  if (couponDiscount > 0) {
    row(data.coupon ? `Coupon (${data.coupon})` : "Coupon", `-${fmtAmt(couponDiscount)}`, { color: RED_RGB });
  }
  if (manualDiscount > 0) {
    row("Discount", `-${fmtAmt(manualDiscount)}`, { color: RED_RGB });
  }

  drawDivider("solid");

  // TOTAL bar
  doc.setFillColor(...RED_RGB);
  doc.rect(M, y - 1, UW, 7, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("TOTAL", M + 2, y + 4);
  doc.text(fmtAmt(data.finalTotal ?? 0), M + UW - 1, y + 4, { align: "right" });
  y += 10;

  // Bank details
  if (posShowBank && (bankName || bankAccount)) {
    drawDivider();
    if (bankName)    singleLine(bankName,              { align: "center", color: [100, 100, 100] });
    if (bankAccount) singleLine(`A/C: ${bankAccount}`, { align: "center", color: [100, 100, 100] });
    y += 2;
  }

  singleLine("Thank you for trusting us with your pet's care!", {
    align: "center", bold: true, color: RED_RGB,
  });
  y += 1;
  singleLine("Developed by hifi.", {
    align: "center", size: 6.5, color: RED_RGB,
  });

  const pdfBytes = doc.output("arraybuffer");
  fs.writeFileSync(outputPath, Buffer.from(pdfBytes));
  return outputPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// THERMAL PRINT (HTML → Electron BrowserWindow)
// ─────────────────────────────────────────────────────────────────────────────
async function printPOSSlip(data, printerName = "POS-80-Series") {
  const { BrowserWindow } = require("electron");

  const branding  = data.branding || {};
  const pos = branding.pos || {};
  const posShowLogo        = pos.showLogo        ?? true;
  const posShowPhone       = pos.showPhone       ?? true;
  const posShowClientPhone = pos.showClientPhone ?? true;
  const posShowVet         = pos.showVet         ?? true;
  const posShowAddress     = pos.showAddress     ?? true;
  const posShowBank        = pos.showBank        ?? true;
  const posHeaderStyle     = pos.headerStyle     ?? "clinicName";

  const clinicName = posHeaderStyle === "invoice"
    ? "INVOICE"
    : String(branding.clinicName || DEFAULTS.clinicName);

  const RED_RGB   = parseColor(branding.color);
  const redCss    = `rgb(${RED_RGB.join(",")})`;
  const logoFile  = resolveLogoPath(branding.logoPath);
  const logoSrc   = logoFile
    ? `data:image/png;base64,${fs.readFileSync(logoFile, "base64")}`
    : null;

  const address    = String(branding.address    || "");
  const phone      = String(branding.phone      || "");
  const bankName   = String(branding.bankName   || "");
  const bankAcct   = String(branding.bankAccount || "");

  const fmt = (n) =>
    `Rs${parseFloat(n || 0).toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;

  const items          = data.line_items ?? data.cart ?? [];
  const c              = data.customer   ?? {};
  const couponDiscount = parseFloat(data.discount             ?? 0);
  const manualDiscount = parseFloat(data.manualDiscountAmount ?? 0);

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=2.0"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 13px;
    width: 72mm;
    padding: 4mm 3mm;
    color: #111;
    font-variant-numeric: lining-nums;
    -webkit-font-feature-settings: "lnum";
    font-feature-settings: "lnum";
  }
  .center  { text-align: center; }
  .right   { text-align: right; }
  .bold    { font-weight: bold; }
  .logo    { display: block; margin: 0 auto 4px; width: 18mm; }
  hr       { border: none; border-top: 1px dashed #aaa; margin: 5px 0; }
  hr.solid { border-top: 1.5px solid ${redCss}; margin: 5px 0; }
  .row     { display: flex; justify-content: space-between; margin: 2px 0; font-size: 13px; }
  .row .label { color: #111; font-weight: normal; }
  .row .value { color: #222; font-weight: bold; }
  .total-bar {
    background: ${redCss}; color: #fff;
    display: flex; justify-content: space-between;
    padding: 4px 5px; font-weight: bold; font-size: 14px; margin: 5px 0;
  }
  .item-name { margin-top: 6px; font-weight: bold; font-size: 13px; color: #111; }
  .item-calc {
    display: flex; justify-content: space-between;
    padding-left: 8px; font-size: 13px;
    margin-bottom: 2px; color: #222; font-weight: bold;
  }
  .clinic-name { font-family: Arial, Helvetica, sans-serif; font-size: 14px; font-weight: bold; letter-spacing: 1px; color: ${redCss}; }
  .clinic-addr { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; margin-top: 2px; font-weight: normal; }
  .bank-info   { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; text-align: center; margin: 1px 0; font-weight: normal; }
  .footer-msg  { font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: bold; color: ${redCss}; text-align: center; margin-top: 4px; }
  .footer-dev  { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #aaa; text-align: center; margin-top: 2px; }
  .discount    { color: ${redCss}; }
</style>
</head>
<body>

  ${posShowLogo && logoSrc ? `<img src="${logoSrc}" class="logo"/>` : ""}

  <div class="center clinic-name">${clinicName.toUpperCase()}</div>
  ${address && posShowAddress ? `<div class="center clinic-addr">${address}</div>` : ""}
  ${branding.phone && posShowPhone ? `<div class="center clinic-addr">${phone}</div>` : ""}

  <hr class="solid"/>

  ${data.invoice_no   ? `<div class="row"><span class="label">Invoice#</span><span class="value">#${data.invoice_no}</span></div>` : ""}
  ${data.billing_date ? `<div class="row"><span class="label">Date</span><span class="value">${data.billing_date}</span></div>` : ""}
  ${data.billing_time ? `<div class="row"><span class="label">Time</span><span class="value">${data.billing_time}</span></div>` : ""}

  ${[c.client_name, c.contact_number, c.pet_name, c.appointment_date, c.appointment_time, c.doctor].some(Boolean) ? `
  <hr/>
  ${c.client_name      ? `<div class="row"><span class="label">Client</span><span class="value">${c.client_name}</span></div>` : ""}
  ${c.contact_number && posShowClientPhone ? `<div class="row"><span class="label">Phone</span><span class="value">${c.contact_number}</span></div>` : ""}
  ${c.pet_name         ? `<div class="row"><span class="label">Pet</span><span class="value">${c.pet_name}</span></div>` : ""}
  ${c.appointment_date ? `<div class="row"><span class="label">Appt</span><span class="value">${c.appointment_date}</span></div>` : ""}
  ${c.appointment_time ? `<div class="row"><span class="label">Time</span><span class="value">${c.appointment_time}</span></div>` : ""}
  ${c.doctor && posShowVet ? `<div class="row"><span class="label">Vet</span><span class="value">${c.doctor}</span></div>` : ""}
  ` : ""}

  <hr/>
  <div class="row bold" style="color:${redCss};"><span>ITEM</span><span>TOTAL</span></div>
  <hr/>

  ${items.map((item) => {
    const qty     = parseFloat(item.cartQty ?? item.quantity ?? 1);
    // null price is a deliberate sentinel for grouped category rows with no
    // single real unit price (see buildAppointmentInvoicePayload) — shown as
    // "-" rather than fabricating an average.
    const price   = item.price == null ? null : parseFloat(item.price);
    const total   = parseFloat(item.total ?? qty * (price ?? 0));
    const qtyDisp = fmtQty(qty);
    return `
    <div class="item-name">${item.name ?? "Item"}</div>
    <div class="item-calc"><span>${qtyDisp} &times; ${price == null ? "-" : fmt(price)}</span><span>${fmt(total)}</span></div>`;
  }).join("")}

  <hr/>
  <div class="row"><span class="label">Subtotal</span><span class="value">${fmt(data.subtotal ?? 0)}</span></div>
  ${couponDiscount > 0 ? `<div class="row"><span class="label">${data.coupon ? `Coupon (${data.coupon})` : "Coupon"}</span><span class="value discount">-${fmt(couponDiscount)}</span></div>` : ""}
  ${manualDiscount > 0 ? `<div class="row"><span class="label">Discount</span><span class="value discount">-${fmt(manualDiscount)}</span></div>` : ""}

  <hr class="solid"/>
  <div class="total-bar"><span>TOTAL</span><span>${fmt(data.finalTotal ?? 0)}</span></div>

  ${posShowBank && (bankName || bankAcct) ? `
  <hr/>
  ${bankName ? `<div class="bank-info">${bankName}</div>` : ""}
  ${bankAcct ? `<div class="bank-info">A/C: ${bankAcct}</div>` : ""}
  ` : ""}

  <br/>
  <div class="footer-msg">Thank you for trusting us with your pet's care!</div>
  <div class="footer-dev">Developed by hifi.</div>

</body>
</html>`;

  const tmpHtml = path.join(os.tmpdir(), `pos_slip_${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, "utf8");

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, zoomFactor: 1.0 },
    });
    win.loadURL(`file://${tmpHtml.replace(/\\/g, "/")}`);
    win.webContents.once("did-finish-load", () => {
      win.webContents.print(
        {
          silent:          true,
          printBackground: true,
          deviceName:      printerName,
          pageSize:        { width: 72000, height: 297000 },
          margins:         { marginType: "none" },
          scaleFactor:     100,
        },
        (success, errorType) => {
          win.destroy();
          try { fs.unlinkSync(tmpHtml); } catch (_) {}
          resolve(success ? { success: true } : { success: false, error: errorType });
        }
      );
    });
  });
}

async function printLabSlip(data, printerName = "POS-80-Series") {
  const { BrowserWindow } = require("electron");

  const escapeHtml = (text) =>
    String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br/>");

  const branding   = data.branding || {};
  const clinicName = String(branding.clinicName || DEFAULTS.clinicName);
  const RED_RGB    = parseColor(branding.color);
  const redCss     = `rgb(${RED_RGB.join(",")})`;
  const logoFile   = resolveLogoPath(branding.logoPath);
  const logoSrc    = logoFile
    ? `data:image/png;base64,${fs.readFileSync(logoFile, "base64")}`
    : null;

  const address = String(branding.address || "");
  const phone   = String(branding.phone   || "");
  const pet     = data.pet || {};

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=2.0"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 13px;
    width: 72mm;
    padding: 4mm 3mm;
    color: #111;
    font-variant-numeric: lining-nums;
    -webkit-font-feature-settings: "lnum";
    font-feature-settings: "lnum";
  }
  .center      { text-align: center; }
  .bold        { font-weight: bold; }
  .logo        { display: block; margin: 0 auto 4px; width: 18mm; }
  hr           { border: none; border-top: 1px dashed #aaa; margin: 5px 0; }
  hr.solid     { border-top: 1.5px solid ${redCss}; margin: 5px 0; }
  .row         { display: flex; justify-content: space-between; margin: 2px 0; font-size: 13px; }
  .row .label  { color: #111; font-weight: normal; }
  .row .value  { color: #222; font-weight: bold; }
  .clinic-name { font-family: Arial, Helvetica, sans-serif; font-size: 14px; font-weight: bold; letter-spacing: 1px; color: ${redCss}; }
  .clinic-addr { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; margin-top: 2px; font-weight: normal; }
  .client-name { font-size: 15px; font-weight: bold; margin: 4px 0 6px; color: #111; }
  .tests-box   { border: 1.5px solid ${redCss}; margin: 6px 0; }
  .tests-head  { background: ${redCss}; color: #fff; font-weight: bold; font-size: 12px; text-align: center; padding: 3px 4px; letter-spacing: 0.5px; }
  .tests-body  { padding: 5px 6px; font-size: 13px; font-weight: bold; color: #222; line-height: 1.4; word-break: break-word; }
  .phone-line  { font-size: 13px; font-weight: bold; text-align: center; margin: 4px 0; color: #111; }
  .ordered-by  { font-size: 13px; font-weight: bold; text-align: center; margin-top: 4px; color: #111; }
  .footer-dev  { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #aaa; text-align: center; margin-top: 6px; }
</style>
</head>
<body>

  ${logoSrc ? `<img src="${logoSrc}" class="logo"/>` : ""}

  <div class="center clinic-name">${escapeHtml(clinicName).toUpperCase()}</div>
  ${address ? `<div class="center clinic-addr">${escapeHtml(address)}</div>` : ""}
  ${phone   ? `<div class="center clinic-addr">${escapeHtml(phone)}</div>` : ""}

  <hr class="solid"/>

  <div class="client-name">${escapeHtml(data.client_name || "")}</div>

    ${pet.pet_name ? `<div class="row"><span class="label">Pet name</span><span class="value">${escapeHtml(pet.pet_name)}</span></div>` : ""}
    ${pet.species ? `<div class="row"><span class="label">Species</span><span class="value">${escapeHtml(pet.species)}</span></div>` : ""}
  ${pet.sex      ? `<div class="row"><span class="label">Gender</span><span class="value">${escapeHtml(String(pet.sex).toLowerCase())}</span></div>` : ""}
  ${pet.breed    ? `<div class="row"><span class="label">Breed</span><span class="value">${escapeHtml(pet.breed)}</span></div>` : ""}
  ${pet.age      ? `<div class="row"><span class="label">Age</span><span class="value">${escapeHtml(pet.age)}</span></div>` : ""}

  <div class="tests-box">
    <div class="tests-head">TESTS REQUIRED</div>
    <div class="tests-body">${escapeHtml(data.tests || "")}</div>
  </div>

  <hr/>

  ${data.ordered_by     ? `<div class="ordered-by">${escapeHtml(data.ordered_by)}</div>` : ""}

  <div class="footer-dev">Developed by hifi.</div>

</body>
</html>`;

  const tmpHtml = path.join(os.tmpdir(), `lab_slip_${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, "utf8");

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, zoomFactor: 1.0 },
    });
    win.loadURL(`file://${tmpHtml.replace(/\\/g, "/")}`);
    win.webContents.once("did-finish-load", () => {
      win.webContents.print(
        {
          silent:          true,
          printBackground: true,
          deviceName:      printerName,
          pageSize:        { width: 72000, height: 297000 },
          margins:         { marginType: "none" },
          scaleFactor:     100,
        },
        (success, errorType) => {
          win.destroy();
          try { fs.unlinkSync(tmpHtml); } catch (_) {}
          resolve(success ? { success: true } : { success: false, error: errorType });
        }
      );
    });
  });
}

// Opens an already-rendered PDF file (on disk) in a hidden BrowserWindow and
// sends it straight to the native OS print dialog — the user picks a printer
// each time, same as Billing.jsx's existing iframe.contentWindow.print()
// action, since there's no stored default A4 printer anywhere in this app
// (unlike POS/thermal receipts, which are silently forced to a fixed
// 72mm device).
async function printGeneratedPdf(filePath) {
  const { BrowserWindow } = require("electron");
  return new Promise((resolve) => {
    const win = new BrowserWindow({ show: false });
    // #toolbar=0&navpanes=0&scrollbar=0 — Chromium's built-in PDF viewer
    // honours these as PDF Open Parameters and hides its own toolbar and
    // page-thumbnail sidebar. Without them, that viewer chrome (and its dark
    // matte background behind/around the page) gets printed alongside the
    // document itself: a dark rectangle where the chrome sat, and the actual
    // document squeezed into a fraction of the page next to it.
    win.loadURL(`file://${filePath.replace(/\\/g, "/")}#toolbar=0&navpanes=0&scrollbar=0`);
    // did-finish-load fires once the outer PDF-viewer frame itself has
    // loaded, but the embedded PDF page is rendered by a separate guest view
    // that can still be mid-render at that point — printing immediately
    // captures that half-rendered state. did-stop-loading waits until all of
    // that subframe activity has actually settled before we print.
    win.webContents.once("did-stop-loading", () => {
      // A4 page size (210mm × 297mm) in microns, matching the PDFs generated
      // by jsPDF({ unit: "mm", format: "a4" }). Explicit margins: none to
      // prevent Chromium's print engine from applying default margins that
      // can garble the layout when the PDF viewer UI is hidden.
      const printOptions = {
        silent: false,
        printBackground: true,
        margins: { marginType: "none" },
        pageSize: { width: 210000, height: 297000 },  // A4 in microns
        scaleFactor: 100,
      };
      console.log("[printGeneratedPdf]", filePath, "— print options:", printOptions);
      win.webContents.print(printOptions, (success, errorType) => {
        win.destroy();
        resolve(success ? { success: true } : { success: false, error: errorType });
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BOARDING CONSENT FORM — a distinct pipeline from consentForm.js
// (Appointments' own, unrelated surgical/medical consent form). Ported from
// the legacy single-tenant app's (PetVet-EMR) generateBoardingConsentFormJS,
// which is the accurate/complete version of this document — this port must
// stay a faithful match to it, not the earlier incomplete port. Page 1 is the
// stay's own fillable details (owner/pet/schedule/feeding/medical/optional
// services/consent-summary), Page 2 is the full CONSENT_POLICY_TEXT policy
// document. Auto-generated on every check-in (best-effort, never blocks
// check-in — see boardingHandlers.js), previewable/printable on demand.
// ─────────────────────────────────────────────────────────────────────────────
const { CONSENT_POLICY_TEXT } = require("./consentPolicyText");

const CONSENT_POLICY_HEADINGS = [
  "Health Declaration",
  "Medical Treatment Authorization",
  "Special Medical Conditions",
  "Risk Acknowledgement",
  "Aggressive or Dangerous Pets",
  "Personal Belongings",
  "Payment Policy",
  "Late Pickup",
  "Abandoned Pets",
  "Agreement",
];

// Splits CONSENT_POLICY_TEXT into an intro paragraph plus one block per known
// heading (CONSENT_POLICY_HEADINGS) — a plain heading-then-body walk, not a
// generic markdown parser, since the text's own shape is fixed and known.
// The trailing "Owner's Signature:"/"Date:" lines are deliberately excluded
// from the last section's body — generateBoardingConsentFormJS renders its
// own signature/date lines below (with the date pre-filled), same styling as
// Page 1's own fillable fields.
function parseConsentPolicyText(rawText, clinicName) {
  const resolvedName = String(clinicName || DEFAULTS.clinicName);
  const substitute = (line) => line.split("[Clinic Name]").join(resolvedName);

  const introLines = [];
  const sections = [];
  let current = null;

  for (const line of rawText.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (CONSENT_POLICY_HEADINGS.includes(trimmed)) {
      current = { heading: trimmed, bodyLines: [] };
      sections.push(current);
      continue;
    }
    if (/^Owner's Signature:/.test(trimmed) || /^Date:/.test(trimmed)) break;

    if (current) current.bodyLines.push(substitute(line));
    else introLines.push(substitute(line));
  }

  return { introLines, sections };
}

function loadConsentPolicyDocument(clinicName) {
  return parseConsentPolicyText(CONSENT_POLICY_TEXT, clinicName);
}

function generateBoardingConsentFormJS(data, outputPath) {
  const branding = data.branding || {};
  const RED = parseColor(branding.color);
  const printMode = !!data.printMode;

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const PW = 210;
  const M = 18;
  const UW = PW - 2 * M;
  const half = M + UW / 2;

  let y = drawClinicHeader(doc, M, branding, printMode);

  // ── Title bar ──────────────────────────────────────────────────────────────
  const BAR_H = 14;
  drawBar(doc, M, y, UW, BAR_H, RED, printMode, 2);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  setRGB(doc, barTextColor(printMode, RED));
  doc.text("BOARDING CONSENT FORM", M + UW / 2, y + 9, { align: "center" });
  y += BAR_H + 8;

  const sectionHeader = (title) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    setRGB(doc, RED);
    doc.text(title, M, y);
    y += 2.2;
    drawRGB(doc, [229, 231, 235]);
    doc.setLineWidth(0.3);
    doc.line(M, y, M + UW, y);
    y += 4.8;
  };

  // Checkbox at an explicit (x, y) — a filled brand-colour square with a
  // white check mark when `checked` is true (pre-filled from a real
  // record), otherwise an empty outline square left for the physical form
  // to tick by hand.
  const CB = 3.4;
  const checkboxLabelAt = (x, yPos, text, checked) => {
    if (checked) {
      fillRGB(doc, RED);
      doc.roundedRect(x, yPos - CB + 0.8, CB, CB, 0.5, 0.5, "F");
      doc.setDrawColor(255, 255, 255);
      doc.setLineWidth(0.5);
      doc.line(x + 0.6, yPos - 1.3, x + 1.4, yPos - 0.5);
      doc.line(x + 1.4, yPos - 0.5, x + 2.8, yPos - 2.2);
    } else {
      doc.setDrawColor(180, 180, 180);
      doc.setLineWidth(0.3);
      doc.rect(x, yPos - CB + 0.8, CB, CB);
    }
    doc.setFont("helvetica", checked ? "bold" : "normal");
    doc.setFontSize(9);
    setRGB(doc, checked ? DARK_GREY : MID_GREY);
    doc.text(text, x + CB + 2, yPos);
  };

  // Pre-filled onto an underline when a value is on file — never fabricate
  // one that isn't actually known, that's what the physical form is for.
  const fillLine = (label, value, x, lineEndX) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    setRGB(doc, MID_GREY);
    doc.text(label, x, y);
    const labelW = doc.getTextWidth(label) + 2;
    drawRGB(doc, RULE_GREY);
    doc.setLineWidth(0.25);
    doc.line(x + labelW, y + 0.8, lineEndX, y + 0.8);
    if (value) {
      doc.setFont("helvetica", "bold");
      setRGB(doc, DARK_GREY);
      const maxW = lineEndX - (x + labelW) - 1;
      doc.text(ellipsis(doc, String(value), maxW), x + labelW + 1, y);
    }
  };

  // ── Owner Information ────────────────────────────────────────────────────
  sectionHeader("Owner Information");
  fillLine("Owner's Name:", data.owner?.name, M, half - 4);
  fillLine("Phone Number:", data.owner?.phone, half, M + UW);
  y += 6.5;
  fillLine("Address:", data.owner?.address, M, M + UW);
  y += 6.5;
  fillLine("Emergency Contact Name/Number:", "", M, M + UW);
  y += 7.5;

  // ── Pet Information ──────────────────────────────────────────────────────
  sectionHeader("Pet Information");
  fillLine("Pet's Name:", data.pet?.name, M, half - 4);
  fillLine("Species:", data.pet?.species, half, M + UW);
  y += 6.5;
  fillLine("Color/Markings:", data.pet?.color, M, half - 4);
  fillLine("Age:", data.pet?.age, half, M + UW);
  y += 6.5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setRGB(doc, MID_GREY);
  doc.text("Sex:", M, y);
  checkboxLabelAt(M + 9, y, "Male", data.pet?.sex === "Male");
  checkboxLabelAt(M + 30, y, "Female", data.pet?.sex === "Female");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setRGB(doc, MID_GREY);
  doc.text("Spayed/Neutered:", half, y);
  checkboxLabelAt(half + 30, y, "Yes", !!data.pet?.is_neutered);
  checkboxLabelAt(half + 45, y, "No", data.pet != null && !data.pet.is_neutered);
  y += 6.5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setRGB(doc, MID_GREY);
  doc.text("Microchipped:", M, y);
  checkboxLabelAt(M + 24, y, "Yes", false);
  checkboxLabelAt(M + 40, y, "No", false);
  y += 7.5;

  // ── Boarding Schedule ────────────────────────────────────────────────────
  sectionHeader("Boarding Schedule");
  fillLine("Drop-off Date:", data.drop_off_date || "", M, half - 4);
  fillLine("Pick-up Date:", data.pick_up_date || "", half, M + UW);
  y += 7.5;

  // ── Feeding Instructions — no source of truth in the schema for which
  // party is actually providing food on a given stay, so both boxes are
  // left blank for the physical form, with a blank line to note it by hand
  // (matching legacy exactly, not fabricating a value from an unrelated
  // always-false flag). ─────────────────────────────────────────────────────
  sectionHeader("Feeding Instructions");
  const ownerFoodX = M + 65;
  const ownerFoodLabel = "Owner providing food:";
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const ownerFoodLabelW = doc.getTextWidth(ownerFoodLabel);
  checkboxLabelAt(M, y, "Clinic to provide food", false);
  checkboxLabelAt(ownerFoodX, y, ownerFoodLabel, false);
  drawRGB(doc, RULE_GREY);
  doc.setLineWidth(0.25);
  doc.line(ownerFoodX + CB + 2 + ownerFoodLabelW + 2, y + 0.8, M + UW, y + 0.8);
  y += 7.5;

  // ── Medical Info — no source of truth in the schema yet; blank fillable
  // fields for the physical copy. ──────────────────────────────────────────
  sectionHeader("Medical Info");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setRGB(doc, MID_GREY);
  const vaccQLabel = "Vaccinations (Rabies, Core) & Deworming up to date?";
  doc.text(vaccQLabel, M, y);
  const vaccQW = doc.getTextWidth(vaccQLabel);
  checkboxLabelAt(M + vaccQW + 5, y, "Yes", false);
  checkboxLabelAt(M + vaccQW + 22, y, "No", false);
  y += 6.5;
  fillLine("Last Vaccination Date:", "", M, half - 4);
  fillLine("Last Deworming Date:", "", half, M + UW);
  y += 6.5;
  fillLine("Medications:", "", M, M + UW);
  y += 6.5;
  fillLine("Known Allergies or Conditions:", "", M, M + UW);
  y += 7.5;

  // ── Optional Services Requested — 3-column checkbox grid, fixed columns
  // rather than dynamic text-width flow since the label set is fixed. ──────
  sectionHeader("Optional Services Requested");
  const optionalServices = ["Grooming", "Nail Trim", "Deworming", "Vaccinations", "Bath Before Pickup", "External Parasites Treatment"];
  const colW = UW / 3;
  optionalServices.forEach((label, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    checkboxLabelAt(M + col * colW, y + row * 6.5, label, false);
  });
  y += Math.ceil(optionalServices.length / 3) * 6.5 + 1;
  fillLine("Other:", "", M, M + UW);
  y += 7.5;

  // Signature/Date deliberately does NOT appear here — this form has a
  // single signature/date line for the whole document, on Page 2, after the
  // Agreement section (see below). Two separate sign-here moments read as
  // confusing/redundant on one consent document; don't reintroduce a
  // second one at the end of Page 1.

  // ── Footer ───────────────────────────────────────────────────────────────
  if (y > 272) {
    doc.addPage();
    y = M;
  }
  drawRGB(doc, RULE_GREY);
  doc.setLineWidth(0.3);
  doc.line(M, y, M + UW, y);
  y += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  setRGB(doc, MID_GREY);
  doc.text(branding.clinicName || DEFAULTS.clinicName, M, y);
  doc.text(`Generated on ${data.generated_on || ""}`, M + UW, y, { align: "right" });

  // ── Page 2 — Consent & Policy Agreement, verbatim from CONSENT_POLICY_TEXT.
  // Always its own fresh page, not a Page-1-overflow continuation.
  doc.addPage();
  y = M;
  y = drawClinicHeader(doc, y, branding, printMode);

  const policyDoc = loadConsentPolicyDocument(branding.clinicName);

  sectionHeader("Consent & Payment Policy");

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setRGB(doc, DARK_GREY);
  const introLineHeight = doc.getLineHeight() / doc.internal.scaleFactor;
  policyDoc.introLines.forEach((line) => {
    const wrapped = doc.splitTextToSize(line, UW);
    if (y + wrapped.length * introLineHeight > 270) {
      doc.addPage();
      y = M;
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    setRGB(doc, DARK_GREY);
    doc.text(wrapped, M, y);
    y += wrapped.length * introLineHeight + 2;
  });
  y += 3;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const bodyLineHeight = doc.getLineHeight() / doc.internal.scaleFactor;
  policyDoc.sections.forEach(({ heading, bodyLines }) => {
    if (y > 265) {
      doc.addPage();
      y = M;
    }
    sectionHeader(heading);
    bodyLines.forEach((line) => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      const wrapped = doc.splitTextToSize(line, UW);
      if (y + wrapped.length * bodyLineHeight > 270) {
        doc.addPage();
        y = M;
      }
      setRGB(doc, DARK_GREY);
      doc.text(wrapped, M, y);
      y += wrapped.length * bodyLineHeight + 2;
    });
    y += 4;
  });

  // Date is pre-filled with the drop-off date — this form is generated and
  // handed to the owner at check-in, before boarding begins, so the date
  // it's being signed on IS the drop-off date. Owner's Signature stays
  // genuinely blank.
  if (y > 262) {
    doc.addPage();
    y = M;
  }
  y += 2;
  fillLine("Owner's Signature:", "", M, M + 110);
  fillLine("Date:", data.drop_off_date || "", M + 120, M + UW);
  y += 8;

  if (y > 272) {
    doc.addPage();
    y = M;
  }
  drawRGB(doc, RULE_GREY);
  doc.setLineWidth(0.3);
  doc.line(M, y, M + UW, y);
  y += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  setRGB(doc, MID_GREY);
  doc.text(branding.clinicName || DEFAULTS.clinicName, M, y);
  doc.text(`Generated on ${data.generated_on || ""}`, M + UW, y, { align: "right" });

  const pdfBytes = doc.output("arraybuffer");
  fs.writeFileSync(outputPath, Buffer.from(pdfBytes));
  return outputPath;
}

async function generateBoardingConsentFormPDF(data, filePath) {
  generateBoardingConsentFormJS(data, filePath);
}

// ── Async wrappers ─────────────────────────────────────────────────────────────
async function generateInvoicePDF(invoiceData, filePath) {
  generateInvoiceJS(invoiceData, filePath);
}

async function generateExpenseReportPDFAsync(data, filePath) {
  generateExpenseReportPDF(data, filePath);
}

module.exports = {
  generateInvoicePDF,
  generateInvoiceJS,
  generateExpenseReportPDF,
  generateExpenseReportPDFAsync,
  generatePOSSlipPDF,
  generateBoardingConsentFormPDF,
  generateBoardingConsentFormJS,
  printPOSSlip,
  printLabSlip,
  printGeneratedPdf,
  // Shared low-level PDF building blocks — exported so other document
  // types (e.g. boardingSummaryPDF.js) can draw a real per-clinic branded
  // header instead of each hand-rolling their own (see consentForm.js's
  // fix, which used to hardcode a fixed clinic name and logo path instead
  // of using any of this).
  drawClinicHeader,
  parseColor,
  setRGB,
  fillRGB,
  drawRGB,
  ellipsis,
  fmtPKR,
  DEFAULTS,
  DARK_GREY,
  MID_GREY,
  RULE_GREY,
};