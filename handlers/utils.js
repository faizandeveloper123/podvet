const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const log = require("electron-log");
const cloudinary = require("cloudinary").v2;

// Requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
// Configured lazily (inside handlers, not at module load) because main.js
// requires handler files *before* its packaged-path dotenv.config() runs — a
// top-level cloudinary.config() would capture undefined in packaged builds.
// Shared singleton so every Cloudinary upload (report attachments, clinic
// logo) configures the client exactly once with the same credentials.
let cloudinaryConfigured = false;
function ensureCloudinaryConfigured() {
  if (cloudinaryConfigured) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  cloudinaryConfigured = true;
}

// ── Shared clinic branding (logo/name/color) — ClinicBranding holds exactly
// one row per clinic install. Local-disk logo cache avoids re-fetching from
// Cloudinary on every single document generation — only re-downloads when
// the DB's logo_url actually changes.
const brandingCacheDir  = () => path.join(app.getPath('userData'), 'branding');
const brandingCacheMeta = () => path.join(brandingCacheDir(), 'clinic_logo_cache.meta.json');
// Real image extension matters here — generate_invoice.js's addLogo() derives
// the image format jsPDF needs from path.extname(logoPath), so a generic
// .bin filename would silently break every PDF's logo rendering.
const brandingCacheFile = (ext) => path.join(brandingCacheDir(), `clinic_logo_cache.${ext}`);
const extFromContentType = (contentType) => {
  if (contentType?.includes('webp')) return 'webp';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return 'jpg';
  return 'png';
};

// Downloads logoUrl to a local disk cache (only re-fetching when the URL
// actually changes) and returns { logoDataUrl, logoPath } — factored out
// of getSharedBranding so the API-backed resolveApiBranding below can
// reuse the exact same caching mechanics against a Cloudinary logoUrl
// coming from the multi-tenant backend's Clinic record instead of the
// legacy local ClinicBranding table.
async function downloadAndCacheLogo(logoUrl) {
  if (!logoUrl) return { logoDataUrl: null, logoPath: null };
  try {
    await fs.promises.mkdir(brandingCacheDir(), { recursive: true });
    let cachedMeta = null;
    try {
      cachedMeta = JSON.parse(await fs.promises.readFile(brandingCacheMeta(), 'utf8'));
    } catch (_) {
      cachedMeta = null;
    }

    let cacheFile = brandingCacheFile(cachedMeta?.ext || 'png');
    const cacheIsStale = !cachedMeta || cachedMeta.logoUrl !== logoUrl || !fs.existsSync(cacheFile);

    if (cacheIsStale) {
      const res = await fetch(logoUrl);
      if (!res.ok) throw new Error(`Logo download failed: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = extFromContentType(res.headers.get('content-type'));
      cacheFile = brandingCacheFile(ext);
      // Clean up a stale cache file left over from a previous logo with a
      // different image type, so the branding folder doesn't accumulate.
      if (cachedMeta?.ext && cachedMeta.ext !== ext) {
        await fs.promises.unlink(brandingCacheFile(cachedMeta.ext)).catch(() => {});
      }
      await fs.promises.writeFile(cacheFile, buffer);
      await fs.promises.writeFile(brandingCacheMeta(), JSON.stringify({ logoUrl, ext }));
      cachedMeta = { logoUrl, ext };
    }

    const buffer = await fs.promises.readFile(cacheFile);
    const mime = cachedMeta.ext === 'jpg' ? 'image/jpeg' : `image/${cachedMeta.ext}`;
    return { logoDataUrl: `data:${mime};base64,${buffer.toString('base64')}`, logoPath: cacheFile };
  } catch (err) {
    log.error('[downloadAndCacheLogo] logo cache/download failed:', err);
    return { logoDataUrl: null, logoPath: null };
  }
}

// API-backed equivalent of the retired local-`db` resolveDocumentBranding, for handlers that no
// longer have a local `db` connection (Appointments/Billing/Services/
// Products/Vendors migrated to the multi-tenant backend). Branch-specific
// address/phone override is gone — branches were dropped entirely when
// Clients/Pets migrated (see pet.service.ts), so every document now shows
// the clinic-wide address/phone/logo/color unconditionally. bankName/
// bankAccountNumber/POS-toggle config are now clinic-wide too (on the
// Saves a base64 data URL (image or PDF) into the local uploads folder and
// returns an http:// URL served by the embedded backend at /uploaded/*.
// Replaces the old Cloudinary upload path so no external API key is needed.
async function saveLocalImage(dataUrl, prefix) {
  const match = String(dataUrl || "").match(/^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!match) throw new Error("Invalid data URL");
  const baseMime = match[1].toLowerCase();
  let ext = baseMime.split("/")[1] || "bin"; if (ext === "jpg") ext = "jpeg"; if (ext === "svg+xml") ext = "svg";
  const dir = process.env.PETVET_UPLOADS_DIR
    || path.join(app.getPath("userData"), "uploads");
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `${prefix}${Date.now()}_${Math.round(Math.random() * 1e6)}.${ext}`;
  await fs.promises.writeFile(path.join(dir, filename), Buffer.from(match[2], "base64"));
  const baseUrl = (process.env.SAAS_API_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
  return `${baseUrl}/uploaded/${filename}`;
}

// Clinic row, via settingsHandlers.js) — the legacy per-machine 'branding'
// store key is only consulted as a last-resort fallback for installs that
// haven't loaded a Clinic record yet (e.g. offline).
async function resolveApiBranding(storeInst, clinicData) {
  const legacy = storeInst.get('branding', {});
  const { logoPath } = await downloadAndCacheLogo(clinicData?.logoUrl);
  const sessionUser = storeInst.get('user');

  return {
    bankName:    clinicData?.bankName ?? legacy.bankName,
    bankAccount: clinicData?.bankAccountNumber ?? legacy.bankAccount,
    pos: clinicData ? {
      showLogo:        clinicData.posShowLogo,
      showPhone:        clinicData.posShowClinicPhone,
      showClientPhone: clinicData.posShowClientPhone,
      showVet:         clinicData.posShowVetName,
      showAddress:     clinicData.posShowAddress,
      showBank:        clinicData.posShowBankDetails,
      headerStyle:     clinicData.posHeaderShowClinicName ? 'clinicName' : 'invoice',
    } : (legacy.pos || {}),
    clinicName: clinicData?.clinicName || sessionUser?.organization_name || legacy.clinicName || 'My Clinic',
    color:      clinicData?.brandColor || legacy.color,
    logoPath:   logoPath || legacy.logoPath || null,
    address:    clinicData?.address || legacy.address || '',
    phone:      clinicData?.phone || legacy.phone || '',
  };
}

// Pulls "HH:MM" out of the API's appointmentTime ISO string — that field is
// a time-of-day value materialized by Prisma as a full DateTime on the
// 1970-01-01 epoch date (a @db.Time column), so it must never be displayed
// or concatenated as-is. Shared by every handler that reads an
// appointment's time off the API (appointments/billing/payments).
function extractHHMM(isoTimeString) {
  if (!isoTimeString) return "";
  const match = String(isoTimeString).match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : "";
}

const formatTime = (timeStr, use12Hour = false) => {
  if (!timeStr) return "";
  const [hourStr, minuteStr] = timeStr.split(":");
  const hour = parseInt(hourStr, 10);
  const minute = (minuteStr || "00").slice(0, 2);
  if (!use12Hour) return `${String(hour).padStart(2, "0")}:${minute}`;
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${minute} ${period}`;
};
// ── Helper: format date as DD-MM-YYYY ────────────────────────────────────────
function formatDate(dateStr) {
  // dateStr is usually YYYY-MM-DD from MySQL CURDATE()
  const [y, m, d] = (dateStr || "").split("-");
  return d && m && y ? `${d}-${m}-${y}` : dateStr;
}

/** YYYY-MM-DD for comparisons (mysql2 may return JS Date or string). */
function toCalendarDateKey(value) {
  if (value == null || value === "") return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    // MySQL DATE columns arrive as UTC midnight — use UTC calendar day to avoid off-by-one
    if (
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0
    ) {
      const y = value.getUTCFullYear();
      const m = String(value.getUTCMonth() + 1).padStart(2, "0");
      const d = String(value.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const dt = new Date(t);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return "";
}

module.exports = {
  resolveApiBranding,
  downloadAndCacheLogo,
  saveLocalImage,
  cloudinary,
  ensureCloudinaryConfigured,
  formatDate,
  formatTime,
  extractHHMM,
  toCalendarDateKey,
};
