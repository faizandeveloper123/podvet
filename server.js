const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { ensureSuperAdminSchema, bootstrapSuperAdmin, registerSuperAdmin } = require('./lib/superAdmin');

const app = express();
app.set('query parser', 'extended');
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Local upload area for images (form pages, clinic logo) that avoids any
// external cloud dependency â€” the renderer reaches them via /uploaded/*.
let uploadsDir = process.env.PODVET_UPLOADS_DIR;
if (!uploadsDir) {
  try {
    const { app: electronApp } = require('electron');
    uploadsDir = path.join(electronApp.getPath('userData'), 'uploads');
  } catch {
    uploadsDir = path.join(process.env.APPDATA || require('os').homedir(), 'PodVet (Pro)', 'uploads');
  }
}
uploadsDir = path.resolve(uploadsDir);
app.use('/uploaded', express.static(uploadsDir));

// If MySQL isn't reachable yet (startup retry, or env vars missing), return a
// readable 503 instead of crashing the process with `null.query`.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && !_plat) {
    return res.status(503).json({
      error: {
        message: 'Database is not connected yet. Check DB_HOST/DB_USER/DB_PASSWORD and the MySQL server.',
        code: 'DB_NOT_READY',
      },
    });
  }
  next();
});

// DEBUG: log any request that results in a 5xx so the exact failing
// params/body can be inspected in the electron log.
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500) {
      console.error(`[5xx] ${req.method} ${req.originalUrl} params=${JSON.stringify(req.params)} body=${JSON.stringify(req.body)}`);
      console.error(`[5xx] response: ${JSON.stringify(body)}`);
    }
    return origJson(body);
  };
  next();
});

const clinicStore = new AsyncLocalStorage();
let _plat = null;
let _platPromise = null;
const clinicConns = new Map();
// PodVet runs its own databases: the platform DB name (platform DB) and the
// clinic DB prefix can be overridden so a PodVet deployment never touches an
// Existing PodVet install's `podvet` / `clinic_*` databases on a shared MySQL.
const DB_NAME = process.env.DB_NAME || 'podvet';
// setup-server.sh / .env write DB_PREFIX (e.g. podvet_clinic_) and grant the
// DB user privileges on `<DB_PREFIX>%` only. server.js must read the SAME
// variable â€” defaulting to 'clinic_' made clinic creation try `clinic_<id>`,
// which the user has no grant for, so every signup 500'd with access denied.
const CLINIC_PREFIX = process.env.CLINIC_PREFIX || process.env.DB_PREFIX || 'podvet_clinic_';
const DB_OPTS = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  multipleStatements: true,
};

const CLOSED_RE = /closed state|ECONNRESET|EPIPE|socket hang up|Connection lost|PROTOCOL_CONNECTION_LOST|keepalive|handshake timeout/i;

// Platform connection (`podvet`) with lazy connect + auto-reconnect. Hosted
// MySQL (Aiven/Railway/...) closes idle connections; mysql2 doesn't heal a
// dead single connection, so we replace it on the next call.
async function ensurePlat() {
  if (_plat) return _plat;
  if (_platPromise) return _platPromise;
  _platPromise = (async () => {
    const conn = await mysql.createConnection({ ...DB_OPTS, database: DB_NAME });
    _plat = conn;
    try { await ensurePlatformSchema(); } catch (e) { console.error('ensurePlatformSchema failed:', e.message); }
    console.log('Connected to MySQL');
    return conn;
  })().finally(() => { _platPromise = null; });
  return _platPromise;
}

async function openClinicConn(clinicId) {
  const conn = await mysql.createConnection({ ...DB_OPTS, database: `${CLINIC_PREFIX}${clinicId}` });
  conn.on('error', () => {});
  return conn;
}

// Wrap a raw connection so a closed/stale one is transparently replaced and
// the call retried once (hosted MySQL drops idle connections).
function healConn(holder, open) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return async (...args) => {
        let conn = holder.c;
        if (!conn) { conn = await open(); holder.c = conn; }
        try { return await conn[prop](...args); }
        catch (e) {
          if (!CLOSED_RE.test(String((e && e.message) || e))) throw e;
          try { conn.destroy && conn.destroy(); } catch (_) {}
          conn = await open(); holder.c = conn;
          return await conn[prop](...args);
        }
      };
    },
  });
}

const platConn = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined; // not a thenable
    return async (...args) => {
      const conn = _plat || await ensurePlat();
      try { return await conn[prop](...args); }
      catch (e) {
        if (!CLOSED_RE.test(String((e && e.message) || e))) throw e;
        _plat = null;
        const fresh = await ensurePlat();
        return await fresh[prop](...args);
      }
    };
  },
});

function getClinicConn(clinicId) {
  clinicId = Number(clinicId) || 1;
  if (clinicId === 1) return Promise.resolve(platConn);
  let entry = clinicConns.get(clinicId);
  if (!entry) {
    entry = { c: null, proxy: null };
    entry.proxy = healConn(entry, () => openClinicConn(clinicId));
    clinicConns.set(clinicId, entry);
  }
  return Promise.resolve(entry.proxy);
}

// `db` routes every query to the current request's clinic database (from the
// JWT set by authMiddleware). Whole-account tables (users / clinics) always
// run against the platform DB (`podvet`) explicitly via platConn.
const db = new Proxy({}, {
  get(_t, prop) {
    return (...args) => {
      const clinicId = clinicStore.getStore();
      return (clinicId ? getClinicConn(clinicId) : Promise.resolve(platConn)).then(c => c[prop](...args));
    };
  },
});

async function ensurePlatformSchema() {
  await platConn.query(`CREATE TABLE IF NOT EXISTS clinics (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    clinic_name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [cols] = await platConn.query(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME='users' AND COLUMN_NAME='clinic_id'`);
  if (!cols[0].n) await platConn.query('ALTER TABLE users ADD COLUMN clinic_id INT DEFAULT 1');
  const [cc] = await platConn.query('SELECT COUNT(*) AS n FROM clinics WHERE id=1');
  if (!cc[0].n) await platConn.query('INSERT INTO clinics (id, clinic_name, slug) VALUES (1, "PodVet Clinic", "podvet")');
  await platConn.query('UPDATE users SET clinic_id=1 WHERE clinic_id IS NULL');
  // Platform (Super Admin) tables live in the same DB but are a separate trust
  // boundary â€” own credentials, roles, plans, audit trail. Must run before the
  // clinics UPDATE below, which uses columns this call adds.
  await ensureSuperAdminSchema(platConn, DB_NAME);
  await platConn.query("UPDATE clinics SET status='active', plan='pro', subscription_start=COALESCE(subscription_start, CURDATE()), registration_date=COALESCE(registration_date, DATE(created_at)) WHERE id=1");
  await bootstrapSuperAdmin(platConn, bcrypt);
}

async function createClinicDatabase(clinicId, clinicName) {
  const admin = await mysql.createConnection({ ...DB_OPTS });
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${CLINIC_PREFIX}${clinicId}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE \`${CLINIC_PREFIX}${clinicId}\``);
    await admin.query('SET FOREIGN_KEY_CHECKS=0');
    const [tables] = await platConn.query('SHOW TABLES');
    // Platform-only tables must never be cloned into a clinic database â€”
    // they hold platform credentials and the token-signing secret.
    const PLATFORM_TABLES = new Set([
      'users', 'clinics', 'platform_admins', 'roles', 'role_permissions',
      'audit_logs', 'plans', 'platform_settings',
    ]);
    for (const t of tables) {
      const name = Object.values(t)[0];
      if (PLATFORM_TABLES.has(name)) continue;
      const [[def]] = await platConn.query(`SHOW CREATE TABLE \`${name}\``);
      await admin.query(def['Create Table']);
    }
    await admin.query('SET FOREIGN_KEY_CHECKS=1');
    await admin.query('INSERT INTO clinic_settings (id, clinic_name, brand_color) VALUES (1, ?, "#92CAED")', [clinicName]);
    await admin.query('INSERT INTO branches (branch_name, is_active) VALUES ("Main Branch", 1)');
  } finally { await admin.end(); }
}

async function connectDB() {
  await ensurePlat();
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    const parts = auth.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    req.userId = payload.sub || payload.userId || 1;
    req.clinicId = payload.clinicId || 1;
    clinicStore.run(Number(req.clinicId), () => next());
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function makeToken(userId, clinicId) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: userId, clinicId: Number(clinicId) || 1, iat: Date.now(), exp: Date.now() + 86400000 })).toString('base64url');
  const sig = Buffer.from('dummy').toString('base64url');
  return `${header}.${payload}.${sig}`;
}

async function okClinicSession(u, clinicId) {
  const cid = Number(clinicId) || Number(u.clinic_id) || 1;
  let clinicName = 'PodVet Clinic';
  try {
    const conn = await getClinicConn(cid);
    const [rows] = await conn.query('SELECT clinic_name FROM clinic_settings WHERE id=1');
    if (rows.length && rows[0].clinic_name) clinicName = rows[0].clinic_name;
  } catch (_) {}
  return {
    user: { id: u.id, name: u.name, username: u.username, email: u.email, isPlatformAdmin: u.role === 'OWNER' },
    activeClinic: { clinicId: cid, clinicName, slug: 'podvet', role: u.role || 'OWNER', branchId: null, accessBlocked: null },
  };
}

const P = (v) => parseInt(v) || 0;

// MySQL returns snake_case; the Electron handlers expect camelCase.
function toCamel(row) {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map(toCamel);
  if (typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (v instanceof Date) {
      // DATE columns must keep their calendar day â€” toISOString() shifts
      // them into UTC and the frontend displays the wrong day.
      out[ck] = /_date$|_on$/.test(k)
        ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
        : v.toISOString();
    } else {
      out[ck] = v;
    }
  }
  return out;
}

function paginate(rows, total, page, pageSize) {
  return { data: toCamel(rows), total, page: Number(page), totalPages: Math.ceil((total || 0) / pageSize) };
}

const EMPTY = { data: [], total: 0, page: 1, totalPages: 0 };

// â”€â”€â”€ UNPAID BALANCES (appointments / walk-in billing / quick bills) â”€â”€â”€â”€â”€â”€â”€â”€â”€
// All three "Outstanding Balances" panels + the client ledger share one shape:
// billing rows with a balance remaining (final_total > amount_paid).
const KINDS = {
  appt:      { sql: 'b.appointment_id IS NOT NULL',                        label: 'appt' },
  walkin:    { sql: 'b.appointment_id IS NULL AND (b.invoice_no IS NULL OR b.invoice_no NOT LIKE \'QB-%\')', label: 'walkin' },
  quickbill: { sql: 'b.invoice_no LIKE \'QB-%\'',                           label: 'quickbill' },
};
function isoLike(date, time) {
  const d = date instanceof Date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    : String(date || '').slice(0, 10);
  return `${d}T${String(time || '00:00').slice(0, 5)}:00`;
}
async function unpaidAppointmentRows(clientId) {
  const [rows] = await db.query(`SELECT b.id, b.appointment_id, b.subtotal, b.discount, b.final_total, b.amount_paid, b.status, a.appointment_date, a.appointment_time, COALESCE(p.pet_name, b.pet_name) AS pet_name
    FROM billing b LEFT JOIN appointments a ON a.id = b.appointment_id LEFT JOIN pets p ON p.id = a.pet_id
    WHERE b.client_id = ? AND ${KINDS.appt.sql} AND b.final_total > b.amount_paid
    ORDER BY a.appointment_date DESC, a.appointment_time DESC`, [clientId]);
  const out = [];
  for (const r of rows) {
    const [svc] = await db.query('SELECT COALESCE(SUM(rate*quantity),0) AS fee FROM appointment_services WHERE appointment_id=?', [r.appointment_id]);
    const [bi] = await db.query('SELECT COALESCE(SUM(total),0) AS t FROM billing_items WHERE billing_id=?', [r.id]);
    const appointmentFee = Number(svc[0].fee) || 0;
    const productsTotal = Number(bi[0].t) || 0;
    const discountAmount = Number(r.discount) || 0;
    const amount = Math.max(0, (Number(r.subtotal) || 0) - discountAmount);
    const alreadyPaid = Number(r.amount_paid) || 0;
    const remaining = Math.max(0, amount - alreadyPaid);
    if (remaining <= 0) continue;
    const iso = isoLike(r.appointment_date, r.appointment_time);
    out.push({ appointmentId: r.appointment_id, date: iso, time: iso, petName: r.pet_name || '', billingStatus: r.status, appointmentFee, productsTotal, discountAmount, grossTotal: Number(r.subtotal) || 0, amount, alreadyPaid, remaining });
  }
  return out;
}
async function unpaidWalkinRows(clientId) {
  const [rows] = await db.query(`SELECT b.id AS billingId, DATE(b.created_at) AS date, b.final_total AS finalAmount, b.amount_paid AS paid, (b.final_total - b.amount_paid) AS remaining
    FROM billing b WHERE b.client_id = ? AND ${KINDS.walkin.sql} AND b.final_total > b.amount_paid ORDER BY b.id DESC`, [clientId]);
  const out = [];
  for (const r of rows) {
    const [bi] = await db.query('SELECT name,quantity,total FROM billing_items WHERE billing_id=?', [r.billingId]);
    out.push({ billingId: r.billingId, date: isoLike(r.date, null), finalAmount: Number(r.finalAmount), paid: Number(r.paid), remaining: Number(r.remaining), items: bi });
  }
  return out;
}
async function unpaidQuickBillRows(clientId) {
  const [rows] = await db.query(`SELECT b.id, b.invoice_no, DATE(b.created_at) AS date, b.final_total AS total, b.amount_paid AS paid, (b.final_total - b.amount_paid) AS remaining
    FROM billing b WHERE b.client_id = ? AND ${KINDS.quickbill.sql} AND b.final_total > b.amount_paid ORDER BY b.id DESC`, [clientId]);
  const out = [];
  for (const r of rows) {
    const [bi] = await db.query('SELECT name,quantity,total FROM billing_items WHERE billing_id=?', [r.id]);
    out.push({ customInvoiceId: r.id, invoiceNo: r.invoice_no || ('QB-' + r.id), date: isoLike(r.date, null), total: Number(r.total), paid: Number(r.paid), remaining: Number(r.remaining), items: bi });
  }
  return out;
}
async function unpaidClientIds(kind, search) {
  const extra = KINDS[kind].sql;
  let where = `b.${'final_total'} > b.${'amount_paid'}`, params = [];
  if (search) { where += ' AND (c.client_name LIKE ? OR c.contact_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const [rows] = await db.query(`SELECT DISTINCT c.id, c.client_name, c.contact_number, c.address FROM billing b JOIN clients c ON c.id = b.client_id WHERE ${where} AND ${extra} ORDER BY c.client_name`, params);
  return rows;
}
async function unpaidClientSummary(kind, { search = '', page = 1, pageSize = 10 }) {
  const pg = P(page) || 1, sz = P(pageSize) || 10;
  const all = await unpaidClientIds(kind, search);
  const total = all.length;
  const slice = all.slice((pg - 1) * sz, pg * sz);
  const data = [];
  for (const c of slice) {
    const rows = kind === 'appt' ? await unpaidAppointmentRows(c.id) : (kind === 'walkin' ? await unpaidWalkinRows(c.id) : await unpaidQuickBillRows(c.id));
    data.push({ clientId: c.id, clientName: c.client_name, contactNumber: c.contact_number, address: c.address, unpaidCount: rows.length, totalDue: rows.reduce((s, r) => s + Number(r.remaining || 0), 0), appointments: rows });
  }
  return { data, total, page: pg, totalPages: Math.ceil(total / sz) };
}

// â”€â”€â”€ AUTH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const [rows] = await platConn.query('SELECT * FROM users WHERE username = ? OR email = ?', [identifier, identifier]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const u = rows[0];
    const valid = await bcrypt.compare(password, u.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const clinicId = u.clinic_id || 1;
    const [cl] = await platConn.query('SELECT status FROM clinics WHERE id = ?', [clinicId]);
    const status = cl.length ? cl[0].status : 'active';
    if (status === 'suspended' || status === 'disabled') {
      return res.status(403).json({ error: `This clinic is ${status}. Please contact platform support.` });
    }
    const token = makeToken(u.id, clinicId);
    res.json({ accessToken: token, refreshToken: token, ...(await okClinicSession(u, clinicId)) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.post('/api/clinics', async (req, res) => {
  try {
    const owner = req.body.owner || req.body;
    const clinicName = req.body.clinicName || req.body.clinic_name || owner.clinicName || 'PodVet Clinic';
    const name = owner.name || 'Owner';
    const username = owner.username || 'owner';
    const email = owner.email || 'owner@podvet.local';
    const password = owner.password || 'password123';
    const hash = await bcrypt.hash(password, 10);
    const [reg] = await platConn.query('INSERT INTO clinics (clinic_name, slug) VALUES (?, ?)', [clinicName, 'podvet']);
    const clinicId = reg.insertId;
    await createClinicDatabase(clinicId, clinicName);
    const [r] = await platConn.query('INSERT INTO users (name, username, email, password, role, phone_number, clinic_id) VALUES (?, ?, ?, ?, "OWNER", ?, ?)',
      [name, username, email, hash, owner.phoneNumber || owner.phone_number || null, clinicId]);
    const token = makeToken(r.insertId, clinicId);
    res.json({
      accessToken: token, refreshToken: token,
      user: { id: r.insertId, name, username, email, isPlatformAdmin: false },
      activeClinic: { clinicId, clinicName, slug: 'podvet', role: 'OWNER', branchId: null, accessBlocked: null },
    });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const [rows] = await platConn.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    res.json(await okClinicSession(rows[0], req.clinicId));
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.patch('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { name, username } = req.body;
    await platConn.query('UPDATE users SET name=?, username=? WHERE id=?', [name, username, req.userId]);
    const [rows] = await platConn.query('SELECT * FROM users WHERE id=?', [req.userId]);
    res.json(await okClinicSession(rows[0], req.clinicId));
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.post('/api/auth/switch-clinic', authMiddleware, async (req, res) => {
  let clinicName = 'PodVet Clinic';
  try {
    const conn = await getClinicConn(req.clinicId);
    const [rows] = await conn.query('SELECT clinic_name FROM clinic_settings WHERE id=1');
    if (rows.length && rows[0].clinic_name) clinicName = rows[0].clinic_name;
  } catch (_) {}
  res.json({ accessToken: makeToken(req.userId, req.clinicId), refreshToken: makeToken(req.userId, req.clinicId), user: { id: req.userId, name: 'User' }, activeClinic: { clinicId: req.clinicId, clinicName, slug: 'podvet', role: 'OWNER', branchId: null } });
});

app.post('/api/auth/logout', (req, res) => res.json({ success: true }));
app.post('/api/auth/forgot-password', (req, res) => res.json({ success: true, message: 'Reset email sent' }));
app.post('/api/auth/reset-password', (req, res) => res.json({ success: true }));
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const [rows] = await platConn.query('SELECT password FROM users WHERE id=?', [req.userId]);
    if (rows.length && await bcrypt.compare(currentPassword, rows[0].password)) {
      await platConn.query('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(newPassword, 10), req.userId]);
    }
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const parts = refreshToken.split('.');
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const token = makeToken(p.sub, p.clinicId || 1);
    const [rows] = await platConn.query('SELECT * FROM users WHERE id=?', [p.sub]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid' });
    res.json({ accessToken: token, refreshToken: token, ...(await okClinicSession(rows[0], p.clinicId)) });
  } catch { res.status(401).json({ error: 'Invalid refresh token' }); }
});

// â”€â”€â”€ CLINIC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function settingsRow() {
  return db.query('SELECT * FROM clinic_settings WHERE id=1');
}
function clinicDTO(row) {
  const s = toCamel(row || {});
  return {
    id: 1, clinicName: s.clinicName || 'PodVet Clinic', slug: 'podvet',
    logoUrl: s.logoUrl || null, brandColor: s.brandColor || '#92CAED',
    firstTimeFee: 1050, discountRange: 50, discountMinPercent: 1, discountMaxPercent: 7,
    use12HourTime: false, address: s.address || '', phone: s.phone || '',
    groupProductsOnInvoice: !!s.groupProductsOnInvoice, bankName: s.bankName || '',
    bankAccountNumber: s.bankAccountNumber || '',
    posShowLogo: s.posShowLogo, posShowClinicPhone: s.posShowClinicPhone, posShowClientPhone: s.posShowClientPhone,
    posShowVetName: s.posShowVetName, posShowAddress: s.posShowAddress, posShowBankDetails: s.posShowBankDetails,
    posHeaderShowClinicName: s.posHeaderShowClinicName,
  };
}
app.get('/api/clinics/me', authMiddleware, async (req, res) => {
  try { const [rows] = await settingsRow(); res.json({ clinic: clinicDTO(rows[0]) }); }
  catch { res.json({ clinic: clinicDTO(null) }); }
});
app.patch('/api/clinics/me', authMiddleware, async (req, res) => {
  try {
    const d = req.body, F = [], V = [];
    const sets = {
      clinicName: 'clinic_name', brandColor: 'brand_color', logoUrl: 'logo_url', address: 'address',
      phone: 'phone', groupProductsOnInvoice: 'group_products_on_invoice', bankName: 'bank_name',
      bankAccountNumber: 'bank_account_number', posShowLogo: 'pos_show_logo', posShowClinicPhone: 'pos_show_clinic_phone',
      posShowClientPhone: 'pos_show_client_phone', posShowVetName: 'pos_show_vet_name', posShowAddress: 'pos_show_address',
      posShowBankDetails: 'pos_show_bank_details', posHeaderShowClinicName: 'pos_header_show_clinic_name',
    };
    for (const [k, col] of Object.entries(sets)) {
      if (d[k] !== undefined) { F.push(`${col}=?`); V.push(typeof d[k] === 'boolean' ? (d[k] ? 1 : 0) : d[k]); }
    }
    await db.query('INSERT IGNORE INTO clinic_settings (id) VALUES (1)');
    if (F.length) await db.query(`UPDATE clinic_settings SET ${F.join(',')} WHERE id=1`, V);
    const [rows] = await settingsRow();
    res.json({ success: true, clinic: clinicDTO(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/clinics/me/branding', authMiddleware, async (req, res) => {
  try { const [rows] = await settingsRow(); const s = toCamel(rows[0] || {});
    res.json({ clinicName: s.clinicName || 'PodVet Clinic', logoUrl: s.logoUrl || null, brandColor: s.brandColor || '#92CAED' });
  } catch { res.json({ clinicName: 'PodVet Clinic', logoUrl: null, brandColor: '#92CAED' }); }
});
app.get('/api/public/branding', async (req, res) => {
  try { const [rows] = await settingsRow(); const s = toCamel(rows[0] || {});
    res.json({ clinicName: s.clinicName || 'PodVet Clinic', logoUrl: s.logoUrl || null, brandColor: s.brandColor || '#92CAED' });
  } catch { res.json({ clinicName: 'PodVet Clinic', logoUrl: null, brandColor: '#92CAED' }); }
});

// â”€â”€â”€ PLANS / SUBSCRIPTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// NOTE: the frontend's PlanSelectScreen reads result.data.plan (array) and each
// plan needs priceMonthly / trialDays / features to render. Server returns
// { data: [...] } so subscriptionHandlers' `result.data` is the plans array.
app.get('/api/plans', authMiddleware, (req, res) => res.json({ data: [
  {
    id: 1,
    name: 'Free',
    priceMonthly: 0,
    priceYearly: 0,
    trialDays: 30,
    features: [
      'Unlimited clients and pets',
      'Appointments & billing',
      'Products & inventory',
      'Reports and analytics',
    ],
  },
] }));
app.post('/api/clinics/me/subscription', authMiddleware, (req, res) => res.json({ success: true }));

// â”€â”€â”€ BRANCHES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/branches', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM branches ORDER BY branch_name'); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/branches', authMiddleware, async (req, res) => {
  try {
    const { branchName, branch_name } = req.body;
    const [r] = await db.query('INSERT INTO branches (branch_name) VALUES (?)', [branchName || branch_name]);
    res.json({ data: { id: r.insertId, branchName: branchName || branch_name, isActive: true } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/branches/:id', authMiddleware, async (req, res) => {
  try {
    const { branchName, branch_name, isActive, is_active } = req.body;
    const bn = branchName || branch_name; const ia = isActive !== undefined ? isActive : (is_active !== undefined ? is_active : 1);
    await db.query('UPDATE branches SET branch_name=?, is_active=? WHERE id=?', [bn, ia ? 1 : 0, req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.patch('/api/branches/:id/contact-info', authMiddleware, (req, res) => res.json({ success: true }));
app.delete('/api/branches/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM branches WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ EMPLOYEES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/employees', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const sz = P(pageSize), offset = (P(page) - 1) * sz;
    let where = '', params = [];
    if (search) { where = 'WHERE name LIKE ? OR position LIKE ?'; params = [`%${search}%`, `%${search}%`]; }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM employees ${where}`, params);
    const [rows] = await db.query(`SELECT * FROM employees ${where} ORDER BY name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows, count[0].cnt, page, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/employees', authMiddleware, async (req, res) => {
  try {
    const { name, position, designation, salary, contact, joinedOn, joined_on } = req.body;
    const [r] = await db.query('INSERT INTO employees (name,position,designation,salary,contact,joined_on) VALUES (?,?,?,?,?,?)',
      [name, position||'', designation||'', salary||0, contact||'', joinedOn||joined_on||null]);
    res.json({ data: { id: r.insertId, name } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/employees/:id', authMiddleware, async (req, res) => {
  try {
    const { name, position, designation, salary, contact, joinedOn, joined_on } = req.body;
    await db.query('UPDATE employees SET name=?,position=?,designation=?,salary=?,contact=?,joined_on=? WHERE id=?',
      [name, position||'', designation||'', salary||0, contact||'', joinedOn||joined_on||null, req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.delete('/api/employees/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM employees WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ USERS (clinic staff) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const sz = P(pageSize), offset = (P(page) - 1) * sz;
    let where = 'WHERE clinic_id=?', params = [req.clinicId];
    if (search) { where += ' AND (name LIKE ? OR email LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    const [count] = await platConn.query(`SELECT COUNT(*) as cnt FROM users ${where}`, params);
    const [rows] = await platConn.query(`SELECT id,name,username,email,role FROM users ${where} ORDER BY name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows, count[0].cnt, page, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/users', authMiddleware, async (req, res) => {
  try {
    const { name, username, email, password, role } = req.body;
    const hash = await bcrypt.hash(password || 'password123', 10);
    const [r] = await platConn.query('INSERT INTO users (name,username,email,password,role,clinic_id) VALUES (?,?,?,?,?,?)',
      [name, username||email, email, hash, role||'USER', req.clinicId]);
    res.json({ data: { id: r.insertId, name } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/users/:id', authMiddleware, async (req, res) => {
  try { const { name, email, role } = req.body; await platConn.query("UPDATE users SET name=?,email=?,role=? WHERE id=? AND clinic_id=?", [name, email, role||'USER', req.params.id, req.clinicId]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/users/:id', authMiddleware, async (req, res) => {
  try { await platConn.query('DELETE FROM users WHERE id=? AND clinic_id=?', [req.params.id, req.clinicId]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ INVITATIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/invitations', authMiddleware, (req, res) => res.json(EMPTY));
app.post('/api/invitations', authMiddleware, (req, res) => res.json({ success: true }));
app.delete('/api/invitations/:id', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/invitations/:id/resend', authMiddleware, (req, res) => res.json({ success: true }));

// â”€â”€â”€ CLIENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/clients', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, limit = 20, search = '' } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 20, offset = (pg - 1) * sz;
    let where = '', params = [];
    if (search) { where = 'WHERE c.client_name LIKE ? OR c.contact_number LIKE ?'; params = [`%${search}%`, `%${search}%`]; }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM clients c ${where}`, params);
    const [rows] = await db.query(`SELECT c.* FROM clients c ${where} ORDER BY c.client_name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    const data = [];
    for (const c of rows) {
      const [pets] = await db.query('SELECT * FROM pets WHERE client_id=?', [c.id]);
      data.push({ ...toCamel(c), pets: toCamel(pets) });
    }
    res.json({ data, total: count[0].cnt, page: pg, totalPages: Math.ceil(count[0].cnt / sz) });
  } catch { res.json(EMPTY); }
});
app.get('/api/clients/unpaid-summary', authMiddleware, async (req, res) => {
  try { res.json(await unpaidClientSummary('appt', req.query)); } catch { res.json(EMPTY); }
});
app.post('/api/clients', authMiddleware, async (req, res) => {
  try {
    const { clientName, contactNumber, address } = req.body;
    const [r] = await db.query('INSERT INTO clients (client_name,contact_number,address) VALUES (?,?,?)', [clientName, contactNumber||'', address||'']);
    res.json({ data: { id: r.insertId, clientName } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/clients/with-pet', authMiddleware, async (req, res) => {
  try {
    const { client, pet } = req.body;
    const [cr] = await db.query('INSERT INTO clients (client_name,contact_number,address) VALUES (?,?,?)',
      [client.clientName, client.contactNumber||'', client.address||'']);
    let petRow = null;
    if (pet) {
      const [pr] = await db.query('INSERT INTO pets (client_id,pet_name,sex,species,breed,color,date_of_birth,is_neutered,is_microchipped) VALUES (?,?,?,?,?,?,?,?,?)',
        [cr.insertId, pet.petName||'', pet.sex||'Unknown', pet.species||'Dog', pet.breed||'', pet.color||'', pet.dateOfBirth||null, pet.isNeutered?1:0, pet.isMicrochipped?1:0]);
      petRow = { id: pr.insertId, ...pet };
    }
    res.json({ data: { client: { id: cr.insertId, clientName: client.clientName }, pet: petRow } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/clients/:id', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM clients WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    const [pets] = await db.query('SELECT * FROM pets WHERE client_id=?', [req.params.id]);
    res.json({ data: { ...toCamel(rows[0]), pets: toCamel(pets) } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/clients/:id', authMiddleware, async (req, res) => {
  try { const { clientName, contactNumber, address } = req.body; await db.query('UPDATE clients SET client_name=?,contact_number=?,address=? WHERE id=?', [clientName, contactNumber||'', address||'', req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/clients/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM pets WHERE client_id=?', [req.params.id]); await db.query('DELETE FROM clients WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.get('/api/clients/:id/pets', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM pets WHERE client_id=?', [req.params.id]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/clients/:id/pets', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [r] = await db.query('INSERT INTO pets (client_id,pet_name,sex,species,breed,color,date_of_birth,age,is_neutered,is_microchipped) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [req.params.id, d.petName||'', d.sex||'Unknown', d.species||'Dog', d.breed||'', d.color||'', d.dateOfBirth||null, d.age||'', d.isNeutered?1:0, d.isMicrochipped?1:0]);
    res.json({ data: { id: r.insertId } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/clients/:id/unpaid-ledger', authMiddleware, async (req, res) => {
  try {
    const [c] = await db.query('SELECT id, client_name, contact_number, address FROM clients WHERE id=?', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: { message: 'Not found' } });
    const appointments = await unpaidAppointmentRows(req.params.id);
    res.json({ data: { clientId: c[0].id, clientName: c[0].client_name, contactNumber: c[0].contact_number, address: c[0].address, totalDue: appointments.reduce((s, a) => s + a.remaining, 0), appointments } });
  } catch { res.json({ data: [] }); }
});
app.post('/api/clients/:id/pay-all', authMiddleware, async (req, res) => {
  try {
    const kindSql = KINDS.appt.sql;
    const [t] = await db.query(`SELECT COALESCE(SUM(final_total - amount_paid),0) AS due FROM billing WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    const [r] = await db.query(`UPDATE billing SET amount_paid = final_total, status = 'PAID' WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    res.json({ data: { appointmentCount: r.affectedRows, totalPaid: Number(t[0].due) || 0 } });
  } catch { res.json({ success: false }); }
});

// â”€â”€â”€ PETS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, limit = 20, search = '', clientId } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 20, offset = (pg - 1) * sz;
    let where = '1=1', params = [];
    if (search) { where += ' AND (p.pet_name LIKE ? OR c.client_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (clientId) { where += ' AND p.client_id=?'; params.push(clientId); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM pets p JOIN clients c ON p.client_id=c.id WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT p.*, c.client_name, c.contact_number FROM pets p JOIN clients c ON p.client_id=c.id WHERE ${where} ORDER BY p.pet_name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.get('/api/pets/species', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT DISTINCT species FROM pets WHERE species IS NOT NULL ORDER BY species'); res.json({ data: rows.map(r => r.species) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/pets/upcoming-birthdays', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT p.*, c.client_name, c.contact_number FROM pets p JOIN clients c ON p.client_id=c.id WHERE MONTH(p.date_of_birth) = MONTH(CURDATE()) AND DAY(p.date_of_birth) >= DAY(CURDATE()) ORDER BY DAY(p.date_of_birth)`);
    res.json({ data: toCamel(rows) });
  } catch { res.json({ data: [] }); }
});
app.get('/api/pets/:id', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT p.*, c.client_name, c.contact_number FROM pets p JOIN clients c ON p.client_id=c.id WHERE p.id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/pets', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [r] = await db.query('INSERT INTO pets (client_id,pet_name,sex,species,breed,color,date_of_birth,age,is_neutered,is_microchipped) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [d.clientId||d.client_id, d.petName||d.pet_name, d.sex||'Unknown', d.species||'Dog', d.breed||'', d.color||'', d.dateOfBirth||d.date_of_birth||null, d.age||'', d.isNeutered?1:0, d.isMicrochipped?1:0]);
    res.json({ data: { id: r.insertId } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/pets/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    await db.query('UPDATE pets SET client_id=?,pet_name=?,sex=?,species=?,breed=?,color=?,date_of_birth=?,age=?,is_neutered=?,is_microchipped=?,deceased=? WHERE id=?',
      [d.clientId||d.client_id, d.petName||d.pet_name, d.sex||'Unknown', d.species||'Dog', d.breed||'', d.color||'', d.dateOfBirth||d.date_of_birth||null, d.age||'', d.isNeutered?1:0, d.isMicrochipped?1:0, d.deceased?1:0, req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.delete('/api/pets/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM pets WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ SERVICES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/services', authMiddleware, async (req, res) => {
  try {
    const { category, excludeCategory } = req.query;
    let q = 'SELECT * FROM services', params = [], conds = [];
    if (category) { conds.push('category=?'); params.push(category); }
    if (excludeCategory) { conds.push('category!=?'); params.push(excludeCategory); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY category, name';
    const [rows] = await db.query(q, params);
    res.json({ data: toCamel(rows) });
  } catch { res.json({ data: [] }); }
});
app.post('/api/services', authMiddleware, async (req, res) => {
  try {
    const { name, category, baseRate, purchasePrice, isGrooming } = req.body;
    const [r] = await db.query('INSERT INTO services (name,category,base_rate,purchase_price,is_grooming) VALUES (?,?,?,?,?)',
      [name, category||'General', baseRate||0, purchasePrice||0, isGrooming?1:0]);
    res.json({ data: { id: r.insertId, name } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/services/:id', authMiddleware, async (req, res) => {
  try {
    const { name, category, baseRate, purchasePrice, isGrooming } = req.body;
    await db.query('UPDATE services SET name=?,category=?,base_rate=?,purchase_price=?,is_grooming=? WHERE id=?',
      [name, category||'General', baseRate||0, purchasePrice||0, isGrooming?1:0, req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.delete('/api/services/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM services WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ PRODUCTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/products', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, limit = 20, search = '' } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 20, offset = (pg - 1) * sz;
    let where = '', params = [];
    if (search) { where = 'WHERE p.name LIKE ? OR p.barcode_number LIKE ?'; params = [`%${search}%`, `%${search}%`]; }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM products p ${where}`, params);
    const [rows] = await db.query(
      `SELECT p.*, v.vendor_name as vendorName
       FROM products p LEFT JOIN vendors v ON v.id = p.vendor_id
       ${where} ORDER BY p.name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.get('/api/products/search', authMiddleware, async (req, res) => {
  try { const { term = '', q = '' } = req.query; const s = term || q;
    const [rows] = await db.query('SELECT * FROM products WHERE quantity > 0 AND name LIKE ? ORDER BY name LIMIT 10', [`%${s}%`]);
    res.json({ data: toCamel(rows) });
  } catch { res.json({ data: [] }); }
});
app.get('/api/products/search-by-category', authMiddleware, async (req, res) => {
  try { const { term = '', category = '' } = req.query;
    let q = 'SELECT * FROM products WHERE quantity > 0', params = [];
    if (term) { q += ' AND name LIKE ?'; params.push(`%${term}%`); }
    if (category) { q += ' AND category=?'; params.push(category); }
    const [rows] = await db.query(q + ' ORDER BY name LIMIT 10', params);
    res.json({ data: toCamel(rows) });
  } catch { res.json({ data: [] }); }
});
app.get('/api/products/find', authMiddleware, async (req, res) => {
  try { const { term = '' } = req.query;
    const [rows] = await db.query('SELECT * FROM products WHERE name LIKE ? OR barcode_number=? ORDER BY name LIMIT 10', [`%${term}%`, term]);
    res.json({ data: rows.length ? toCamel(rows[0]) : null });
  } catch { res.json({ data: null }); }
});
app.get('/api/products/transactions', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, search } = req.query;
    const pg = P(page) || 1, sz = P(pageSize) || 10;
    let where = 'bi.product_id IS NOT NULL', params = [];
    if (search) {
      where += ' AND (b.customer_name LIKE ? OR b.customer_phone LIKE ? OR b.pet_name LIKE ? OR p.name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const [count] = await db.query(
      `SELECT COUNT(*) cnt FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT bi.id as itemId, bi.billing_id as billingId, bi.product_id as productId,
              COALESCE(bi.name, p.name, '') as productName, bi.quantity, bi.price, bi.total,
              b.created_at as billingDate, b.customer_name as customerName, b.customer_phone as customerPhone,
              b.pet_name as petName, b.invoice_no as invoiceNo
       FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id
       WHERE ${where} ORDER BY bi.id DESC LIMIT ? OFFSET ?`,
      [...params, sz, (pg - 1) * sz]);
    const items = rows.map((r) => {
      const dt = r.billingDate ? new Date(r.billingDate) : null;
      return {
        ...r,
        billingDate: dt ? dt.toISOString().slice(0, 10) : null,
        billingTime: dt ? dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null,
        linkedAppointmentCount: 0,
      };
    });
    res.json(paginate(items, count[0].cnt, pg, sz));
  } catch (e) { console.error('[products/transactions]', e.message); res.json(EMPTY); }
});
app.post('/api/products/transactions/:id/return', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    const { barcodeNumber, name, price, quantity, category, vendorId, vendorSharePercentage, vendorCreditPercent, vendorClinicFixedPerUnit } = req.body;
    const [r] = await db.query('INSERT INTO products (barcode_number,name,price,quantity,category,vendor_id,vendor_share_percentage,vendor_credit_percent,vendor_clinic_fixed_per_unit) VALUES (?,?,?,?,?,?,?,?,?)',
      [barcodeNumber || '', name, price || 0, quantity || 0, category || '', vendorId || null, vendorSharePercentage ?? null, vendorCreditPercent ?? null, vendorClinicFixedPerUnit ?? null]);
    res.json({ data: { id: r.insertId } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const { barcodeNumber, name, price, quantity, category, vendorId, vendorSharePercentage, vendorCreditPercent, vendorClinicFixedPerUnit } = req.body;
    await db.query('UPDATE products SET barcode_number=?,name=?,price=?,quantity=?,category=?,vendor_id=?,vendor_share_percentage=?,vendor_credit_percent=?,vendor_clinic_fixed_per_unit=? WHERE id=?',
      [barcodeNumber || '', name, price || 0, quantity || 0, category || '', vendorId || null, vendorSharePercentage ?? null, vendorCreditPercent ?? null, vendorClinicFixedPerUnit ?? null, req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM products WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ VENDORS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/vendors', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 100, search } = req.query; const pg = P(page), sz = P(pageSize) || 50;
    let where = '1=1', params = [];
    if (search) { where += ' AND (v.vendor_name LIKE ? OR v.contact_person LIKE ? OR v.contact_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM vendors v WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT v.*,
        COALESCE(agg.units_sold, 0) as unitsSoldLifetime,
        COALESCE(agg.gross_sales, 0) as grossSalesLifetime,
        COALESCE(agg.vendor_share, 0) as outstandingPayable,
        COALESCE(sett.settled_share, 0) as settledVendorShare,
        COALESCE(sett.settled_gross, 0) as settledGrossSales,
        COALESCE(sett.count, 0) as settlementsCount
       FROM vendors v
       LEFT JOIN (
         SELECT p.vendor_id, SUM(bi.quantity) as units_sold, SUM(bi.total) as gross_sales,
                SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL THEN bi.total * p.vendor_share_percentage / 100
                         ELSE COALESCE(bi.total,0) END) as vendor_share
         FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
         LEFT JOIN products p ON p.id = bi.product_id
         WHERE bi.product_id IS NOT NULL AND p.vendor_id IS NOT NULL
         GROUP BY p.vendor_id
       ) agg ON agg.vendor_id = v.id
       LEFT JOIN (
         SELECT vendor_id, SUM(vendor_share) as settled_share, SUM(gross_sales) as settled_gross, COUNT(*) as count
         FROM vendor_settlements GROUP BY vendor_id
       ) sett ON sett.vendor_id = v.id
       WHERE ${where} ORDER BY v.id DESC LIMIT ? OFFSET ?`,
      [...params, sz, (pg - 1) * sz]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch (e) { console.error('[vendors]', e.message); res.json(EMPTY); }
});
app.get('/api/vendors/settlements', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 100, vendorId } = req.query;
    const pg = P(page), sz = P(pageSize) || 50;
    let where = '1=1', params = [];
    if (vendorId) { where += ' AND vendor_id = ?'; params.push(Number(vendorId)); }
    const [count] = await db.query(`SELECT COUNT(*) cnt FROM vendor_settlements WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT vs.*, v.vendor_name as vendorName
       FROM vendor_settlements vs LEFT JOIN vendors v ON v.id = vs.vendor_id
       WHERE ${where} ORDER BY vs.id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch (e) { console.error('[vendors/settlements]', e.message); res.json(EMPTY); }
});
app.get('/api/vendors/consignment-period-summary', authMiddleware, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.json({ data: { vendors: [], grandTotal: { grossSales: 0, clinicAmount: 0, vendorOwed: 0, unitsSold: 0 } } });
    }
    const [rows] = await db.query(
      `SELECT v.id as vendorId, v.vendor_name as vendorName,
              COALESCE(SUM(bi.quantity),0) as unitsSold,
              COALESCE(SUM(bi.total),0) as grossSales,
              COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as vendorOwed,
              COALESCE(SUM(bi.total),0) - COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as clinicAmount
       FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id
       JOIN vendors v ON v.id = p.vendor_id
       WHERE bi.product_id IS NOT NULL AND p.vendor_id IS NOT NULL
         AND DATE(b.created_at) BETWEEN ? AND ?
       GROUP BY v.id, v.vendor_name`,
      [startDate, endDate]);
    const vendors = toCamel(rows);
    const grandTotal = {
      grossSales: vendors.reduce((s, x) => s + Number(x.grossSales || 0), 0),
      clinicAmount: vendors.reduce((s, x) => s + Number(x.clinicAmount || 0), 0),
      vendorOwed: vendors.reduce((s, x) => s + Number(x.vendorOwed || 0), 0),
      unitsSold: vendors.reduce((s, x) => s + Number(x.unitsSold || 0), 0),
    };
    res.json({ data: { vendors, grandTotal } });
  } catch (e) { console.error('[vendors/consignment-period-summary]', e.message); res.json({ data: { vendors: [], grandTotal: { grossSales: 0, clinicAmount: 0, vendorOwed: 0, unitsSold: 0 } } }); }
});
app.post('/api/vendors', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [r] = await db.query('INSERT INTO vendors (vendor_name,contact_person,contact_number,notes,is_active) VALUES (?,?,?,?,?)',
      [d.vendorName || d.name || '', d.contactPerson || null, d.contactNumber || d.contact || null, d.notes || null, d.isActive === undefined ? 1 : (d.isActive ? 1 : 0)]);
    res.json({ data: { id: r.insertId, ...d } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/vendors/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE vendors SET vendor_name=?,contact_person=?,contact_number=?,notes=?,is_active=? WHERE id=?',
      [d.vendorName || d.name || '', d.contactPerson ?? null, d.contactNumber ?? null, d.notes ?? null, d.isActive === undefined ? 1 : (d.isActive ? 1 : 0), req.params.id]);
    res.json({ success: true }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/vendors/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM vendors WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.get('/api/vendors/:id/settlement-preview', authMiddleware, async (req, res) => {
  try {
    const vendorId = Number(req.params.id);
    const { startDate, endDate } = req.query;
    let dateFilter = '', params = [];
    if (startDate && endDate) { dateFilter = ' AND DATE(b.created_at) BETWEEN ? AND ?'; params.push(startDate, endDate); }
    const [items] = await db.query(
      `SELECT p.id as productId, p.name as productName,
              COALESCE(SUM(bi.quantity),0) as unitsSold,
              COALESCE(SUM(bi.total),0) as grossSales,
              COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as vendorShare,
              COALESCE(SUM(bi.total),0) - COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as clinicShare
       FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id
       WHERE bi.product_id IS NOT NULL AND p.vendor_id = ?${dateFilter}
       GROUP BY p.id, p.name`,
      [vendorId].concat(params));
    const itemRows = toCamel(items);
    const totals = {
      unitsSold: itemRows.reduce((s, x) => s + Number(x.unitsSold || 0), 0),
      grossSales: itemRows.reduce((s, x) => s + Number(x.grossSales || 0), 0),
      vendorShare: itemRows.reduce((s, x) => s + Number(x.vendorShare || 0), 0),
      clinicShare: itemRows.reduce((s, x) => s + Number(x.clinicShare || 0), 0),
    };
    res.json({ data: { items: itemRows, totals, totalPayable: totals.vendorShare } });
  } catch (e) { console.error('[vendors/:id/settlement-preview]', e.message); res.json({ data: { items: [], totals: { unitsSold: 0, grossSales: 0, vendorShare: 0, clinicShare: 0 }, totalPayable: 0 } }); }
});
app.post('/api/vendors/:id/settlements', authMiddleware, async (req, res) => {
  try {
    const vendorId = Number(req.params.id);
    const { startDate, endDate, notes } = req.body;
    let dateFilter = '', params = [];
    if (startDate && endDate) { dateFilter = ' AND DATE(b.created_at) BETWEEN ? AND ?'; params.push(startDate, endDate); }
    const [rows] = await db.query(
      `SELECT COALESCE(SUM(bi.quantity),0) as grossUnits, COALESCE(SUM(bi.total),0) as grossSales,
              COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as vendorShare,
              COALESCE(SUM(bi.total),0) - COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as clinicShare
       FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id
       WHERE bi.product_id IS NOT NULL AND p.vendor_id = ?${dateFilter}`,
      [vendorId].concat(params));
    const r = rows[0];
    const vendorShare = Number(r.vendorShare || 0), grossSales = Number(r.grossSales || 0);
    const clinicShare = Number(r.clinicShare || 0);
    await db.query('INSERT INTO vendor_settlements (vendor_id, start_date, end_date, gross_sales, clinic_share, vendor_share, notes) VALUES (?,?,?,?,?,?,?)',
      [vendorId, startDate || null, endDate || null, grossSales, clinicShare, vendorShare, notes || null]);
    res.json({ success: true, data: { id: null } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/vendors/:id/settlements', authMiddleware, async (req, res) => {
  try {
    const vendorId = Number(req.params.id);
    const [rows] = await db.query(
      `SELECT vs.*, v.vendor_name as vendorName FROM vendor_settlements vs
       LEFT JOIN vendors v ON v.id = vs.vendor_id WHERE vs.vendor_id = ? ORDER BY vs.id DESC`,
      [vendorId]);
    res.json(paginate(rows, rows.length, 1, 100));
  } catch { res.json(EMPTY); }
});

// â”€â”€â”€ COUPONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/coupons', authMiddleware, async (req, res) => {
  try { const { page = 1, pageSize = 5, search } = req.query; const pg = P(page) || 1, sz = P(pageSize) || 5;
    let where = '1=1', params = [];
    if (search) { where += ' AND code LIKE ?'; params.push(`%${search}%`); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM coupons WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT * FROM coupons WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/coupons', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const dType = d.discountType || d.discount_type || 'PERCENT';
    const dVal = Number(d.discountValue ?? d.discount_value ?? 0);
    const [r] = await db.query('INSERT INTO coupons (code,discount_type,discount_value,start_date,expiry_date,usage_limit,is_active) VALUES (?,?,?,?,?,?,?)',
      [d.code||'', dType==='PERCENTAGE'?'PERCENT':(dType==='FIXED'?'FIXED':'PERCENT'), dVal, d.startDate || d.start_date || null, d.expiryDate || d.expiry_date || null, d.usageLimit || d.usage_limit || 0, d.isActive === undefined ? (d.is_active_status === undefined ? 1 : (d.is_active_status ? 1 : 0)) : (d.isActive ? 1 : 0)]);
    res.json({ data: { id: r.insertId, discountType: dType==='PERCENTAGE'?'PERCENT':dType, discountValue: dVal, ...d } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/coupons/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE coupons SET code=?,discount_type=?,discount_value=?,start_date=?,expiry_date=?,usage_limit=?,is_active=? WHERE id=?',
      [d.code || '', d.discountType === 'PERCENTAGE' ? 'PERCENT' : (d.discountType === 'FIXED' ? 'FIXED' : 'PERCENT'), d.discountValue || 0, d.startDate || null, d.expiryDate || null, d.usageLimit || 0, d.isActive === undefined ? 1 : (d.isActive ? 1 : 0), req.params.id]);
    res.json({ success: true }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/coupons/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM coupons WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.post('/api/coupons/apply', authMiddleware, async (req, res) => {
  try {
    const { code, total, subtotal } = req.body;
    const [rows] = await db.query('SELECT * FROM coupons WHERE code=?', [code||'']);
    if (!rows.length) return res.json({ data: { discountValue: 0, couponId: null, discountType: null } });
    const c = rows[0];
    const amt = Number(total) || Number(subtotal) || 0;
    const dv = c.discount_type === 'FIXED' ? (amt > 0 ? Math.min(c.discount_value, amt) : c.discount_value) : (amt > 0 ? Math.round(amt * c.discount_value / 100 * 100) / 100 : c.discount_value);
    res.json({ data: { discountValue: dv, couponId: c.id, discountType: c.discount_type, rawDiscountValue: c.discount_value } });
  } catch { res.json({ data: { discountValue: 0, couponId: null, discountType: null } }); }
});

// â”€â”€â”€ APPOINTMENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/appointments', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 50, limit = 50, search = '', date, status, startDate, endDate } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 50, offset = (pg - 1) * sz;
    let where = '1=1', params = [];
    if (search) { where += ' AND (c.client_name LIKE ? OR p.pet_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (date) { where += ' AND a.appointment_date=?'; params.push(date); }
    if (startDate) { where += ' AND a.appointment_date>=?'; params.push(startDate); }
    if (endDate) { where += ' AND a.appointment_date<=?'; params.push(endDate); }
    if (status) { where += ' AND a.status=?'; params.push(status); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT a.*, c.client_name, c.contact_number, p.pet_name, p.species, p.breed, (SELECT COALESCE(SUM(quantity*rate),0) FROM appointment_services WHERE appointment_id=a.id) as total_amount FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE ${where} ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT ? OFFSET ?`, [...params, sz, offset]);
    for (const a of rows) {
      const [svcs] = await db.query('SELECT * FROM appointment_services WHERE appointment_id=?', [a.id]);
      a.services = svcs;
    }
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/appointments', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    let clientId = d.clientId || d.client_id || null;
    if (!clientId && (d.petId || d.pet_id)) {
      const [prows] = await db.query('SELECT client_id FROM pets WHERE id=?', [d.petId || d.pet_id]);
      if (prows.length) clientId = prows[0].client_id;
    }
    const [r] = await db.query('INSERT INTO appointments (pet_id,client_id,appointment_date,appointment_time,notes,status,doctor) VALUES (?,?,?,?,?,?,?)',
      [d.petId||d.pet_id, clientId, d.appointmentDate||d.appointment_date, d.appointmentTime||d.appointment_time||null, d.notes||'', d.status||'CONFIRMED', d.doctor||'']);
    if (d.services && d.services.length) {
      for (const s of d.services) {
        await db.query('INSERT INTO appointment_services (appointment_id,service_id,service_name,quantity,rate,notes) VALUES (?,?,?,?,?,?)',
          [r.insertId, s.serviceId||null, s.serviceName||s.name||'', s.quantity||1, s.rate||s.baseRate||0, s.notes||'']);
      }
    }
    res.json({ data: { id: r.insertId, isNewClient: false, firstTimeFee: 1050 } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/appointments/:id/for-billing', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT a.*, c.client_name, c.contact_number, p.pet_name FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE a.id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    const [svcs] = await db.query('SELECT * FROM appointment_services WHERE appointment_id=?', [req.params.id]);
    rows[0].services = toCamel(svcs);
    rows[0].totalAmount = svcs.reduce((s, x) => s + Number(x.quantity || 1) * Number(x.rate || 0), 0);
    rows[0].serviceCosts = rows[0].totalAmount;
    const [fr] = await db.query('SELECT COUNT(*) AS c FROM clients WHERE id=?', [rows[0].client_id]);
    rows[0].firstTimeFee = 0;
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/appointments/:id/invoice-payload', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT a.*, c.client_name, c.contact_number, p.pet_name FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE a.id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    const [svcs] = await db.query('SELECT * FROM appointment_services WHERE appointment_id=?', [req.params.id]);
    const a = rows[0];
    res.json({ data: { ...toCamel(a), lineItems: svcs.map(s => ({ label: s.service_name, cartQty: s.quantity, price: s.rate, total: s.quantity * s.rate })), subtotal: svcs.reduce((s,x) => s + x.quantity * x.rate, 0), couponDiscount: 0, manualDiscount: 0, finalTotal: svcs.reduce((s,x) => s + x.quantity * x.rate, 0), totalPaid: 0, remaining: svcs.reduce((s,x) => s + x.quantity * x.rate, 0), invoiceNo: 'INV-' + a.id } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/appointments/:id/payment-details', authMiddleware, async (req, res) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) return res.json({ data: { payments: [], appointment: null, totalDue: 0, totalPaid: 0, remaining: 0 } });
    const [arows] = await db.query('SELECT a.*, c.client_name, c.contact_number, p.pet_name FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE a.id=?', [req.params.id]);
    if (!arows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    const [brows] = await db.query('SELECT * FROM billing WHERE appointment_id=?', [req.params.id]);
    const a = toCamel(arows[0]);
    const [srows] = await db.query('SELECT COALESCE(SUM(quantity*rate),0) as total FROM appointment_services WHERE appointment_id=?', [req.params.id]);
    const total = Number(srows[0].total) || 0;
    const amountPaid = brows.reduce((s, b) => s + Number(b.amount_paid || 0), 0);
    const totalDue = total || amountPaid;
    res.json({ data: {
      payments: toCamel(brows).map(b => ({ id: b.id, amount: Number(b.amountPaid || 0), paymentMode: b.paymentMode, paidAt: b.createdAt })),
      appointment: { id: a.id, petName: a.petName, clientName: a.clientName, contactNumber: a.contactNumber, doctor: a.doctor, appointmentDate: a.appointmentDate, appointmentTime: a.appointmentTime, totalAmount: totalDue, firstTimeFee: 0, billingStatus: amountPaid >= totalDue && amountPaid > 0 ? 'PAID' : (amountPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID'), billingId: null },
      totalDue, totalPaid: amountPaid, remaining: Math.max(totalDue - amountPaid, 0),
    } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/appointments/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    await db.query('UPDATE appointments SET pet_id=?,client_id=?,appointment_date=?,appointment_time=?,notes=?,status=?,doctor=? WHERE id=?',
      [d.petId||d.pet_id, d.clientId||d.client_id, d.appointmentDate||d.appointment_date, d.appointmentTime||d.appointment_time||null, d.notes||'', d.status||'CONFIRMED', d.doctor||'', req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.delete('/api/appointments/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM appointment_services WHERE appointment_id=?', [req.params.id]); await db.query('DELETE FROM appointments WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.patch('/api/appointments/:id/status', authMiddleware, async (req, res) => {
  try { await db.query('UPDATE appointments SET status=? WHERE id=?', [req.body.status, req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.patch('/api/appointments/:id/payment-status', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/appointments/:id/services', authMiddleware, async (req, res) => {
  try {
    const { serviceId, serviceName, quantity, rate, notes } = req.body;
    const [r] = await db.query('INSERT INTO appointment_services (appointment_id,service_id,service_name,quantity,rate,notes) VALUES (?,?,?,?,?,?)',
      [req.params.id, serviceId||null, serviceName||'', quantity||1, rate||0, notes||'']);
    res.json({ data: { id: r.insertId } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/appointments/:id/services/:sid', authMiddleware, async (req, res) => {
  try { const { serviceName, quantity, rate, notes } = req.body; await db.query('UPDATE appointment_services SET service_name=?,quantity=?,rate=?,notes=? WHERE id=?', [serviceName||'', quantity||1, rate||0, notes||'', req.params.sid]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/appointments/:id/services/:sid', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM appointment_services WHERE id=?', [req.params.sid]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/appointments/services/:sid', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM appointment_services WHERE id=?', [req.params.sid]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.post('/api/appointments/:id/payments', authMiddleware, async (req, res) => {
  try {
    const { amountPaid, paymentMode, clientId, clientName, customerPhone } = req.body;
    const invNo = 'INV-' + Date.now();
    const [r] = await db.query('INSERT INTO billing (appointment_id,client_id,customer_name,customer_phone,amount_paid,status,payment_mode,invoice_no) VALUES (?,?,?,?,?,?,?,?)',
      [req.params.id, clientId||null, clientName||customerPhone||'', customerPhone||'', amountPaid||0, 'PAID', paymentMode||'CASH', invNo]);
    res.json({ data: { id: r.insertId, invoiceNo: invNo, status: 'PAID' } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/appointment-payments', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, statusFilter, search } = req.query;
const pg = P(page) || 1, sz = P(pageSize) || 10;
    let where = '1=1 AND b.appointment_id IS NOT NULL', params = [];
    if (statusFilter && statusFilter !== 'all' && statusFilter !== 'All') {
      const up = String(statusFilter).toUpperCase();
      const st = up === 'PAID' ? 'PAID' : (up === 'UNPAID' ? 'UNPAID' : (up === 'PARTIALLY PAID' || up === 'PARTIALLY_PAID' ? 'PARTIALLY_PAID' : null));
      if (st) { where += ' AND b.status=?'; params.push(st); }
    }
    if (search) { where += ' AND (b.customer_name LIKE ? OR b.pet_name LIKE ? OR b.invoice_no LIKE ? OR c.client_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    const base = `FROM billing b
      LEFT JOIN appointments a ON b.appointment_id=a.id
      LEFT JOIN clients c ON c.id = COALESCE(b.client_id, a.client_id)
      LEFT JOIN pets p ON p.id = a.pet_id`;
    const [count] = await db.query(`SELECT COUNT(*) as cnt ${base} WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT b.id as billing_id, b.appointment_id, b.customer_name, b.customer_phone, b.pet_name, b.final_total, b.amount_paid, b.status as billing_status, b.invoice_no, b.created_at, b.payment_mode,
      a.appointment_date, a.appointment_time, c.client_name, c.contact_number, p.pet_name as joined_pet_name,
      (SELECT COALESCE(SUM(quantity*rate),0) FROM appointment_services WHERE appointment_id=b.appointment_id) as services_total
      ${base} WHERE ${where} ORDER BY b.id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    const data = rows.map(r => {
      const services = Number(r.services_total) || 0;
      const totalAmt = Math.max(services, Number(r.final_total) || 0);
      return {
        appointmentId: r.appointment_id,
        appointmentDate: r.appointment_date ? (r.appointment_date instanceof Date ? `${r.appointment_date.getFullYear()}-${String(r.appointment_date.getMonth()+1).padStart(2,'0')}-${String(r.appointment_date.getDate()).padStart(2,'0')}` : r.appointment_date) : null,
        appointmentTime: r.appointment_time ? (r.appointment_time instanceof Date ? r.appointment_time.toISOString() : r.appointment_time) : null,
        totalAmount: totalAmt, firstTimeFee: 0,
        billingStatus: r.billing_status, billingId: r.billing_id,
        clientName: r.customer_name || r.client_name || '', contactNumber: r.customer_phone || r.contact_number || '',
        petName: r.pet_name || r.joined_pet_name || '',
        totalDue: totalAmt, totalPaid: Number(r.amount_paid) || 0,
        paymentSummary: r.invoice_no,
      };
    });
    res.json({ data, total: count[0].cnt, page: pg, totalPages: Math.ceil(count[0].cnt / sz) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
// â”€â”€â”€ APPOINTMENT PRODUCTS / INVENTORY USAGE / PREDISCOUNT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function appointmentProductsSql(appointmentId, onlyUnlocked) {
  return `SELECT ap.*, p.name, p.barcode_number FROM appointment_products ap LEFT JOIN products p ON p.id = ap.product_id WHERE ap.appointment_id = ${Number(appointmentId) || 0}${onlyUnlocked ? ' AND ap.locked = 0' : ''} ORDER BY ap.locked, ap.id DESC`;
}
app.get('/api/appointments/:id/products', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(appointmentProductsSql(req.params.id, false)); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/appointments/:id/products/display', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(appointmentProductsSql(req.params.id, false)); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/appointments/:id/products', authMiddleware, async (req, res) => {
  try {
    const productId = Number(req.body.productId);
    const qty = Number(req.body.quantity) || 1;
    const [prod] = await db.query('SELECT id,name,price FROM products WHERE id=?', [productId]);
    if (!prod.length) return res.status(404).json({ error: { message: 'Product not found' } });
    const price = Number(prod[0].price) || 0;
    const [dup] = await db.query('SELECT id,quantity FROM appointment_products WHERE appointment_id=? AND product_id=? AND locked=0', [req.params.id, productId]);
    if (dup.length) {
      const q = Number(dup[0].quantity) + qty;
      await db.query('UPDATE appointment_products SET quantity=?, total=? WHERE id=?', [q, q * price, dup[0].id]);
    } else {
      await db.query('INSERT INTO appointment_products (appointment_id,product_id,quantity,price,total,locked) VALUES (?,?,?,?,?,0)', [req.params.id, productId, qty, price, qty * price]);
    }
    res.json({ data: { message: prod[0].name + ' added to appointment' } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/appointment-products/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM appointment_products WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.get('/api/appointments/:id/inventory-usage', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT ap.product_id AS productId, (SELECT name FROM products WHERE id=ap.product_id) AS name,
      (SELECT barcode_number FROM products WHERE id=ap.product_id) AS barcodeNumber,
      (SELECT quantity FROM products WHERE id=ap.product_id) AS stockRemaining,
      SUM(ap.quantity) AS totalDeducted FROM appointment_products ap WHERE ap.appointment_id=? AND ap.product_id IS NOT NULL GROUP BY ap.product_id`, [req.params.id]);
    res.json({ data: rows }); } catch { res.json({ data: [] }); }
});
app.post('/api/appointments/:id/inventory-usage', authMiddleware, async (req, res) => {
  try {
    const productId = Number(req.body.productId);
    const qty = Number(req.body.quantity) || 1;
    const [prod] = await db.query('SELECT id,name,quantity FROM products WHERE id=?', [productId]);
    if (!prod.length) return res.status(404).json({ error: { message: 'Product not found' } });
    const remaining = Number(prod[0].quantity) - qty;
    if (remaining < 0) return res.status(400).json({ error: { message: 'Insufficient stock for ' + prod[0].name } });
    await db.query('UPDATE products SET quantity=? WHERE id=?', [remaining, productId]);
    res.json({ data: { productName: prod[0].name } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
async function appointmentTotals(appointmentId) {
  const [svc] = await db.query('SELECT COALESCE(SUM(rate*quantity),0) AS fee FROM appointment_services WHERE appointment_id=?', [appointmentId]);
  const [prod] = await db.query('SELECT COALESCE(SUM(total),0) AS pt, COALESCE(SUM(CASE WHEN locked=1 THEN total ELSE 0 END),0) AS locked FROM appointment_products WHERE appointment_id=?', [appointmentId]);
  const [paid] = await db.query('SELECT COALESCE(SUM(amount_paid),0) AS paid FROM billing WHERE appointment_id=?', [appointmentId]);
  const [bill] = await db.query('SELECT id FROM billing WHERE appointment_id=? ORDER BY id DESC LIMIT 1', [appointmentId]);
  return {
    appointmentFee: Number(svc[0].fee), productsTotal: Number(prod[0].pt) - Number(prod[0].locked),
    rawTotal: Number(svc[0].fee) + Number(prod[0].pt) - Number(prod[0].locked),
    alreadyPaid: Number(paid[0].paid), billingId: bill.length ? bill[0].id : null,
  };
}
function discountAmountFor(type, value, rawTotal) {
  if (type === 'percent') return Math.min(100, Number(value) || 0) * rawTotal / 100;
  if (type === 'fixed') return Math.min(Number(value) || 0, rawTotal);
  return 0;
}
app.get('/api/appointments/:id/prediscount', authMiddleware, async (req, res) => {
  try {
    const t = await appointmentTotals(req.params.id);
    const [appt] = await db.query('SELECT prediscount_type,prediscount_value FROM appointments WHERE id=?', [req.params.id]);
    let existingDiscount = null;
    if (appt.length && appt[0].prediscount_type) {
      const da = discountAmountFor(appt[0].prediscount_type, appt[0].prediscount_value, t.rawTotal);
      existingDiscount = { billingId: t.billingId, rawTotal: t.rawTotal, discountAmount: da, finalAmount: Math.max(0, t.rawTotal - da), discountType: appt[0].prediscount_type, discountValue: Number(appt[0].prediscount_value) };
    }
    res.json({ data: { ...t, existingDiscount } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.put('/api/appointments/:id/prediscount', authMiddleware, async (req, res) => {
  try {
    const type = req.body.discountType === 'fixed' ? 'fixed' : 'percent';
    const value = Number(req.body.discountValue) || 0;
    await db.query('UPDATE appointments SET prediscount_type=?, prediscount_value=? WHERE id=?', [type, value, req.params.id]);
    const t = await appointmentTotals(req.params.id);
    const da = discountAmountFor(type, value, t.rawTotal);
    res.json({ data: { billingId: t.billingId, rawTotal: t.rawTotal, discountAmount: da, finalAmount: Math.max(0, t.rawTotal - da) } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/appointments/:id/prediscount', authMiddleware, async (req, res) => {
  try { await db.query('UPDATE appointments SET prediscount_type=NULL, prediscount_value=NULL WHERE id=?', [req.params.id]); res.json({ data: { removed: true } }); }
  catch { res.json({ data: { removed: false } }); }
});

// â”€â”€â”€ BILLING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/billing', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, limit = 20, search = '', status } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 20, offset = (pg - 1) * sz;
    let where = '1=1', params = [];
    if (search) { where += ' AND (customer_name LIKE ? OR invoice_no LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (status) { where += ' AND status=?'; params.push(status); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM billing WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT * FROM billing WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/billing/complete-payment', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const cart = Array.isArray(d.cart) ? d.cart : [];
    const methods = Array.isArray(d.paymentMethods) ? d.paymentMethods : [];
    const subtotal = Number(d.subtotal) || cart.reduce((s, i) => s + Number(i.total || 0), 0);
    const discount = Number(d.discount || d.manualDiscountAmount || 0);
    const finalTotal = Number(d.finalTotal || d.total) || Math.max(0, subtotal - discount);
    const totalPaid = methods.reduce((s, m) => s + Number(m.amount || 0), 0);
    const status = totalPaid >= finalTotal && finalTotal > 0 ? 'PAID' : (totalPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
    const rawMode = methods[0]?.method || d.paymentMode || 'CASH';
    const paymentMode = rawMode === 'CARD_PAYMENT' ? 'CARD' : (rawMode === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH');
    const invNo = 'INV-' + Date.now();
    const [r] = await db.query('INSERT INTO billing (appointment_id,client_id,customer_name,customer_phone,subtotal,discount,final_total,amount_paid,status,payment_mode,coupon_code,invoice_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [d.appointmentId || null, d.clientId || null, d.customerName || '', d.customerPhone || '', subtotal, discount, finalTotal, totalPaid, status, paymentMode, d.coupon || null, invNo]);
    for (const item of cart) {
      await db.query('INSERT INTO billing_items (billing_id,product_id,name,quantity,price,total) VALUES (?,?,?,?,?,?)',
        [r.insertId, item.id || null, item.name || '', item.cartQty != null ? item.cartQty : 1, item.price || 0, item.total != null ? item.total : (item.cartQty || 1) * (item.price || 0)]);
    }
    if (d.appointmentId) { await db.query('UPDATE appointment_products SET locked=1 WHERE appointment_id=?', [d.appointmentId]); }
    res.json({ data: { billingId: invNo, id: r.insertId, subtotal, discount, finalTotal, amountPaid: totalPaid, status } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/billing/preview', authMiddleware, (req, res) => res.json({ ...req.body, invoiceNo: 'PREVIEW' }));
app.get('/api/billing/clients/unpaid-summary', authMiddleware, async (req, res) => {
  try { res.json(await unpaidClientSummary('walkin', { ...req.query, appointments: false })); } catch { res.json(EMPTY); }
});
app.get('/api/billing/clients/:id/unpaid-detail', authMiddleware, async (req, res) => {
  try {
    const [c] = await db.query('SELECT id, client_name, contact_number, address FROM clients WHERE id=?', [req.params.id]);
    const billings = await unpaidWalkinRows(req.params.id);
    res.json({ data: { clientId: c[0].id, clientName: c[0].client_name, contactNumber: c[0].contact_number, address: c[0].address, totalDue: billings.reduce((s, b) => s + b.remaining, 0), billings } });
  } catch { res.json({ data: [] }); }
});
app.post('/api/billing/clients/:id/pay-all', authMiddleware, async (req, res) => {
  try {
    const kindSql = KINDS.walkin.sql;
    const [t] = await db.query(`SELECT COALESCE(SUM(final_total - amount_paid),0) AS due FROM billing WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    const [r] = await db.query(`UPDATE billing SET amount_paid = final_total, status = 'PAID' WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    res.json({ data: { billingCount: r.affectedRows, totalPaid: Number(t[0].due) || 0 } });
  } catch { res.json({ success: false }); }
});
function quickBillDTO(row, items) {
  const r = toCamel(row || {});
  return {
    id: r.id, invoiceNo: r.invoiceNo, clientId: r.clientId, customerName: r.customerName,
    customerPhone: r.customerPhone, petName: r.petName, subtotal: r.subtotal,
    discountAmount: Number(r.discount), couponCode: r.couponCode, total: r.finalTotal,
    paymentMode: r.paymentMode, amountPaid: r.amountPaid, status: r.status,
    createdAt: r.createdAt, items: (items || []).map(i => ({ id: i.id, productId: i.productId, name: i.name, quantity: i.quantity, price: i.price, total: i.total })),
  };
}
app.post('/api/billing/custom-invoice', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const lineItems = Array.isArray(d.lineItems) ? d.lineItems : [];
    const subtotal = Number(d.subtotal) || lineItems.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.price) || 0), 0);
    const discount = Number(d.manualDiscountAmount || 0);
    const finalTotal = Math.max(0, subtotal - discount);
    const amountPaid = d.amountPaid != null && d.amountPaid !== '' ? Number(d.amountPaid) : 0;
    const apiMode = d.paymentMode;
    const paymentMode = apiMode === 'CARD_PAYMENT' ? 'CARD' : (apiMode === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH');
    const status = amountPaid >= finalTotal && finalTotal > 0 ? 'PAID' : (amountPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
    const [r] = await db.query('INSERT INTO billing (client_id,customer_name,customer_phone,pet_name,subtotal,discount,final_total,amount_paid,status,payment_mode,coupon_code,invoice_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [d.clientId || null, d.customerName || '', d.customerPhone || '', d.petName || '', subtotal, discount, finalTotal, amountPaid, status, paymentMode, d.couponCode || null, null]);
    const invNo = 'QB-' + r.insertId;
    await db.query('UPDATE billing SET invoice_no=? WHERE id=?', [invNo, r.insertId]);
    for (const li of lineItems) {
      await db.query('INSERT INTO billing_items (billing_id,product_id,name,quantity,price,total) VALUES (?,?,?,?,?,?)',
        [r.insertId, li.productId || null, li.name || '', Number(li.quantity) || 1, Number(li.price) || 0, (Number(li.quantity) || 1) * (Number(li.price) || 0)]);
    }
    const [row] = await db.query('SELECT * FROM billing WHERE id=?', [r.insertId]);
    const [items] = await db.query('SELECT * FROM billing_items WHERE billing_id=?', [r.insertId]);
    res.json({ data: quickBillDTO(row[0], toCamel(items)) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/billing/custom-invoices', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, search } = req.query; const pg = P(page) || 1, sz = P(pageSize) || 10;
    let where = '1=1', params = [];
    if (search) { where += ' AND (customer_name LIKE ? OR invoice_no LIKE ? OR customer_phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM billing WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT * FROM billing WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    const rowsC = toCamel(rows);
    for (const b of rowsC) {
      const [items] = await db.query('SELECT * FROM billing_items WHERE billing_id=?', [b.id]);
      b.items = toCamel(items).map(i => ({ id: i.id, productId: i.productId, name: i.name, quantity: i.quantity, price: i.price, total: i.total }));
    }
    res.json({ data: rowsC, total: count[0].cnt, page: pg, totalPages: Math.ceil(count[0].cnt / sz) });
  } catch { res.json(EMPTY); }
});
app.patch('/api/billing/custom-invoice/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const lineItems = Array.isArray(d.lineItems) ? d.lineItems : [];
    const subtotal = Number(d.subtotal) || lineItems.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.price) || 0), 0);
    const discount = Number(d.manualDiscountAmount || 0);
    const finalTotal = Math.max(0, subtotal - discount);
    const amountPaid = d.amountPaid != null && d.amountPaid !== '' ? Number(d.amountPaid) : 0;
    const apiMode = d.paymentMode;
    const paymentMode = apiMode === 'CARD_PAYMENT' ? 'CARD' : (apiMode === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH');
    const status = amountPaid >= finalTotal && finalTotal > 0 ? 'PAID' : (amountPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
    await db.query('UPDATE billing SET client_id=?, customer_name=?, customer_phone=?, pet_name=?, subtotal=?, discount=?, final_total=?, amount_paid=?, status=?, payment_mode=?, coupon_code=? WHERE id=?',
      [d.clientId || null, d.customerName || '', d.customerPhone || '', d.petName || '', subtotal, discount, finalTotal, amountPaid, status, paymentMode, d.couponCode || null, req.params.id]);
    await db.query('DELETE FROM billing_items WHERE billing_id=?', [req.params.id]);
    for (const li of lineItems) {
      await db.query('INSERT INTO billing_items (billing_id,product_id,name,quantity,price,total) VALUES (?,?,?,?,?,?)',
        [req.params.id, li.productId || null, li.name || '', Number(li.quantity) || 1, Number(li.price) || 0, (Number(li.quantity) || 1) * (Number(li.price) || 0)]);
    }
    const [row] = await db.query('SELECT * FROM billing WHERE id=?', [req.params.id]);
    const [items] = await db.query('SELECT * FROM billing_items WHERE billing_id=?', [req.params.id]);
    res.json({ data: quickBillDTO(row[0], toCamel(items)) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/billing/custom-invoice/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM billing_items WHERE billing_id=?', [req.params.id]); await db.query('DELETE FROM billing WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.get('/api/billing/custom-invoices/clients/unpaid-summary', authMiddleware, async (req, res) => {
  try { res.json(await unpaidClientSummary('quickbill', { ...req.query, appointments: false })); } catch { res.json(EMPTY); }
});
app.get('/api/billing/custom-invoices/clients/:id/unpaid-detail', authMiddleware, async (req, res) => {
  try {
    const [c] = await db.query('SELECT id, client_name, contact_number, address FROM clients WHERE id=?', [req.params.id]);
    const quickBills = await unpaidQuickBillRows(req.params.id);
    res.json({ data: { clientId: c[0].id, clientName: c[0].client_name, contactNumber: c[0].contact_number, address: c[0].address, totalDue: quickBills.reduce((s, b) => s + b.remaining, 0), quickBills } });
  } catch { res.json({ data: [] }); }
});
app.post('/api/billing/custom-invoices/clients/:id/pay-all', authMiddleware, async (req, res) => {
  try {
    const kindSql = KINDS.quickbill.sql;
    const [t] = await db.query(`SELECT COALESCE(SUM(final_total - amount_paid),0) AS due FROM billing WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    const [r] = await db.query(`UPDATE billing SET amount_paid = final_total, status = 'PAID' WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    res.json({ data: { billingCount: r.affectedRows, totalPaid: Number(t[0].due) || 0 } });
  } catch { res.json({ success: false }); }
});

// â”€â”€â”€ EXPENSES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/expenses', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 50, search = '', startDate, endDate, categoryId } = req.query;
    let where = '1=1', params = [];
    if (startDate) { where += ' AND e.date>=?'; params.push(startDate); }
    if (endDate) { where += ' AND e.date<=?'; params.push(endDate); }
    if (categoryId) { where += ' AND e.category_id=?'; params.push(categoryId); }
    const [rows] = await db.query(`SELECT e.*, ec.name as category_name FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id WHERE ${where} ORDER BY e.date DESC`, params);
    res.json({ data: toCamel(rows), total: rows.length });
  } catch { res.json({ data: [], total: 0 }); }
});
app.get('/api/expenses/total', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT COALESCE(SUM(amount),0) as total FROM expenses'); res.json({ total: rows[0].total }); }
  catch { res.json({ total: 0 }); }
});
app.get('/api/expenses/list', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT e.*, ec.name as category_name FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id ORDER BY e.date DESC'); res.json({ data: toCamel(rows), total: rows.length }); }
  catch { res.json({ data: [], total: 0 }); }
});
app.get('/api/expense-categories', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM expense_categories ORDER BY name'); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/expense-categories', authMiddleware, async (req, res) => {
  try { const { name, description } = req.body; const [r] = await db.query('INSERT INTO expense_categories (name,description) VALUES (?,?)', [name, description||'']); res.json({ data: { id: r.insertId, name } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/expense-categories/:id', authMiddleware, async (req, res) => {
  try { const { name, description } = req.body; await db.query('UPDATE expense_categories SET name=?,description=? WHERE id=?', [name, description||'', req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/expense-categories/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM expense_categories WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.post('/api/expenses', authMiddleware, async (req, res) => {
  try { const { name, categoryId, amount, date, notes } = req.body; const [r] = await db.query('INSERT INTO expenses (name,category_id,amount,date,notes) VALUES (?,?,?,?,?)', [name, categoryId||null, amount||0, date||new Date().toISOString().slice(0,10), notes||'']); res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/expenses/:id', authMiddleware, async (req, res) => {
  try { const { name, categoryId, amount, date, notes } = req.body; await db.query('UPDATE expenses SET name=?,category_id=?,amount=?,date=?,notes=? WHERE id=?', [name, categoryId||null, amount||0, date||new Date().toISOString().slice(0,10), notes||'', req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/expenses/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM expenses WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.get('/api/expenses/pdf', authMiddleware, (req, res) => { res.setHeader('Content-Type', 'application/pdf'); res.end(''); });

// â”€â”€â”€ RECORDS (EMR) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/records/recent', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT sn.*, p.pet_name, c.client_name FROM soap_notes sn JOIN pets p ON sn.pet_id=p.id JOIN clients c ON p.client_id=c.id ORDER BY sn.created_at DESC LIMIT ?', [P(req.query.limit)||20]);
    res.json({ data: rows.map(r => ({ id: r.id, petId: r.pet_id, petName: r.pet_name, recordType: 'SOAP NOTE', createdAt: r.created_at })) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/records/stats', authMiddleware, async (req, res) => {
  try { const [pets]=await db.query('SELECT COUNT(*) as cnt FROM pets'); const [soaps]=await db.query('SELECT COUNT(*) as cnt FROM soap_notes WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)'); const [apts]=await db.query('SELECT COUNT(*) as cnt FROM appointments'); res.json({ data: { totalRecords: pets[0].cnt, recordsThisMonth: soaps[0].cnt, activePatients: pets[0].cnt } }); }
  catch { res.json({ data: { totalRecords: 0, recordsThisMonth: 0, activePatients: 0 } }); }
});
app.get('/api/records/search-pets', authMiddleware, async (req, res) => {
  try { const { q='' } = req.query; const [rows] = await db.query('SELECT p.id,p.pet_name,c.client_name FROM pets p JOIN clients c ON p.client_id=c.id WHERE p.pet_name LIKE ? OR c.client_name LIKE ? LIMIT 10', [`%${q}%`,`%${q}%`]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});

// â”€â”€â”€ SOAP NOTES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/soap-notes', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM soap_notes WHERE pet_id=? ORDER BY created_at DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/soap-notes/:id', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM soap_notes WHERE id=?', [req.params.id]); if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } }); res.json({ data: toCamel(rows[0]) }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/soap-notes/by-appointment/:id', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM soap_notes WHERE appointment_id=?', [req.params.id]); if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } }); res.json({ data: toCamel(rows[0]) }); }
  catch { res.json({ data: null }); }
});
app.get('/api/soap-notes/by-boarding-stay/:id', authMiddleware, (req, res) => res.json(null));
app.get('/api/soap-notes/by-boarding-stay/:id/exists', authMiddleware, (req, res) => res.json({ exists: false }));
app.post('/api/pets/:petId/soap-notes', authMiddleware, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.petId)) return res.status(400).json({ error: { message: 'Invalid pet id: ' + req.params.petId, code: 'BAD_REQUEST' } });
    const d = req.body; const [r] = await db.query('INSERT INTO soap_notes (pet_id,appointment_id,doctor,subjective,objective,assessment,diagnosis,`plan`,temperature,heart_rate,respiratory_rate,weight) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.petId, d.appointmentId||null, d.doctor||'', d.subjective||'', d.objective||'', d.assessment||'', d.diagnosis||'', d.plan||'', d.temperature||null, d.heartRate||d.heart_rate||null, d.respiratoryRate||d.respiratory_rate||null, d.weight||null]);
    res.json({ data: { id: r.insertId } }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/soap-notes/:id', authMiddleware, async (req, res) => {
  try { const d = req.body; await db.query('UPDATE soap_notes SET doctor=?,subjective=?,objective=?,assessment=?,diagnosis=?,`plan`=?,temperature=?,heart_rate=?,respiratory_rate=?,weight=? WHERE id=?',
    [d.doctor||'', d.subjective||'', d.objective||'', d.assessment||'', d.diagnosis||'', d.plan||'', d.temperature||null, d.heartRate||d.heart_rate||null, d.respiratoryRate||d.respiratory_rate||null, d.weight||null, req.params.id]);
    res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.delete('/api/soap-notes/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM soap_notes WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.get('/api/soap-notes/:id/tests-advised', authMiddleware, (req, res) => res.json({ data: [] }));
app.put('/api/soap-notes/:id/tests-advised', authMiddleware, (req, res) => res.json({ success: true }));

// â”€â”€â”€ VACCINATIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/vaccinations', authMiddleware, async (req, res) => { try { const [rows] = await db.query('SELECT * FROM vaccinations WHERE pet_id=? ORDER BY administered_on DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); } catch { res.json({ data: [] }); } });
app.post('/api/pets/:petId/vaccinations', authMiddleware, async (req, res) => {
  try { const d = req.body; const [r] = await db.query('INSERT INTO vaccinations (pet_id,vaccine_name,administered_on,next_due_date,batch_number,notes,administered_by) VALUES (?,?,?,?,?,?,?)',
    [req.params.petId, d.vaccineName||d.vaccine_name||'', d.administeredOn||d.administered_on||null, d.nextDueDate||d.next_due_date||null, d.batchNumber||d.batch_number||'', d.notes||'', d.administeredBy||d.administered_by||'']);
    res.json({ data: { id: r.insertId } }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/vaccinations/:id', authMiddleware, async (req, res) => { try { const d = req.body; await db.query('UPDATE vaccinations SET vaccine_name=?,administered_on=?,next_due_date=?,batch_number=?,notes=?,administered_by=? WHERE id=?',
  [d.vaccineName||d.vaccine_name||'', d.administeredOn||d.administered_on||null, d.nextDueDate||d.next_due_date||null, d.batchNumber||d.batch_number||'', d.notes||'', d.administeredBy||d.administered_by||'', req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.delete('/api/vaccinations/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM vaccinations WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

// â”€â”€â”€ DEWORMINGS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/dewormings', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM dewormings WHERE pet_id=? ORDER BY administered_on DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/dewormings', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO dewormings (pet_id,soap_note_id,product_name,administered_on,next_due_date,batch_number,notes,administered_by) VALUES (?,?,?,?,?,?,?,?)',
      [req.params.petId, d.soapNoteId || d.soap_note_id || null, d.productName || d.product_name || '', d.administeredOn || d.administered_on || null, d.nextDueDate || d.next_due_date || null, d.batchNumber || d.batch_number || '', d.notes || '', d.administeredBy || d.administered_by || '']);
    res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/dewormings/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE dewormings SET product_name=?,administered_on=?,next_due_date=?,batch_number=?,notes=?,administered_by=? WHERE id=?',
      [d.productName || d.product_name || '', d.administeredOn || d.administered_on || null, d.nextDueDate || d.next_due_date || null, d.batchNumber || d.batch_number || '', d.notes || '', d.administeredBy || d.administered_by || '', req.params.id]);
    res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.delete('/api/dewormings/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM dewormings WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

// â”€â”€â”€ PRESCRIPTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/prescriptions', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM prescriptions WHERE pet_id=? ORDER BY prescribed_on DESC', [req.params.petId]);
    for (const rx of rows) { const [meds] = await db.query('SELECT * FROM prescription_medications WHERE prescription_id=?', [rx.id]); rx.medications = meds; }
    res.json({ data: toCamel(rows) }); } catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/prescriptions', authMiddleware, async (req, res) => {
  try { const d = req.body; const [r] = await db.query('INSERT INTO prescriptions (pet_id,prescribed_by,prescribed_on,notes) VALUES (?,?,?,?)',
    [req.params.petId, d.prescribedBy||d.prescribed_by||'', d.prescribedOn||d.prescribed_on||new Date().toISOString().slice(0,10), d.notes||'']);
    if (d.medications && d.medications.length) { for (const m of d.medications) { await db.query('INSERT INTO prescription_medications (prescription_id,name,dosage,frequency,duration) VALUES (?,?,?,?,?)', [r.insertId, m.name||'', m.dosage||'', m.frequency||'', m.duration||'']); } }
    res.json({ data: { id: r.insertId } }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/prescriptions/:id', authMiddleware, (req, res) => res.json({ success: true }));
app.delete('/api/prescriptions/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM prescription_medications WHERE prescription_id=?', [req.params.id]); await db.query('DELETE FROM prescriptions WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

// â”€â”€â”€ PRESCRIPTION UPDATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.patch('/api/prescriptions/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE prescriptions SET prescribed_by=?,prescribed_on=?,notes=? WHERE id=?',
      [d.prescribedBy || d.prescribed_by || '', d.prescribedOn || d.prescribed_on || new Date().toISOString().slice(0, 10), d.notes || '', req.params.id]);
    if (Array.isArray(d.medications)) {
      await db.query('DELETE FROM prescription_medications WHERE prescription_id=?', [req.params.id]);
      for (const m of d.medications) { await db.query('INSERT INTO prescription_medications (prescription_id,name,dosage,frequency,duration) VALUES (?,?,?,?,?)', [req.params.id, m.name || '', m.dosage || '', m.frequency || '', m.duration || '']); }
    }
    res.json({ success: true }); } catch { res.json({ success: true }); }
});

// â”€â”€â”€ LAB / PROCEDURES / BODY WEIGHT (pet-scoped) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/lab-results', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM lab_test_results WHERE pet_id=? ORDER BY test_date DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/lab-results', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO lab_test_results (pet_id,soap_note_id,test_name,test_date,result_summary,result_value,reference_range,status,lab_name,notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [req.params.petId, d.soapNoteId || d.soap_note_id || null, d.testName || d.test_name || '', d.testDate || d.test_date || null, d.resultSummary || d.result_summary || '', d.resultValue || d.result_value || '', d.referenceRange || d.reference_range || '', d.status || '', d.labName || d.lab_name || '', d.notes || '']);
    res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/lab-results/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE lab_test_results SET test_name=?,test_date=?,result_summary=?,result_value=?,reference_range=?,status=?,lab_name=?,notes=? WHERE id=?',
      [d.testName || d.test_name || '', d.testDate || d.test_date || null, d.resultSummary || d.result_summary || '', d.resultValue || d.result_value || '', d.referenceRange || d.reference_range || '', d.status || '', d.labName || d.lab_name || '', d.notes || '', req.params.id]);
    res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.delete('/api/lab-results/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM lab_test_results WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

app.get('/api/pets/:petId/procedures', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM procedures WHERE pet_id=? ORDER BY performed_on DESC', [req.params.petId]);
    for (const pc of rows) { const [mats] = await db.query('SELECT * FROM procedure_materials WHERE procedure_id=?', [pc.id]); pc.materials = toCamel(mats); }
    res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/procedures', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO procedures (pet_id,soap_note_id,procedure_name,performed_on,performed_by,notes,outcome) VALUES (?,?,?,?,?,?,?)',
      [req.params.petId, d.soapNoteId || d.soap_note_id || null, d.procedureName || d.procedure_name || '', d.performedOn || d.performed_on || null, d.performedBy || d.performed_by || '', d.notes || '', d.outcome || '']);
    if (Array.isArray(d.materials)) { for (const m of d.materials) { await db.query('INSERT INTO procedure_materials (procedure_id,product_id,material_name,quantity,dose,route,batch_number,notes) VALUES (?,?,?,?,?,?,?,?)', [r.insertId, m.productId || null, m.materialName || '', m.quantity ?? null, m.dose || '', m.route || '', m.batchNumber || '', m.notes || '']); } }
    res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/procedures/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE procedures SET procedure_name=?,performed_on=?,performed_by=?,notes=?,outcome=? WHERE id=?',
      [d.procedureName || d.procedure_name || '', d.performedOn || d.performed_on || null, d.performedBy || d.performed_by || '', d.notes || '', d.outcome || '', req.params.id]);
    if (Array.isArray(d.materials)) {
      await db.query('DELETE FROM procedure_materials WHERE procedure_id=?', [req.params.id]);
      for (const m of d.materials) { await db.query('INSERT INTO procedure_materials (procedure_id,product_id,material_name,quantity,dose,route,batch_number,notes) VALUES (?,?,?,?,?,?,?,?)', [req.params.id, m.productId || null, m.materialName || '', m.quantity ?? null, m.dose || '', m.route || '', m.batchNumber || '', m.notes || '']); }
    }
    res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.delete('/api/procedures/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM procedure_materials WHERE procedure_id=?', [req.params.id]); await db.query('DELETE FROM procedures WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

app.get('/api/pets/:petId/body-weight-records', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM body_weight_records WHERE pet_id=? ORDER BY recorded_on DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/body-weight-records', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO body_weight_records (pet_id,soap_note_id,weight,weight_unit,recorded_on,notes,recorded_by) VALUES (?,?,?,?,?,?,?)',
      [req.params.petId, d.soapNoteId || d.soap_note_id || null, d.weight, d.weightUnit || d.weight_unit || 'kg', d.recordedOn || d.recorded_on || new Date().toISOString().slice(0, 10), d.notes || '', d.recordedBy || d.recorded_by || '']);
    res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/body-weight-records/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE body_weight_records SET weight=?,weight_unit=?,recorded_on=?,notes=?,recorded_by=? WHERE id=?',
      [d.weight, d.weightUnit || d.weight_unit || 'kg', d.recordedOn || d.recorded_on || null, d.notes || '', d.recordedBy || d.recorded_by || '', req.params.id]);
    res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.delete('/api/body-weight-records/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM body_weight_records WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.get('/api/pets/:petId/reports', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM lab_reports WHERE pet_id=? ORDER BY id DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/reports', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO lab_reports (pet_id,test_type,custom_test_type,file_url,file_type,original_filename,notes) VALUES (?,?,?,?,?,?,?)',
      [req.params.petId, d.testType || '', d.customTestType || null, d.fileUrl || null, d.fileType === 'pdf' ? 'pdf' : 'image', d.originalFilename || null, d.notes || null]);
    res.json({ data: { id: r.insertId, petId: Number(req.params.petId), ...d } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/reports/:id', authMiddleware, async (req, res) => {
  try { const { notes } = req.body; await db.query('UPDATE lab_reports SET notes=? WHERE id=?', [notes ?? null, req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/reports/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM lab_reports WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ VETERINARIANS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/veterinarians', authMiddleware, async (req, res) => {
  try {
    const [emp] = await db.query('SELECT id, name FROM employees WHERE position LIKE "%vet%" OR designation LIKE "%vet%" OR LOWER(name) LIKE "%vet%"');
    const empDocs = emp.map(e => ({ id: e.id, name: String(e.name).trim() }));
    const [appt] = await db.query('SELECT DISTINCT doctor as name FROM appointments WHERE doctor IS NOT NULL AND doctor != ""');
    const apptNames = appt.map(a => String(a.name).trim()).filter(n => n.length);
    const empNames = empDocs.map(d => d.name);
    const extras = apptNames.filter((n, i, arr) => arr.indexOf(n) === i && !empNames.includes(n))
      .map((n, i) => ({ id: -(i + 1), name: n }));
    res.json({ data: [...empDocs, ...extras] });
  } catch { res.json({ data: [] }); }
});

// â”€â”€â”€ REMINDERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/reminders', authMiddleware, async (req, res) => {
  try { const { today } = req.query; let q = 'SELECT * FROM reminders WHERE is_dismissed=0', params = [];
    if (today) { q += ' AND remind_on<=?'; params.push(today); }
    q += ' ORDER BY remind_on ASC'; const [rows] = await db.query(q, params); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/reminders/by-entity', authMiddleware, async (req, res) => {
  try { const { entityType, entityId } = req.query; const [rows] = await db.query('SELECT * FROM reminders WHERE entity_type=? AND entity_id=? AND is_dismissed=0 ORDER BY remind_on ASC LIMIT 1', [entityType, entityId]); res.json({ data: rows[0] ? toCamel(rows[0]) : null }); }
  catch { res.json({ data: null }); }
});
app.get('/api/reminders/by-entity/list', authMiddleware, async (req, res) => {
  try { const { entityType, entityId } = req.query; const [rows] = await db.query('SELECT * FROM reminders WHERE entity_type=? AND entity_id=? AND is_dismissed=0 ORDER BY remind_on ASC', [entityType, entityId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.put('/api/reminders', authMiddleware, async (req, res) => {
  try { const d = req.body; const [r] = await db.query('INSERT INTO reminders (entity_type,entity_id,remind_on,note,due_date,doctor,pet_name,client_name,contact_number) VALUES (?,?,?,?,?,?,?,?,?)',
    [d.entityType||'pet', d.entityId||0, d.remindOn||d.remind_on||null, d.note||'', d.dueDate||d.due_date||null, d.doctor||'', d.petName||d.pet_name||'', d.clientName||d.client_name||'', d.contactNumber||d.contact_number||'']);
    res.json({ data: { id: r.insertId, ...d } }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/reminders/:id/dismiss', authMiddleware, async (req, res) => { try { await db.query('UPDATE reminders SET is_dismissed=1 WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.patch('/api/reminders/:id', authMiddleware, async (req, res) => {
  try { const d = req.body; const fields=[], vals=[];
    for (const [k,v] of Object.entries(d)) { if (['remind_on','note','due_date','doctor','is_dismissed'].includes(k)) { fields.push(`${k}=?`); vals.push(v); } }
    if (fields.length) { vals.push(req.params.id); await db.query(`UPDATE reminders SET ${fields.join(',')} WHERE id=?`, vals); }
    res.json({ data: { id: P(req.params.id), ...d } }); } catch { res.json({ success: true }); }
});
app.delete('/api/reminders/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM reminders WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.delete('/api/reminders', authMiddleware, async (req, res) => { try { const { entityType, entityId } = req.query; await db.query('DELETE FROM reminders WHERE entity_type=? AND entity_id=?', [entityType, entityId]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.get('/api/reminder-notifications', authMiddleware, async (req, res) => { try { const [rows] = await db.query('SELECT * FROM reminders WHERE is_dismissed=0 AND remind_on<=CURDATE() ORDER BY remind_on ASC');
  res.json({ success: true, notifications: rows.map(r => ({ id:r.id, entityType:r.entity_type, petName:r.pet_name, clientName:r.client_name, note:r.note, remindOn:r.remind_on, dueDate:r.due_date, doctor:r.doctor, firedAt:new Date().toISOString(), isRead:false })), unreadCount: rows.length }); }
  catch { res.json({ success: true, notifications: [], unreadCount: 0 }); } });
app.patch('/api/reminder-notifications/:id/read', authMiddleware, (req, res) => res.json({ success: true }));

// â”€â”€â”€ REPORTS (financial) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/reports', authMiddleware, async (req, res) => {
  try {
    const { startDate, endDate, period } = req.query;
    const hasRange = !!(startDate || endDate);
    const range = [];
    let rangeWhere = '';
    if (startDate) { range.push(startDate); rangeWhere += ' AND created_at >= ?'; }
    if (endDate) { range.push(endDate + ' 23:59:59'); rangeWhere += ' AND created_at <= ?'; }

    const [rev] = await db.query(`SELECT COALESCE(SUM(amount_paid),0) as total FROM billing WHERE status="PAID" ${rangeWhere}`, range);
    const [exp] = await db.query(`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE 1=1 ${rangeWhere.replaceAll('created_at', 'date')}`, range);
    const [apts] = await db.query(`SELECT COUNT(*) as total FROM appointments WHERE 1=1 ${rangeWhere.replaceAll('created_at', 'appointment_date')}`, range);
    const [clts] = await db.query(`SELECT COUNT(*) as total FROM clients WHERE 1=1 ${rangeWhere.replaceAll('created_at', 'created_at')}`, range);
    const [pets] = await db.query('SELECT COUNT(*) as total FROM pets');
    // bucket start: requested range start if given, else 11 months ago
    let bucketStart = new Date();
    bucketStart.setDate(1);
    if (startDate) {
      const y = Math.max(2000, parseInt(startDate.slice(0, 4), 10) || 2000);
      const m = Math.max(1, Math.min(12, parseInt(startDate.slice(5, 7), 10) || 1));
      bucketStart = new Date(y, m - 1, 1);
    } else {
      bucketStart = new Date(bucketStart.getFullYear(), bucketStart.getMonth() - 11, 1);
    }
    let bucketEnd = endDate ? new Date(endDate.slice(0, 4), (parseInt(endDate.slice(5, 7), 10) || 1), 1) : new Date();
    if (bucketEnd < bucketStart) bucketEnd = bucketStart;

    // last N months revenue + expenses inside the range
    const [mrev] = await db.query(`SELECT DATE_FORMAT(created_at, '%Y-%m') as ym, COALESCE(SUM(amount_paid),0) as revenue FROM billing WHERE status='PAID' ${rangeWhere} GROUP BY ym`, range);
    const [mexp] = await db.query(`SELECT DATE_FORMAT(date, '%Y-%m') as ym, COALESCE(SUM(amount),0) as expenses FROM expenses WHERE 1=1 ${rangeWhere.replaceAll('created_at', 'date')} GROUP BY ym`, range);
    const revByMonth = {}, expByMonth = {};
    mrev.forEach(r => revByMonth[r.ym] = Number(r.revenue)); mexp.forEach(r => expByMonth[r.ym] = Number(r.expenses));
    const monthlyRevenue = [];
    const d0 = bucketStart;
    let months = 0;
    while (d0 <= bucketEnd && months < 24) {
      const ym = `${d0.getFullYear()}-${String(d0.getMonth()+1).padStart(2,'0')}`;
      monthlyRevenue.push({ month: d0.toLocaleString('en', { month: 'short' }), revenue: revByMonth[ym] || 0, expenses: expByMonth[ym] || 0, targetRevenue: 0 });
      months++;
      d0.setMonth(d0.getMonth() + 1);
    }
    const [svc] = await db.query(`SELECT s.service_name as name, COUNT(*) as count, COALESCE(SUM(s.quantity*s.rate),0) as revenue FROM appointment_services s GROUP BY s.service_name ORDER BY revenue DESC LIMIT 10`);
    const svcC = toCamel(svc);
    const svcTotal = svcC.reduce((s, r) => s + Number(r.revenue), 0) || 1;
    const serviceBreakdown = svcC.map(r => ({ ...r, percentage: Math.round((Number(r.revenue) / svcTotal) * 1000) / 10 }));
    // recent transactions
    const [recent] = await db.query(`SELECT b.customer_name, b.pet_name, b.final_total, b.amount_paid, b.status, b.invoice_no, b.created_at,
      (SELECT i.name FROM billing_items i WHERE i.billing_id=b.id ORDER BY i.id LIMIT 1) as service
      FROM billing b ORDER BY b.id DESC LIMIT 6`);
    const recentTransactions = toCamel(recent).map(r => ({ client: r.customerName || '-', pet: r.petName || '-', service: r.service || 'Payment', type: r.status || 'PAID', amount: Number(r.amountPaid) || 0, invoice: r.invoiceNo, date: r.createdAt }));
    // new clients per month (last 6 months)
    const growStart = new Date(bucketEnd); growStart.setMonth(growStart.getMonth() - 5); growStart.setDate(1);
    const gs = `${growStart.getFullYear()}-${String(growStart.getMonth()+1).padStart(2,'0')}-01`;
    const [grow] = await db.query(`SELECT DATE_FORMAT(created_at, '%Y-%m') as ym, COUNT(*) as newClients FROM clients WHERE created_at >= ? GROUP BY ym`, [gs]);
    const growByMonth = {}; grow.forEach(r => growByMonth[r.ym] = Number(r.newClients));
    const clientGrowth = [];
    const d1 = new Date(growStart);
    for (let i = 5; i >= 0; i--) {
      const d = new Date(d1.getFullYear(), d1.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      clientGrowth.push({ month: d.toLocaleString('en', { month: 'short' }), newClients: growByMonth[ym] || 0, revenue: revByMonth[ym] || 0 });
    }
    res.json({ data: { monthlyRevenue, totalRevenue: Number(rev[0].total), grossRevenue: Number(rev[0].total), totalExpenses: Number(exp[0].total), totalAppointments: Number(apts[0].total), totalBilling: Number(rev[0].total), appointmentRevenue: Number(rev[0].total), billingRevenue: 0, totalClients: Number(clts[0].total), totalPets: Number(pets[0].total), serviceBreakdown, recentTransactions, topServices: serviceBreakdown, clientGrowth } });
  } catch (e) { console.error('[reports]', e.message); res.json({ data: { monthlyRevenue:[],totalRevenue:0,grossRevenue:0,totalExpenses:0,totalAppointments:0,totalBilling:0,appointmentRevenue:0,billingRevenue:0,totalClients:0,totalPets:0,serviceBreakdown:[],recentTransactions:[],topServices:[],clientGrowth:[] } }); }
});

// â”€â”€â”€ FORMS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function formPagesOf(formRow) {
  if (!formRow) return null;
  return {
    id: formRow.id,
    name: formRow.name,
    branchId: formRow.branch_id,
    thumbnailUrl: formRow.thumbnail_url,
    createdByName: formRow.created_by,
    createdAt: formRow.created_at,
    updatedAt: formRow.updated_at,
    pageCount: null,
    pages: [],
  };
}

app.get('/api/forms', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 12, search = '' } = req.query;
    const pg = P(page), sz = P(pageSize) || 12;
    let where = '1=1', params = [];
    if (search) { where += ' AND f.name LIKE ?'; params.push(`%${search}%`); }
    const [count] = await db.query(`SELECT COUNT(*) cnt FROM forms f WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT f.*, COALESCE((SELECT COUNT(*) FROM form_pages fp WHERE fp.form_id = f.id), 0) as pageCount
       FROM forms f WHERE ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    const data = rows.map((r) => ({
      id: r.id, name: r.name, branchId: r.branch_id, pageCount: r.pageCount,
      thumbnailUrl: r.thumbnail_url, createdByName: r.created_by,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
    res.json(paginate(data, count[0].cnt, pg, sz));
  } catch (e) { console.error('[forms]', e.message); res.json(EMPTY); }
});
app.post('/api/forms', authMiddleware, async (req, res) => {
  try {
    const { name, branchId, pages, thumbnailUrl } = req.body;
    const [r] = await db.query('INSERT INTO forms (name, branch_id, thumbnail_url, created_by) VALUES (?,?,?,?)',
      [name || 'Untitled Form', branchId ?? null, thumbnailUrl || null, 'Owner']);
    const formId = r.insertId;
    const pageRows = Array.isArray(pages) ? pages : [];
    for (let i = 0; i < pageRows.length; i++) {
      await db.query('INSERT INTO form_pages (form_id, page_index, image_url, fields) VALUES (?,?,?,?)',
        [formId, i, pageRows[i].imageUrl || pageRows[i].image_url || null,
         pageRows[i].fields ? JSON.stringify(pageRows[i].fields) : null]);
    }
    const [created] = await db.query('SELECT * FROM forms WHERE id=?', [formId]);
    res.json({ data: formPagesOf(created) });
  } catch (e) { console.error('[forms POST]', e.message); res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/forms/:id', authMiddleware, async (req, res) => {
  try {
    const [forms] = await db.query('SELECT * FROM forms WHERE id=?', [req.params.id]);
    if (!forms.length) return res.status(404).json({ error: { message: 'Not found' } });
    const [pages] = await db.query('SELECT * FROM form_pages WHERE form_id=? ORDER BY page_index', [req.params.id]);
    const data = {
      id: forms[0].id, name: forms[0].name, branchId: forms[0].branch_id,
      thumbnailUrl: forms[0].thumbnail_url, createdByName: forms[0].created_by,
      createdAt: forms[0].created_at, updatedAt: forms[0].updated_at,
      pageCount: pages.length,
      pages: pages.map((p) => ({
        id: p.id, imageUrl: p.image_url, fields: p.fields ? JSON.parse(p.fields) : [],
      })),
    };
    res.json({ data });
  } catch (e) { console.error('[forms GET]', e.message); res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/forms/:id', authMiddleware, async (req, res) => {
  try {
    const formId = req.params.id;
    const { name, branchId, pages, thumbnailUrl } = req.body;
    const F = [], V = [];
    if (name !== undefined) { F.push('name=?'); V.push(name); }
    if (branchId !== undefined) { F.push('branch_id=?'); V.push(branchId ?? null); }
    if (thumbnailUrl !== undefined) { F.push('thumbnail_url=?'); V.push(thumbnailUrl); }
    if (F.length) await db.query(`UPDATE forms SET ${F.join(',')} WHERE id=?`, [...V, formId]);
    if (pages !== undefined) {
      await db.query('DELETE FROM form_pages WHERE form_id=?', [formId]);
      for (let i = 0; i < pages.length; i++) {
        await db.query('INSERT INTO form_pages (form_id, page_index, image_url, fields) VALUES (?,?,?,?)',
          [formId, i, pages[i].imageUrl || pages[i].image_url || null,
           pages[i].fields ? JSON.stringify(pages[i].fields) : null]);
      }
    }
    res.json({ success: true });
  } catch (e) { console.error('[forms PATCH]', e.message); res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/forms/:id', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM form_pages WHERE form_id=?', [req.params.id]);
    await db.query('DELETE FROM forms WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

// â”€â”€â”€ BANK ACCOUNTS / PAYMENT SUBMISSIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/bank-accounts', authMiddleware, (req, res) => res.json({ data: [] }));
app.get('/api/clinics/me/payment-submissions', authMiddleware, (req, res) => res.json(EMPTY));
app.post('/api/clinics/me/payment-submissions', authMiddleware, (req, res) => res.json({ success: true }));

// â”€â”€â”€ BOARDING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const STAY_SELECT = `SELECT s.*, p.pet_name, p.species, p.breed, p.is_neutered, c.client_name, c.contact_number,
  cu.unit_label, cu.cage_type_id, ct.type_name, ct.is_free_area, sv.name as service_name, sv.base_rate as service_rate
  FROM boarding_stays s
  LEFT JOIN pets p ON s.pet_id=p.id
  LEFT JOIN clients c ON s.client_id=c.id
  LEFT JOIN cage_units cu ON s.cage_unit_id=cu.id
  LEFT JOIN cage_types ct ON cu.cage_type_id=ct.id
  LEFT JOIN services sv ON s.service_id=sv.id`;

function boardingStay(row) {
  if (!row) return null;
  return toCamel(row);
}
function unitRowsWithStatus() {
  return db.query(`SELECT cu.id as id, cu.cage_type_id, cu.unit_label, cu.is_active, ct.type_name, ct.is_free_area,
    st.id as stay_id, st.date_in, st.expected_checkout_date, st.requires_monitoring, st.needs_vaccination, st.needs_deworming,
    st.owner_provides_food,
    CASE WHEN st.expected_checkout_date = CURDATE() THEN 1 ELSE 0 END as active_checkout_today,
    p.id as pet_id, p.pet_name, p.species, p.is_neutered, c.client_name, c.contact_number
    FROM cage_units cu
    JOIN cage_types ct ON cu.cage_type_id=ct.id
    LEFT JOIN boarding_stays st ON cu.id=st.cage_unit_id AND st.status='ACTIVE'
    LEFT JOIN pets p ON st.pet_id=p.id
    LEFT JOIN clients c ON st.client_id=c.id
    WHERE cu.is_active=1 ORDER BY CAST(cu.unit_label AS SIGNED), cu.id`);
}

app.get('/api/boarding/space-types', authMiddleware, async (req, res) => {
  try {
    const [types] = await db.query('SELECT ct.*, (SELECT COUNT(*) FROM cage_units u WHERE u.cage_type_id=ct.id AND u.is_active=1) as active_unit_count FROM cage_types ct ORDER BY ct.id');
    res.json({ data: toCamel(types) });
  } catch { res.json({ data: [] }); }
});
app.post('/api/boarding/space-types', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const isFree = !!(d.isFreeArea ?? d.is_free_area);
    const typeName = d.typeName || d.type_name || '';
    const qty = isFree ? 0 : (Math.max(0, Number(d.quantity) || 0));
    const [r] = await db.query('INSERT INTO cage_types (branch_id,type_name,is_free_area,quantity) VALUES (?,?,?,?)', [d.branchId || d.branch_id || null, typeName, isFree ? 1 : 0, isFree ? 1 : qty]);
    const units = isFree ? 1 : qty;
    for (let i = 1; i <= units; i++) {
      await db.query('INSERT INTO cage_units (cage_type_id,unit_label) VALUES (?,?)', [r.insertId, isFree ? (typeName || 'Free') : String(i)]);
    }
    const [types] = await db.query('SELECT ct.*, (SELECT COUNT(*) FROM cage_units u WHERE u.cage_type_id=ct.id AND u.is_active=1) as active_unit_count FROM cage_types ct WHERE ct.id=?', [r.insertId]);
    res.json({ data: toCamel(types[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/boarding/space-types/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const tName = d.typeName ?? d.type_name;
    if (tName !== undefined) await db.query('UPDATE cage_types SET type_name=? WHERE id=?', [tName, req.params.id]);
    const qRaw = d.quantity ?? d.quantity_num;
    if (qRaw !== undefined) {
      const qty = Math.max(0, Number(qRaw) || 0);
      await db.query('UPDATE cage_types SET quantity=? WHERE id=?', [qty, req.params.id]);
      await db.query('UPDATE cage_units SET is_active = CASE WHEN CAST(unit_label AS SIGNED) <= ? THEN 1 ELSE 0 END WHERE cage_type_id=? AND unit_label REGEXP "^(0|[1-9][0-9]*)$"', [qty, req.params.id]);
      const [cnt] = await db.query('SELECT COUNT(*) as n FROM cage_units WHERE cage_type_id=? AND is_active=1', [req.params.id]);
      for (let i = cnt[0].n + 1; i <= qty; i++) {
        await db.query('INSERT INTO cage_units (cage_type_id,unit_label) VALUES (?,?)', [req.params.id, String(i)]);
      }
    }
    const [types] = await db.query('SELECT ct.*, (SELECT COUNT(*) FROM cage_units u WHERE u.cage_type_id=ct.id AND u.is_active=1) as active_unit_count FROM cage_types ct WHERE ct.id=?', [req.params.id]);
    res.json({ data: toCamel(types[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/boarding/space-types/:id', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM cage_units WHERE cage_type_id=?', [req.params.id]);
    await db.query('DELETE FROM cage_types WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.get('/api/boarding/space-units', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT cu.id, cu.cage_type_id, cu.unit_label, ct.type_name, ct.is_free_area FROM cage_units cu JOIN cage_types ct ON cu.cage_type_id=ct.id WHERE cu.is_active=1 ORDER BY CAST(cu.unit_label AS SIGNED), cu.id'); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/space-units/free', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT cu.id, cu.cage_type_id, cu.unit_label, ct.type_name, ct.is_free_area FROM cage_units cu JOIN cage_types ct ON cu.cage_type_id=ct.id WHERE cu.is_active=1 AND cu.id NOT IN (SELECT cage_unit_id FROM boarding_stays WHERE status="ACTIVE" AND cage_unit_id IS NOT NULL) ORDER BY CAST(cu.unit_label AS SIGNED), cu.id'); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/space-units/with-status', authMiddleware, async (req, res) => {
  try { const [rows] = await unitRowsWithStatus(); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/settings', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM boarding_settings ORDER BY id LIMIT 1');
    const s = rows[0] || {};
    res.json({ data: { defaultFeedingIntervalMinutes: s.feeding_interval_minutes ?? 360, defaultMonitoringIntervalMinutes: s.monitoring_interval_minutes ?? 60 } });
  } catch { res.json({ data: { defaultFeedingIntervalMinutes: 360, defaultMonitoringIntervalMinutes: 60 } }); }
});
app.patch('/api/boarding/settings', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [rows] = await db.query('SELECT * FROM boarding_settings ORDER BY id LIMIT 1');
    if (rows.length) await db.query('UPDATE boarding_settings SET feeding_interval_minutes=?,monitoring_interval_minutes=? WHERE id=?', [d.defaultFeedingIntervalMinutes ?? 360, d.defaultMonitoringIntervalMinutes ?? 60, rows[0].id]);
    else await db.query('INSERT INTO boarding_settings (feeding_interval_minutes,monitoring_interval_minutes) VALUES (?,?)', [d.defaultFeedingIntervalMinutes ?? 360, d.defaultMonitoringIntervalMinutes ?? 60]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/boarding/stays', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [pets] = await db.query('SELECT client_id FROM pets WHERE id=?', [d.petId || 0]);
    const clientId = d.clientId || pets[0]?.client_id || null;
    const purpose = d.purposeText || 'BOARDING';
    const [r] = await db.query('INSERT INTO boarding_stays (branch_id,pet_id,client_id,cage_unit_id,service_id,date_in,expected_checkout_date,status,purpose,hospitalization_purpose,requires_monitoring,notes,needs_vaccination,needs_deworming,owner_provides_food,feeding_interval_minutes,monitoring_interval_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [d.branchId || null, d.petId || null, clientId, d.cageUnitId || null, d.serviceId || null, d.dateIn || null, d.expectedCheckoutDate || null, 'ACTIVE', purpose, purpose === 'HOSPITALIZATION' ? purpose : null, d.requiresMonitoring ? 1 : 0, d.notes || null, d.needsVaccination ? 1 : 0, d.needsDeworming ? 1 : 0, d.ownerProvidesFood ? 1 : 0, d.feedingIntervalMinutes || null, d.monitoringIntervalMinutes || null]);
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [r.insertId]);
    res.json({ data: boardingStay(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/boarding/stays/active', authMiddleware, async (req, res) => {
  try {
    const { search, spaceTypeId, purpose } = req.query;
    let where = 's.status="ACTIVE"', params = [];
    if (search) { where += ' AND (p.pet_name LIKE ? OR c.client_name LIKE ? OR cu.unit_label LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (spaceTypeId) { where += ' AND ct.id=?'; params.push(spaceTypeId); }
    if (purpose) { where += ' AND s.purpose=?'; params.push(purpose); }
    const [rows] = await db.query(`${STAY_SELECT} WHERE ${where} ORDER BY s.id DESC`, params);
    res.json({ data: rows.map(boardingStay) });
  } catch { res.json({ data: [] }); }
});
app.get('/api/boarding/stays/:id', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]); if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } }); res.json({ data: boardingStay(rows[0]) }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/boarding/stays/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const F = [], V = [];
    if (d.dateIn !== undefined) { F.push('date_in=?'); V.push(d.dateIn); }
    if (d.expectedCheckoutDate !== undefined) { F.push('expected_checkout_date=?'); V.push(d.expectedCheckoutDate); }
    if (d.serviceId !== undefined) { F.push('service_id=?'); V.push(d.serviceId); }
    if (d.purposeText !== undefined) { F.push('purpose=?'); V.push(d.purposeText); }
    if (d.notes !== undefined) { F.push('notes=?'); V.push(d.notes); }
    if (d.needsVaccination !== undefined) { F.push('needs_vaccination=?'); V.push(d.needsVaccination ? 1 : 0); }
    if (d.needsDeworming !== undefined) { F.push('needs_deworming=?'); V.push(d.needsDeworming ? 1 : 0); }
    if (d.ownerProvidesFood !== undefined) { F.push('owner_provides_food=?'); V.push(d.ownerProvidesFood ? 1 : 0); }
    if (d.feedingIntervalMinutes !== undefined) { F.push('feeding_interval_minutes=?'); V.push(d.feedingIntervalMinutes); }
    if (d.monitoringIntervalMinutes !== undefined) { F.push('monitoring_interval_minutes=?'); V.push(d.monitoringIntervalMinutes); }
    if (F.length) { V.push(req.params.id); await db.query(`UPDATE boarding_stays SET ${F.join(',')} WHERE id=?`, V); }
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    res.json({ data: boardingStay(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/boarding/stays/:id', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM boarding_stays WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.get('/api/boarding/stays/:id/checkout-preview', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    if (!rows.length) return res.json({ data: { nights: 0, total: 0, items: [], serviceName: null, serviceRate: 0 } });
    const s = rows[0];
    const days = s.date_in ? Math.max(1, Math.round((Date.now() - new Date(s.date_in).getTime()) / 86400000)) : 1;
    res.json({ data: { nights: days, total: days * (Number(s.service_rate) || 0), items: [], serviceName: s.service_name || null, serviceRate: Number(s.service_rate) || 0 } });
  } catch { res.json({ data: { nights: 0, total: 0, items: [], serviceName: null, serviceRate: 0 } }); }
});
app.post('/api/boarding/stays/:id/checkout', authMiddleware, async (req, res) => {
  try {
    const d = req.body || {};
    await db.query('UPDATE boarding_stays SET date_out=?,status="CHECKED_OUT" WHERE id=?', [d.dateOut || new Date().toISOString().slice(0, 10), req.params.id]);
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    const s = rows[0] || {};
    const days = s.date_in ? Math.max(1, Math.round((Date.now() - new Date(s.date_in).getTime()) / 86400000)) : 1;
    res.json({ data: { nights: days, serviceName: s.service_name || null, serviceRate: Number(s.service_rate) || 0, branchId: s.branch_id || null } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/boarding/stays/:id/feeding', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [r] = await db.query('INSERT INTO boarding_care_log (stay_id,log_type,logged_by,notes,product_id,item_name,display_name,quantity,price) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.params.id, 'FEEDING', d.loggedBy || null, d.notes || null, d.productId || null, d.itemName || null, d.itemName || null, d.quantity ?? null, d.price ?? null]);
    const [rows] = await db.query('SELECT * FROM boarding_care_log WHERE id=?', [r.insertId]);
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/boarding/stays/:id/care-log', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT l.*, m.drug_name as medication_name, m.product_id as med_product_id FROM boarding_care_log l LEFT JOIN boarding_medications m ON l.medication_id=m.id WHERE l.stay_id=? ORDER BY l.logged_at DESC', [req.params.id]);
    res.json({ data: toCamel(rows).map(r => ({ ...r, medicationName: r.medicationName || null })) });
  } catch { res.json({ data: [] }); }
});
app.post('/api/boarding/stays/:id/medications', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [r] = await db.query('INSERT INTO boarding_medications (stay_id,drug_name,dose,interval_minutes,product_id,quantity,price,is_active,started_at) VALUES (?,?,?,?,?,?,?,1,NOW())',
      [req.params.id, d.drugName || '', d.dose || null, d.intervalMinutes || null, d.productId || null, d.quantity ?? null, d.price ?? null]);
    const [rows] = await db.query('SELECT * FROM boarding_medications WHERE id=?', [r.insertId]);
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/boarding/stays/:id/medications', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM boarding_medications WHERE stay_id=? AND is_active=1 ORDER BY id', [req.params.id]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/boarding/medications/:id/administer', authMiddleware, async (req, res) => {
  try {
    const [meds] = await db.query('SELECT * FROM boarding_medications WHERE id=?', [req.params.id]);
    const m = meds[0] || {};
    const [r] = await db.query('INSERT INTO boarding_care_log (stay_id,log_type,notes,medication_id,product_id,display_name,quantity,price) VALUES (?,?,?,?,?,?,?,?)',
      [m.stay_id || null, 'MEDICATION', req.body?.notes || null, req.params.id, m.product_id || null, m.drug_name || null, m.quantity ?? null, m.price ?? null]);
    const [rows] = await db.query('SELECT * FROM boarding_care_log WHERE id=?', [r.insertId]);
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/boarding/medications/:id/discontinue', authMiddleware, async (req, res) => {
  try { await db.query('UPDATE boarding_medications SET is_active=0,discontinued_at=NOW() WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.post('/api/boarding/stays/:id/payment', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [stays] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    const s = stays[0] || {};
    const cart = Array.isArray(d.productsCart) ? d.productsCart : [];
    const serviceTotal = (() => { const days = s.date_in ? Math.max(1, Math.round((Date.now() - new Date(s.date_in).getTime()) / 86400000)) : 1; return days * (Number(s.service_rate) || 0); })();
    const productTotal = cart.reduce((sum, c) => sum + (Number(c.total) || (Number(c.cartQty) || 1) * (Number(c.price) || 0)), 0);
    const subtotal = serviceTotal + productTotal;
    const percentDisc = Number(d.manualDiscountPercent) || 0;
    const fixedDisc = Number(d.manualDiscountFixed) || 0;
    const couponDisc = 0;
    const discount = Math.min(subtotal, (subtotal * percentDisc / 100) + fixedDisc + couponDisc);
    const finalTotal = Math.max(0, subtotal - discount);
    const amountPaid = Number(d.amount) || finalTotal;
    const paymentMode = d.paymentMode === 'CARD_PAYMENT' ? 'CARD' : (d.paymentMode === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH');
    const status = amountPaid >= finalTotal && finalTotal > 0 ? 'PAID' : (amountPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
    const [did] = await db.query('INSERT INTO billing (client_id,customer_name,subtotal,discount,final_total,amount_paid,status,payment_mode,invoice_no) VALUES (?,?,?,?,?,?,?,?,?)',
      [s.client_id || null, s.client_name || '', subtotal, discount, finalTotal, amountPaid, status, paymentMode, 'BRD-' + Date.now()]);
    await db.query('UPDATE boarding_stays SET billing_id=?,amount_paid=?,payment_mode=? WHERE id=?', [did.insertId, amountPaid, paymentMode, req.params.id]);
    res.json({ data: { stayId: Number(req.params.id), billingId: did.insertId, subtotal, discount, finalTotal, amountPaid, status } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/boarding/stays/:id/consent-payload', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    const s = rows[0]; if (!s) return res.json({ data: {} });
    res.json({ data: { ownerName: s.client_name, ownerPhone: s.contact_number, ownerAddress: null, petName: s.pet_name, species: s.species, breed: s.breed, color: null, sex: null, isNeutered: s.is_neutered, dropOffDate: s.date_in, pickupDate: s.expected_checkout_date || s.date_out, needsVaccination: s.needs_vaccination, needsDeworming: s.needs_deworming } });
  } catch { res.json({ data: {} }); }
});
const boardingSummaryData = (s) => ({
  branchId: s.branch_id, cageLabel: s.unit_label, petName: s.pet_name, clientName: s.client_name,
  dateIn: s.date_in, dateOut: s.date_out || null, diagnosis: s.notes || null, conditionStatus: null,
  isDailySummary: false, summaryDateFrom: null, summaryDateTo: null,
  timeline: [], purpose: s.purpose, hospitalizationPurpose: s.hospitalization_purpose,
  requiresMonitoring: !!s.requires_monitoring, serviceName: s.service_name || null, serviceRate: s.service_rate != null ? Number(s.service_rate) : null,
});
app.get('/api/boarding/stays/:id/summary-payload', authMiddleware, async (req, res) => {
  try {
    const { dailyOnly, from, to } = req.query;
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    const s = rows[0]; if (!s) return res.json({ data: {} });
    const d = boardingSummaryData(s);
    d.isDailySummary =!!dailyOnly; d.summaryDateFrom = from || null; d.summaryDateTo = to || null;
    const [log] = await db.query('SELECT * FROM boarding_care_log WHERE stay_id=? ORDER BY logged_at DESC LIMIT 20', [req.params.id]);
    d.timeline = toCamel(log).map(l => ({ type: l.logType, timestamp: l.loggedAt, description: l.displayName || l.itemName || l.notes || '', loggedBy: l.loggedBy || null }));
    res.json({ data: d });
  } catch { res.json({ data: {} }); }
});
app.get('/api/boarding/pets/:petId/stays', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(`${STAY_SELECT} WHERE s.pet_id=? ORDER BY s.id DESC`, [req.params.petId]); res.json({ data: rows.map(boardingStay) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/stays/:id/vitals-history', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM soap_notes WHERE boarding_stay_id=? ORDER BY id DESC', [req.params.id]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/stays/:id/exists', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT id FROM soap_notes WHERE boarding_stay_id=? LIMIT 1', [req.params.id]); res.json({ exists: rows.length > 0 }); }
  catch { res.json({ exists: false }); }
});
app.post('/api/boarding/stays/:id/save-invoice', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/boarding/preview-checkout-invoice', authMiddleware, (req, res) => res.json({ data: {} }));
app.post('/api/boarding/print-checkout-invoice', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/boarding/preview-consent-form', authMiddleware, (req, res) => res.json({ data: {} }));
app.post('/api/boarding/print-consent-form', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/boarding/preview-hospitalization-summary', authMiddleware, (req, res) => res.json({ data: {} }));
app.post('/api/boarding/print-hospitalization-summary', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/boarding/preview-daily-summary', authMiddleware, (req, res) => res.json({ data: {} }));
app.post('/api/boarding/print-daily-summary', authMiddleware, (req, res) => res.json({ success: true }));

// â”€â”€â”€ AI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/ai/refine-reminder-note', authMiddleware, (req, res) => res.json({ text: req.body.text }));
app.post('/api/ai/refine-soap-text', authMiddleware, (req, res) => res.json({ text: req.body.text }));
app.post('/api/ai/scan-product-image', authMiddleware, (req, res) => res.json({ products: [] }));

// â”€â”€â”€ DISCOUNT RANGE / TIME FORMAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/discount-range', authMiddleware, (req, res) => res.json({ min: 0, max: 50 }));
app.get('/api/time-format', authMiddleware, (req, res) => res.json({ use12Hour: false }));

// â”€â”€â”€ CATCH-ALL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€ PLATFORM SUPER ADMIN (registered before the /api catch-all) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
registerSuperAdmin(app, {
  platConn, getClinicConn, createClinicDatabase, bcrypt, makeToken, okClinicSession,
  DB_NAME, CLINIC_PREFIX,
});

app.all('/api/{*splat}', (req, res) => {
  const m = req.method.toUpperCase();
  if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') res.json({ success: true });
  else res.json({ data: [], total: 0 });
});

// â”€â”€â”€ START â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = 4000;

function startServer(port) {
  const p = port || PORT;
  const listen = () => new Promise((resolve) => {
    const srv = app.listen(p, () => {
      console.log(`PodVet API server running on port ${p}`);
      resolve(true);
    });
    srv.on('error', (e) => {
      console.error(`PodVet API server listen error: ${e.message} â€” another server on port ${p} will be used`);
      resolve(true);
    });
  });
  let dbRetry = null;
  const keepRetryingDb = () => {
    if (dbRetry) return;
    dbRetry = setInterval(async () => {
      try {
        await connectDB();
        clearInterval(dbRetry);
        dbRetry = null;
        console.log('MySQL recovered; API is functional again');
      } catch (e) { /* still down, keep retrying */ }
    }, 3000);
    if (dbRetry.unref) dbRetry.unref();
  };
  return connectDB().then(listen).catch(e => {
    console.error('DB connection failed:', e.message);
    console.error('API will retry MySQL in the background and serve DB routes once it is reachable.');
    keepRetryingDb();
    return listen();
  });
}

module.exports = { app, startServer };

// Auto-start when run directly (not required as module)
if (require.main === module) {
  startServer();
}
