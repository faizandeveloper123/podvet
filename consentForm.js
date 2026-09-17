const { jsPDF } = require("jspdf");
const fs = require("fs");
const path = require("path");
const { drawClinicHeader } = require("./generate_invoice");

// Helper to draw inline underlined label + value
function drawLabelAndValue(doc, label, value, x, y) {
  doc.text(label, x, y);
  const labelWidth = doc.getTextWidth(label) + 2; // space after label
  doc.text(value, x + labelWidth, y);
  const valueWidth = doc.getTextWidth(value);
  doc.line(x + labelWidth, y + 1, x + labelWidth + valueWidth, y + 1); // underline
}

// `branding` is the same per-clinic object generate_invoice.js's own
// documents already use (resolveApiBranding(store, clinic) — clinicName/
// logoPath/address/phone/color), built by the caller via buildBranding(store).
// Previously this hardcoded "Khans Veterinary Services" and a fixed
// KVSLogo.png path regardless of which clinic generated the form — a real
// bug for any other multi-tenant clinic using this screen.
function generateConsentForm(appointmentData, branding) {
  try {
    const doc = new jsPDF();

    const y = drawClinicHeader(doc, 12, branding || {});

    // Owner & Pet info
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(12);

    // Owner's Name
    drawLabelAndValue(doc, "Owner's Name:", appointmentData.ownerName || 'N/A', 15, y + 12);

    // Pet's Name
    drawLabelAndValue(doc, "Pet's Name:", appointmentData.petName || 'N/A', 15, y + 22);

    // Breed
    drawLabelAndValue(doc, "Breed:", appointmentData.breed || 'N/A', 80, y + 22);

    // Sex
    drawLabelAndValue(doc, "Sex:", appointmentData.sex || 'N/A', 140, y + 22);

    // Age
    drawLabelAndValue(doc, "Age:", appointmentData.age || 'N/A', 15, y + 32);

    // Color
    drawLabelAndValue(doc, "Color:", appointmentData.color || 'N/A', 80, y + 32);

    // Body text — generic "the attending veterinarian(s)"/clinic name
    // instead of a hardcoded doctor/clinic, so this reads correctly no
    // matter which clinic generated the form.
    const clinicName = (branding && branding.clinicName) || "the clinic";
    const bodyText = `
I certify that I own the above described animal and do hereby consent and authorize
the attending veterinarian(s) at ${clinicName} to hospitalize and/or administer vaccinations,
medication, tests, surgical procedures, or treatments the doctor and their associates deem
necessary for the health, safety, or well-being of the above animal while it is under their care and supervision.

If the pet should injure itself in an escape attempt, refuse food, urinate or defecate on itself,
become ill or die while in the hospital, I will hold the attending veterinarian(s) and staff of
${clinicName} free of any responsibility or liability in the absence of gross negligence.

I realize that my pet will only be discharged during regular office hours and when the doctor
or their associates are present, and the fee due for its care will be paid in full at that time.

In the event that I become ill, move, or change my address, it shall be my duty to inform
the hospital of such change.

I hereby acknowledge that I have read the foregoing and fully understand the terms and
conditions set forth.
`;

    doc.setFontSize(13);

    // Wrap text automatically
    const wrappedText = doc.splitTextToSize(bodyText, 180);
    doc.text(wrappedText, 15, y + 47);

    // Signature lines
    doc.text("Signed ___________________________", 15, 250);
    doc.text("Dated ____________________", 140, 250);

    doc.text("Staff Member Signature ___________________", 15, 270);
    doc.text("Dated ____________________", 140, 270);

    // Generate filename with timestamp to avoid conflicts
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ConsentForm_${appointmentData.petName}_${timestamp}.pdf`;
    
    // Save PDF to Downloads folder or current directory
    const pdfBytes = doc.output("arraybuffer");
    const downloadsPath = path.join(require('os').homedir(), 'Downloads', filename);
    
    try {
      fs.writeFileSync(downloadsPath, Buffer.from(pdfBytes));
      return { success: true, filePath: downloadsPath };
    } catch (error) {
      // Fallback to current directory if Downloads folder is not accessible
      const fallbackPath = path.join(process.cwd(), filename);
      fs.writeFileSync(fallbackPath, Buffer.from(pdfBytes));
      return { success: true, filePath: fallbackPath };
    }
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { generateConsentForm };