// Boarding Hospitalization/Daily Summary — one renderer for both document
// types (Hospitalization Summary = the full admission-to-now timeline;
// Daily Summary = the same shape bounded to a date range), matching the
// backend's buildSummaryPayload, which already merges SOAP vitals +
// feeding log + medication log into one chronologically-sorted timeline
// with a pre-formatted `description` string per entry.
const { jsPDF } = require("jspdf");
const fs = require("fs");
const { drawClinicHeader, parseColor, setRGB, drawRGB, DEFAULTS, DARK_GREY, MID_GREY } = require("./generate_invoice");

const ENTRY_LABELS = { vitals: "Vitals Check", feeding: "Feeding", medication: "Medication" };

function generateBoardingSummaryJS(data, outputPath) {
  const branding = data.branding || {};
  const RED = parseColor(branding.color);

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const PW = 210;
  const M = 18;
  const UW = PW - 2 * M;

  let y = drawClinicHeader(doc, M, branding);

  const isDaily = !!data.is_daily_summary;
  const isSingleDay = isDaily && data.summary_date_from && data.summary_date_to && data.summary_date_from === data.summary_date_to;
  const titleText = !isDaily ? "HOSPITALIZATION SUMMARY" : isSingleDay ? "DAILY SUMMARY" : "BOARDING SUMMARY";

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  setRGB(doc, RED);
  doc.text(titleText, M + UW / 2, y + 4, { align: "center" });
  y += 10;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  setRGB(doc, [156, 163, 175]);
  const subtitle = isDaily
    ? isSingleDay
      ? `Covering ${data.summary_date_from} — This document is for reference only`
      : `Covering ${data.summary_date_from} to ${data.summary_date_to} — This document is for reference only`
    : `Generated on ${data.generated_on || ""} — This document is for reference only`;
  doc.text(subtitle, M + UW / 2, y, { align: "center" });
  y += 8;

  // ── Stay Information ──────────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  setRGB(doc, RED);
  doc.text("Stay Information", M, y);
  y += 6;
  drawRGB(doc, [229, 231, 235]);
  doc.setLineWidth(0.3);
  doc.line(M, y, M + UW, y);
  y += 5;

  const dischargeLabel = data.date_out || "Currently admitted";
  const infoGrid = [
    ["Patient", data.pet_name || "—", "Owner", data.client_name || "—"],
    ["Cage / Space", data.cage_label || "—", "Admitted", data.date_in || "—"],
    [null, null, "Discharged", dischargeLabel],
  ];
  doc.setFontSize(8.5);
  infoGrid.forEach(([l1, v1, l2, v2]) => {
    if (l1) {
      doc.setFont("helvetica", "normal");
      setRGB(doc, MID_GREY);
      doc.text(l1, M, y);
      doc.setFont("helvetica", "bold");
      setRGB(doc, DARK_GREY);
      doc.text(String(v1), M + 28, y);
    }
    if (l2) {
      doc.setFont("helvetica", "normal");
      setRGB(doc, MID_GREY);
      doc.text(l2, M + UW / 2, y);
      doc.setFont("helvetica", "bold");
      setRGB(doc, DARK_GREY);
      doc.text(String(v2), M + UW / 2 + 32, y);
    }
    y += 7;
  });
  y += 3;

  if (data.diagnosis || data.condition_status) {
    const parts = [];
    if (data.diagnosis) parts.push(`Reason: ${data.diagnosis}`);
    if (data.condition_status) parts.push(`Condition: ${data.condition_status}`);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    setRGB(doc, DARK_GREY);
    const lineHeight = doc.getLineHeight() / doc.internal.scaleFactor;
    const wrapped = doc.splitTextToSize(parts.join("   ·   "), UW - 10);
    if (y + wrapped.length * lineHeight + 5 > 270) {
      doc.addPage();
      y = M;
    }
    doc.text(wrapped, M + 3, y + 2);
    y += wrapped.length * lineHeight + 7;
  }

  // ── Care Timeline ─────────────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  setRGB(doc, RED);
  doc.text("Care Timeline", M, y);
  y += 6;
  drawRGB(doc, [229, 231, 235]);
  doc.line(M, y, M + UW, y);
  y += 5;

  const timeline = data.timeline || [];
  if (timeline.length === 0) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8.5);
    setRGB(doc, [156, 163, 175]);
    doc.text(isDaily ? "No care events logged for this period." : "No care events logged during this stay.", M, y);
    y += 8;
  } else {
    timeline.forEach((entry) => {
      if (y > 268) {
        doc.addPage();
        y = M;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      setRGB(doc, DARK_GREY);
      const label = ENTRY_LABELS[entry.type] || "Event";
      doc.text(`${entry.timestamp || ""}   ${label}`, M + 2, y + 4);

      if (entry.loggedBy) {
        doc.setFont("helvetica", "normal");
        setRGB(doc, MID_GREY);
        doc.text(entry.loggedBy, M + UW - 2, y + 4, { align: "right" });
      }
      y += 8;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      setRGB(doc, MID_GREY);
      const lineHeight = doc.getLineHeight() / doc.internal.scaleFactor;
      const wrapped = doc.splitTextToSize(entry.description || "", UW - 4);
      if (y + wrapped.length * lineHeight > 275) {
        doc.addPage();
        y = M;
      }
      doc.text(wrapped, M + 2, y);
      y += wrapped.length * lineHeight + 4;
    });
  }

  if (y > 272) {
    doc.addPage();
    y = M;
  }
  drawRGB(doc, [204, 204, 204]);
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

async function generateBoardingSummaryPDF(data, filePath) {
  generateBoardingSummaryJS(data, filePath);
}

module.exports = { generateBoardingSummaryPDF, generateBoardingSummaryJS };
