// PodVet — standalone web edition. Pure Node/Express, no Electron runtime.
//
//   node index.js            # http://localhost:8080 (set WEB_PORT / PORT)
//
// The exact same React frontend (public/) and handler logic (handlers/*.js) as
// the desktop build. Handlers still call require('electron') for their tiny
// API surface (ipcMain.handle, app.getPath, ...) — but "electron" here is the
// local compat package at compat/electron-compat (npm file: dependency), a
// 100%-pure-Node stand-in that maps those calls onto this server's RPC/SSE
// plumbing. No Chromium process is ever launched.
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');

const WEB_PORT = Number(process.env.WEB_PORT || process.env.PORT || 8080);
const WEB_USER_DATA_DIR = path.resolve(
  process.env.WEB_USER_DATA_DIR ||
  path.join(os.homedir(), '.podvet'),
);
fs.mkdirSync(WEB_USER_DATA_DIR, { recursive: true });

// Same uploaded files the desktop app shows (clinic logo, form pages, pet
// reports) so branding/photo URLs resolve identically. Fall back to our own
// dir when the desktop install has never been run.
const DESKTOP_UPLOADS = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'PodVet (Pro)',
  'uploads',
);
const UPLOADS_DIR = fs.existsSync(DESKTOP_UPLOADS)
  ? DESKTOP_UPLOADS
  : path.join(WEB_USER_DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Let server.js's /uploaded static point at the same dir the desktop exposes.
process.env.PODVET_UPLOADS_DIR = UPLOADS_DIR;

try { require('dotenv').config(); } catch (_) {}

// The electron-compat package (node_modules/electron -> compat/electron-compat).
const electron = require('electron');
const { __web } = electron;
const { rpcChannels, sseClients, sseSend, setDialogFilePath } = __web;

const { app, startServer } = require('./server');

// Point saasClient at ourselves so every /api/* call stays same-origin.
process.env.SAAS_API_BASE_URL = process.env.SAAS_API_BASE_URL_OVERRIDE ||
  `http://localhost:${WEB_PORT}`;

// A tiny electron-store-compatible JSON store (get/set/delete).
class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  }
  get(key, def) {
    const has = Object.prototype.hasOwnProperty.call(this.data, key);
    return has ? this.data[key] : def;
  }
  set(key, value) {
    this.data[key] = value;
    this._flush();
  }
  delete(key) {
    delete this.data[key];
    this._flush();
  }
  _flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
const store = new JsonStore(path.join(WEB_USER_DATA_DIR, 'web-store.json'));

// Rewrite desktop-persisted http://localhost:<port>/... URLs (clinic logo,
// uploaded docs, forms) so the web app is self-contained: they become
// origin-relative paths served by THIS server, regardless of which port the
// desktop originally used (4000 in the API era, 8080 in the web-server era).
{
  const localPort = /^https?:\/\/localhost:\d+\//i;
  function rewriteValue(value) {
    if (typeof value === 'string') return value.replace(localPort, '/');
    if (Array.isArray(value)) {
      if (value.length > 2000 && value.every((v) => typeof v === 'number')) return value;
      for (let i = 0; i < value.length; i++) value[i] = rewriteValue(value[i]);
      return value;
    }
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) value[k] = rewriteValue(value[k]);
      return value;
    }
    return value;
  }
  const expressResponseJson = express.response.json;
  app.response.json = function (body) {
    if (body && typeof body === 'object') body = rewriteValue(body);
    return expressResponseJson.call(this, body);
  };
}

// ── Handlers — same setup list as the desktop's main.js ─────────────────────
const setupAuthHandlers = require('./handlers/authHandlers');
const setupEmployeesHandlers = require('./handlers/employeesHandlers');
const setupClinicUsersHandlers = require('./handlers/clinicUsersHandlers');
const setupFormsHandlers = require('./handlers/formsHandlers');
const setupBranchesHandlers = require('./handlers/branchesHandlers');
const setupSubscriptionHandlers = require('./handlers/subscriptionHandlers');
const setupPaymentSubmissionHandlers = require('./handlers/paymentSubmissionHandlers');
const setupClientsHandlers = require('./handlers/clientsHandlers');
const setupPetsHandlers = require('./handlers/petsHandlers');
const setupServicesHandlers = require('./handlers/servicesHandlers');
const setupClientBillingHandlers = require('./handlers/clientBillingHandlers');
const setupProductsHandlers = require('./handlers/productsHandlers');
const setupVendorsHandlers = require('./handlers/vendorsHandlers');
const setupBillingHandlers = require('./handlers/billingHandlers');
const setupSettingsHandlers = require('./handlers/settingsHandlers');
const setupPaymentsHandlers = require('./handlers/paymentsHandlers');
const setupAppointmentProductsHandlers = require('./handlers/appointmentProductsHandlers');
const setupAppointmentsHandlers = require('./handlers/appointmentsHandlers');
const setupReportsHandlers = require('./handlers/reportsHandlers');
const setupRemindersHandlers = require('./handlers/remindersHandlers');
const setupReminderNotifications = require('./handlers/reminderNotifications');
const setupExpensesHandlers = require('./handlers/expensesHandlers');
const setupRecordHandlers = require('./handlers/recordHandlers');
const setupDataManagementHandlers = require('./handlers/dataManagementHandlers');
const setupBoardingHandlers = require('./handlers/boardingHandlers');
const setupAiProductHandlers = require('./handlers/ai/productHandler');
const setupSoapTextHandlers = require('./handlers/ai/soapTextHandler');

setupAuthHandlers(store);
setupEmployeesHandlers();
setupClinicUsersHandlers();
setupFormsHandlers();
setupBranchesHandlers();
setupSubscriptionHandlers();
setupPaymentSubmissionHandlers();
setupClientsHandlers();
setupPetsHandlers();
setupRecordHandlers();
setupRemindersHandlers();
setupServicesHandlers();
setupProductsHandlers();
setupVendorsHandlers();
setupBillingHandlers(store);
setupAppointmentProductsHandlers();
setupAppointmentsHandlers(store);
setupPaymentsHandlers(store);
setupClientBillingHandlers(store);
setupSettingsHandlers(store);
setupExpensesHandlers(store);
setupReportsHandlers();
setupDataManagementHandlers();
setupBoardingHandlers(store);
setupAiProductHandlers();
setupSoapTextHandlers();

setupReminderNotifications(store, () => __web.createWindowFacade());

rpcChannels.set('restart-app-to-update', async () => ({ success: true }));

// ── Web routes (kept off /api/* so the catch-all in server.js never swallows)
const { generateWebPreload, serializeRpcResult } = require('./lib/web-preload');

app.post('/_rpc/:channel', async (req, res) => {
  const channel = req.params.channel;
  const handler = rpcChannels.get(channel);
  if (!handler) {
    return res.status(404).json({ ok: false, error: { message: `Unknown channel: ${channel}` } });
  }
  if (req.body && req.body.dialogFilePath) {
    setDialogFilePath(req.body.dialogFilePath);
  }
  // Browser-persisted session: Render wipes ~/.podvet on every restart/redeploy,
  // so the store may be empty while the browser is still logged in. Re-inject
  // the tokens from localStorage before the handler runs so authed RPCs work.
  if (req.body && req.body.session && req.body.session.tokens) {
    const { accessToken, refreshToken, user } = req.body.session;
    if (accessToken) {
      store.set('saasTokens', { accessToken, refreshToken, encrypted: false });
    }
    if (user) store.set('user', user);
  }
  let args = (req.body && req.body.args) || [];
  try {
    const result = await handler({}, ...args);
    res.json({ ok: true, result: result === undefined ? null : serializeRpcResult(result) });
  } catch (err) {
    res.json({ ok: false, error: { message: (err && err.message) || String(err) } });
  }
});

// Hands the current tokens back so the browser can cache them in localStorage
// and re-inject them after a server restart wipes the on-disk store.
rpcChannels.set('__get-tokens', async () => {
  const raw = store.get('saasTokens');
  if (!raw) return null;
  if (!raw.encrypted) return raw;
  try {
    return {
      accessToken: Buffer.from(raw.accessToken, 'base64').toString('utf8'),
      refreshToken: Buffer.from(raw.refreshToken, 'base64').toString('utf8'),
    };
  } catch {
    return null;
  }
});

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.post('/web-upload', (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const rawName = (req.headers['x-filename'] || 'upload').replace(/[^\w.\- ]+/g, '');
      const fileName = `${Date.now()}-${rawName}`;
      const filePath = path.join(UPLOADS_DIR, fileName);
      fs.writeFileSync(filePath, Buffer.concat(chunks));
      res.json({ ok: true, path: filePath, fileName });
    } catch (err) {
      res.json({ ok: false, error: { message: err.message } });
    }
  });
});

app.get('/serve-file', (req, res) => {
  const p = String(req.query.path || '');
  const full = path.resolve(p);
  const allowedRoots = [
    path.resolve(WEB_USER_DATA_DIR),
    os.tmpdir(),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    DESKTOP_UPLOADS,
  ];
  const underAllowed = allowedRoots.some((root) => full === root || full.startsWith(root + path.sep));
  if (!underAllowed) {
    return res.status(403).json({ ok: false, error: { message: 'Refused to serve that path' } });
  }
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: { message: 'File not found' } });
  if (req.query.inline === '1' || req.query.inline === 'true') {
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(full);
  }
  res.download(full);
});

// ── Frontend (static dist + generated preload + pickers) ────────────────────
const DIST_DIR = path.join(__dirname, 'public');
const webPreload = generateWebPreload();

const themePickerSource = fs.readFileSync(path.join(__dirname, 'theme-picker.js'), 'utf8');
const colorPickerSource = fs.readFileSync(path.join(__dirname, 'color-picker.js'), 'utf8');
const mobileUxSource = fs.readFileSync(path.join(__dirname, 'mobile-ux.js'), 'utf8');

// One login page for the whole platform: unauthenticated visitors to the
// clinic app are sent to /login (which routes to /app or /super-admin by role).
const AUTH_GUARD = '<script>(function(){try{if(!localStorage.getItem("podvet_session")){location.replace("/login?next="+encodeURIComponent(location.pathname+location.search));}}catch(e){}})();</script>';

function buildWebIndexHtml() {
  const raw = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
  const inject = AUTH_GUARD + '\n    <script src="/web-preload.js"></script>\n    <script src="/color-picker.js" defer></script>\n    <script src="/theme-picker.js" defer></script>\n    <script src="/mobile-ux.js" defer></script>\n  ';
  return raw.replace('<head>', '<head>\n    ' + inject);
}
const webIndexHtml = buildWebIndexHtml();
const landingHtml = fs.readFileSync(path.join(__dirname, 'landing.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');

app.get('/web-preload.js', (req, res) => {
  res.type('application/javascript').send(webPreload.source);
});
app.get('/color-picker.js', (req, res) => {
  res.type('application/javascript').send(colorPickerSource);
});
app.get('/theme-picker.js', (req, res) => {
  res.type('application/javascript').send(themePickerSource);
});
app.get('/mobile-ux.js', (req, res) => {
  res.type('application/javascript').send(mobileUxSource);
});
app.get('/color-picker.html', (req, res) => {
  res.type('text/html').send(fs.readFileSync(path.join(__dirname, 'color-picker.html'), 'utf8'));
});
app.get('/', (req, res) => {
  res.type('text/html').send(landingHtml);
});
app.get('/app', (req, res) => {
  res.type('text/html').send(webIndexHtml);
});

// Single, role-based login page for the whole platform.
app.get('/login', (req, res) => {
  res.type('text/html').send(loginHtml);
});

// ── Platform Super Admin (separate app + separate /api/super-admin namespace) ─
const SUPER_ADMIN_DIR = path.join(__dirname, 'public', 'super-admin');
const superAdminHtml = fs.readFileSync(path.join(SUPER_ADMIN_DIR, 'index.html'), 'utf8');
app.get('/super-admin', (req, res) => {
  res.type('text/html').send(superAdminHtml);
});
app.use('/super-admin', express.static(SUPER_ADMIN_DIR));
app.get('/super-admin/{*splat}', (req, res) => {
  res.type('text/html').send(superAdminHtml);
});

app.use(express.static(DIST_DIR));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/_rpc/')) {
    return res.type('text/html').send(webIndexHtml);
  }
  next();
});

startServer(WEB_PORT).then(() => {
  console.log(`PodVet running at http://localhost:${WEB_PORT}`);
  console.log(`  data dir: ${WEB_USER_DATA_DIR}`);
  console.log(`  login with any account on the embedded backend (e.g. admin / admin123)`);
});