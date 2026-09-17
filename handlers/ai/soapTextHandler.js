const { ipcMain } = require("electron");
const saasClient = require("../saasClient");

// Sanitize Unicode typography characters that LLMs frequently insert.
// jsPDF's splitTextToSize() only breaks on spaces and ASCII hyphens;
// non-breaking hyphens (U+2011) and smart quotes prevent proper text wrapping,
// causing clipping in PDFs. Normalize to plain ASCII for clean rendering.
const sanitizeUnicodeTypography = (text) =>
  String(text || "")
    .replace(/[‐‑‒–—]/g, "-")     // hyphens, en-dash, em-dash → -
    .replace(/['']/g, "'")                       // smart single quotes → '
    .replace(/[""]/g, '"')                       // smart double quotes → "
    .replace(/ /g, " ");                               // non-breaking space → space

// Both handlers proxy the backend's /api/ai/* endpoints — the Groq API key
// lives server-side only, never in a desktop install's local .env. This
// used to call Groq directly from this process (the prompts/guardrails now
// live in the backend's ai.service.ts, ported verbatim from here).
module.exports = function setupSoapTextHandlers() {
  ipcMain.handle("refine-soap-text", async (_event, { text, fieldLabel, context }) => {
    try {
      if (!text || !String(text).trim()) {
        return { success: false, message: "Nothing to refine — the field is empty." };
      }

      const result = await saasClient.refineSoapText({ text: String(text).trim(), fieldLabel, context });
      const refined = sanitizeUnicodeTypography(result.data);
      return { success: true, data: refined };
    } catch (err) {
      console.error("[refine-soap-text]", err);
      return { success: false, message: err.message || "Unexpected error during AI refinement." };
    }
  });

  ipcMain.handle("refine-reminder-note", async (_event, { text }) => {
    try {
      if (!text || !String(text).trim()) {
        return { success: false, message: "Nothing to refine — the reminder note is empty." };
      }

      const result = await saasClient.refineReminderNote(String(text).trim());
      const refined = sanitizeUnicodeTypography(result.data);
      return { success: true, data: refined };
    } catch (err) {
      console.error("[refine-reminder-note]", err);
      return { success: false, message: err.message || "Unexpected error during AI refinement." };
    }
  });
};
