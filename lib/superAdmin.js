// ─── Platform Super Admin ────────────────────────────────────────────────────
// Separate trust boundary from the clinic app. Own credentials table
// (platform_admins), own HMAC-signed session tokens, own API namespace
// (/api/super-admin/*) and its own UI served at /super-admin. It never runs
// clinic-scoped queries through the request ALS — it talks to the platform DB
// and to individual clinic DBs by id, always writing an audit-log entry.
const crypto = require('crypto');

const SETTING_SECRET = 'super_admin_secret';

// ── schema ───────────────────────────────────────────────────────────────────
async function ensureColumn(platConn, dbName, table, column, definition) {
  const [rows] = await platConn.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
    [dbName, table, column],
  );
  if (!rows[0].n) await platConn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
}

async function ensureSuperAdminSchema(platConn, dbName) {
  // Staff who can log into /super-admin. Deliberately separate from `users` so
  // a compromised clinic account can never reach platform controls.
  await platConn.query(`CREATE TABLE IF NOT EXISTS platform_admins (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    username VARCHAR(190) NOT NULL,
    email VARCHAR(190) DEFAULT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'super_admin',
    is_active TINYINT NOT NULL DEFAULT 1,
    last_login DATETIME DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_platform_admin_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await platConn.query(`CREATE TABLE IF NOT EXISTS roles (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    scope VARCHAR(20) NOT NULL DEFAULT 'platform',
    description VARCHAR(255) DEFAULT NULL,
    is_system TINYINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await platConn.query(`CREATE TABLE IF NOT EXISTS role_permissions (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    role_id INT NOT NULL,
    module VARCHAR(80) NOT NULL,
    can_view TINYINT NOT NULL DEFAULT 0,
    can_create TINYINT NOT NULL DEFAULT 0,
    can_edit TINYINT NOT NULL DEFAULT 0,
    can_delete TINYINT NOT NULL DEFAULT 0,
    can_export TINYINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_role_module (role_id, module)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await platConn.query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    admin_id INT DEFAULT NULL,
    admin_name VARCHAR(255) DEFAULT NULL,
    clinic_id INT DEFAULT NULL,
    action VARCHAR(80) NOT NULL,
    module VARCHAR(80) DEFAULT NULL,
    target_type VARCHAR(80) DEFAULT NULL,
    target_id VARCHAR(80) DEFAULT NULL,
    old_value TEXT DEFAULT NULL,
    new_value TEXT DEFAULT NULL,
    ip VARCHAR(64) DEFAULT NULL,
    user_agent VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_created (created_at),
    INDEX idx_audit_clinic (clinic_id),
    INDEX idx_audit_admin (admin_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await platConn.query(`CREATE TABLE IF NOT EXISTS plans (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) NOT NULL,
    monthly_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    yearly_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    max_employees INT DEFAULT NULL,
    max_branches INT DEFAULT NULL,
    max_patients INT DEFAULT NULL,
    storage_limit_mb INT DEFAULT NULL,
    is_active TINYINT NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_plan_code (code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await platConn.query(`CREATE TABLE IF NOT EXISTS platform_settings (
    setting_key VARCHAR(120) NOT NULL PRIMARY KEY,
    setting_value TEXT DEFAULT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Clinic master-control columns on the existing platform `clinics` table.
  const clinicCols = [
    ['status', "VARCHAR(20) NOT NULL DEFAULT 'active'"],
    ['plan', "VARCHAR(50) NOT NULL DEFAULT 'trial'"],
    ['subscription_start', 'DATE DEFAULT NULL'],
    ['subscription_expiry', 'DATE DEFAULT NULL'],
    ['owner_name', 'VARCHAR(255) DEFAULT NULL'],
    ['owner_email', 'VARCHAR(190) DEFAULT NULL'],
    ['owner_phone', 'VARCHAR(60) DEFAULT NULL'],
    ['address', 'VARCHAR(255) DEFAULT NULL'],
    ['city', 'VARCHAR(120) DEFAULT NULL'],
    ['country', 'VARCHAR(120) DEFAULT NULL'],
    ['logo', 'VARCHAR(255) DEFAULT NULL'],
    ['registration_date', 'DATE DEFAULT NULL'],
    ['branches_count', 'INT NOT NULL DEFAULT 0'],
    ['employees_count', 'INT NOT NULL DEFAULT 0'],
    ['clients_count', 'INT NOT NULL DEFAULT 0'],
    ['patients_count', 'INT NOT NULL DEFAULT 0'],
    ['storage_used', 'BIGINT NOT NULL DEFAULT 0'],
    ['last_login', 'DATETIME DEFAULT NULL'],
    ['notes', 'TEXT DEFAULT NULL'],
  ];
  for (const [col, def] of clinicCols) await ensureColumn(platConn, dbName, 'clinics', col, `\`${col}\` ${def}`);

  // Seed default platform roles + starter plans (idempotent).
  const [roleCount] = await platConn.query('SELECT COUNT(*) AS n FROM roles');
  if (!roleCount[0].n) {
    const defaults = [
      ['Platform Owner / Root Super Admin', 'root_super_admin', 1, 'Unrestricted platform access'],
      ['Super Admin', 'super_admin', 1, 'Full platform management'],
      ['Support Admin', 'support_admin', 1, 'Support tickets and read-only monitoring'],
    ];
    for (const [name, scope, isSystem, description] of defaults) {
      await platConn.query('INSERT INTO roles (name, scope, description, is_system) VALUES (?,?,?,?)', [name, scope, description, isSystem]);
    }
  }
  const [planCount] = await platConn.query('SELECT COUNT(*) AS n FROM plans');
  if (!planCount[0].n) {
    const plans = [
      ['Free Trial', 'trial', 0, 0, 3, 1, 100, 512, 0],
      ['Basic', 'basic', 29, 290, 5, 1, 1000, 2048, 1],
      ['Standard', 'standard', 59, 590, 15, 3, 5000, 10240, 2],
      ['Pro', 'pro', 99, 990, 50, 10, 25000, 51200, 3],
      ['Enterprise', 'enterprise', 199, 1990, null, null, null, null, 4],
    ];
    for (const p of plans) {
      await platConn.query(
        'INSERT INTO plans (name, code, monthly_price, yearly_price, max_employees, max_branches, max_patients, storage_limit_mb, sort_order) VALUES (?,?,?,?,?,?,?,?,?)',
        p,
      );
    }
  }

  await platConn.query(
    `INSERT INTO platform_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = setting_value`,
    [SETTING_SECRET, crypto.randomBytes(32).toString('hex')],
  );
}

async function bootstrapSuperAdmin(platConn, bcrypt, log) {
  const [rows] = await platConn.query('SELECT COUNT(*) AS n FROM platform_admins');
  if (rows[0].n) return;
  const username = process.env.SUPER_ADMIN_USERNAME || 'superadmin';
  const email = process.env.SUPER_ADMIN_EMAIL || 'superadmin@podvet.local';
  let password = process.env.SUPER_ADMIN_PASSWORD || '';
  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(password, 10);
  await platConn.query(
    'INSERT INTO platform_admins (name, username, email, password, role) VALUES (?,?,?,?,?)',
    ['Platform Owner', username, email, hash, 'root_super_admin'],
  );
  const out = log || console.log;
  out('==================================================================');
  out('  SUPER ADMIN BOOTSTRAPPED');
  out(`    URL      : /super-admin`);
  out(`    username : ${username}`);
  if (generated) out(`    password : ${password}`);
  else out('    password : (from SUPER_ADMIN_PASSWORD)');
  out('  Change this after first login (Account → Profile).');
  out('==================================================================');
}

// ── tokens (HMAC-SHA256, signed with a persisted platform secret) ────────────
let _secretCache = null;
async function getSecret(platConn) {
  if (_secretCache) return _secretCache;
  const [rows] = await platConn.query('SELECT setting_value FROM platform_settings WHERE setting_key = ?', [SETTING_SECRET]);
  if (rows.length && rows[0].setting_value) {
    _secretCache = rows[0].setting_value;
    return _secretCache;
  }
  const s = crypto.randomBytes(32).toString('hex');
  await platConn.query(
    'INSERT INTO platform_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [SETTING_SECRET, s],
  );
  _secretCache = s;
  return s;
}

function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function makePlatformToken(admin, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: admin.id,
    typ: 'platform',
    role: admin.role,
    name: admin.name,
    iat: Date.now(),
    exp: Date.now() + 12 * 60 * 60 * 1000,
  })).toString('base64url');
  return `${header}.${payload}.${hmac(`${header}.${payload}`, secret)}`;
}

function verifyPlatformToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = hmac(`${parts[0]}.${parts[1]}`, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || payload.typ !== 'platform' || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const P = (v) => parseInt(v, 10) || 0;
const maskAdmin = (a) => ({ id: a.id, name: a.name, username: a.username, email: a.email, role: a.role, lastLogin: a.last_login });

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || null;
}

module.exports = { ensureSuperAdminSchema, bootstrapSuperAdmin, registerSuperAdmin };

function registerSuperAdmin(app, deps) {
  const { platConn, getClinicConn, createClinicDatabase, bcrypt, CLINIC_PREFIX, DB_NAME } = deps;

  async function audit(req, { action, module, targetType, targetId, oldValue, newValue, clinicId }) {
    try {
      await platConn.query(
        `INSERT INTO audit_logs
          (admin_id, admin_name, clinic_id, action, module, target_type, target_id, old_value, new_value, ip, user_agent)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          req.admin?.sub ?? null,
          req.admin?.name ?? null,
          clinicId ?? null,
          action,
          module || null,
          targetType || null,
          targetId != null ? String(targetId) : null,
          oldValue != null ? JSON.stringify(oldValue) : null,
          newValue != null ? JSON.stringify(newValue) : null,
          clientIp(req),
          String(req.headers['user-agent'] || '').slice(0, 255) || null,
        ],
      );
    } catch (_) { /* auditing must never break the request */ }
  }

  function superAuth(req, res, next) {
    (async () => {
      try {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const secret = await getSecret(platConn);
        const payload = verifyPlatformToken(token, secret);
        if (!payload) return res.status(401).json({ error: { message: 'Unauthorized', code: 'SUPER_ADMIN_UNAUTHORIZED' } });
        req.admin = payload;
        next();
      } catch (e) {
        res.status(500).json({ error: { message: e.message } });
      }
    })();
  }

  async function clinicRow(id) {
    const [rows] = await platConn.query('SELECT * FROM clinics WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async function clinicCounts(clinicId) {
    try {
      const conn = await getClinicConn(clinicId);
      const [[c]] = await conn.query(
        `SELECT
           (SELECT COUNT(*) FROM clients) AS clients,
           (SELECT COUNT(*) FROM pets) AS patients,
           (SELECT COUNT(*) FROM appointments) AS appointments,
           (SELECT COUNT(*) FROM employees) AS employees,
           (SELECT COUNT(*) FROM branches) AS branches`,
      );
      return {
        clients: Number(c.clients) || 0,
        patients: Number(c.patients) || 0,
        appointments: Number(c.appointments) || 0,
        employees: Number(c.employees) || 0,
        branches: Number(c.branches) || 0,
      };
    } catch (_) {
      return { clients: 0, patients: 0, appointments: 0, employees: 0, branches: 0 };
    }
  }

  const toRow = (r) => ({
    id: r.id,
    clinicName: r.clinic_name,
    slug: r.slug,
    status: r.status || 'active',
    plan: r.plan || 'trial',
    subscriptionStart: r.subscription_start,
    subscriptionExpiry: r.subscription_expiry,
    ownerName: r.owner_name,
    ownerEmail: r.owner_email,
    ownerPhone: r.owner_phone,
    address: r.address,
    city: r.city,
    country: r.country,
    logo: r.logo,
    registrationDate: r.registration_date || r.created_at,
    branchesCount: Number(r.branches_count) || 0,
    employeesCount: Number(r.employees_count) || 0,
    clientsCount: Number(r.clients_count) || 0,
    patientsCount: Number(r.patients_count) || 0,
    storageUsed: Number(r.storage_used) || 0,
    lastLogin: r.last_login,
    notes: r.notes,
    createdAt: r.created_at,
  });

  // ── auth ───────────────────────────────────────────────────────────────────
  app.post('/api/super-admin/login', async (req, res) => {
    try {
      const identifier = String(req.body.identifier || req.body.username || '').trim();
      const password = String(req.body.password || '');
      if (!identifier || !password) return res.status(400).json({ error: { message: 'Username and password are required' } });
      const [rows] = await platConn.query('SELECT * FROM platform_admins WHERE username = ? OR email = ?', [identifier, identifier]);
      if (!rows.length) return res.status(401).json({ error: { message: 'Invalid credentials' } });
      const a = rows[0];
      if (!a.is_active) return res.status(403).json({ error: { message: 'This account is disabled' } });
      const valid = await bcrypt.compare(password, a.password);
      if (!valid) return res.status(401).json({ error: { message: 'Invalid credentials' } });
      await platConn.query('UPDATE platform_admins SET last_login = NOW() WHERE id = ?', [a.id]);
      const secret = await getSecret(platConn);
      const token = makePlatformToken(a, secret);
      await platConn.query(
        `INSERT INTO audit_logs (admin_id, admin_name, action, module, ip, user_agent) VALUES (?,?,?,?,?,?)`,
        [a.id, a.name, 'login', 'auth', clientIp(req), String(req.headers['user-agent'] || '').slice(0, 255) || null],
      );
      res.json({ token, admin: maskAdmin({ ...a, last_login: new Date() }) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // ── unified / role-based login (single login page) ───────────────────────────
  // One form: platform-admins land in /super-admin, clinic users in /app.
  app.post('/api/login', async (req, res) => {
    try {
      const identifier = String(req.body.identifier || req.body.username || '').trim();
      const password = String(req.body.password || '');
      if (!identifier || !password) return res.status(400).json({ error: { message: 'Username and password are required' } });

      // 1) Super Admin (platform staff)
      const [pa] = await platConn.query('SELECT * FROM platform_admins WHERE username = ? OR email = ?', [identifier, identifier]);
      if (pa.length) {
        const a = pa[0];
        if (!a.is_active) return res.status(403).json({ error: { message: 'This account is disabled' } });
        const ok = await bcrypt.compare(password, a.password);
        if (!ok) return res.status(401).json({ error: { message: 'Invalid credentials' } });
        await platConn.query('UPDATE platform_admins SET last_login = NOW() WHERE id = ?', [a.id]);
        const secret = await getSecret(platConn);
        await platConn.query(
          'INSERT INTO audit_logs (admin_id, admin_name, action, module, ip, user_agent) VALUES (?,?,?,?,?,?)',
          [a.id, a.name, 'login', 'auth', clientIp(req), String(req.headers['user-agent'] || '').slice(0, 255) || null],
        );
        return res.json({ type: 'super_admin', token: makePlatformToken(a, secret), admin: maskAdmin({ ...a, last_login: new Date() }) });
      }

      // 2) Clinic user
      const [rows] = await platConn.query('SELECT * FROM users WHERE username = ? OR email = ?', [identifier, identifier]);
      if (!rows.length) return res.status(401).json({ error: { message: 'Invalid credentials' } });
      const u = rows[0];
      const valid = await bcrypt.compare(password, u.password);
      if (!valid) return res.status(401).json({ error: { message: 'Invalid credentials' } });
      const clinicId = u.clinic_id || 1;
      const [cl] = await platConn.query('SELECT status FROM clinics WHERE id = ?', [clinicId]);
      const status = cl.length ? cl[0].status : 'active';
      if (status === 'suspended' || status === 'disabled') {
        return res.status(403).json({ error: { message: `This clinic is ${status}. Please contact platform support.` } });
      }
      await platConn.query('UPDATE clinics SET last_login = NOW() WHERE id = ?', [clinicId]);
      const token = deps.makeToken(u.id, clinicId);
      const session = deps.okClinicSession ? await deps.okClinicSession(u, clinicId) : {};
      return res.json({ type: 'clinic', accessToken: token, refreshToken: token, ...session });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/api/super-admin/me', superAuth, async (req, res) => {
    try {
      const [rows] = await platConn.query('SELECT * FROM platform_admins WHERE id = ?', [req.admin.sub]);
      if (!rows.length) return res.status(404).json({ error: { message: 'Not found' } });
      res.json({ admin: maskAdmin(rows[0]) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/api/super-admin/logout', superAuth, async (req, res) => {
    await audit(req, { action: 'logout', module: 'auth' });
    res.json({ success: true });
  });

  app.post('/api/super-admin/change-password', superAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!newPassword || String(newPassword).length < 8) {
        return res.status(400).json({ error: { message: 'New password must be at least 8 characters' } });
      }
      const [rows] = await platConn.query('SELECT * FROM platform_admins WHERE id = ?', [req.admin.sub]);
      if (!rows.length) return res.status(404).json({ error: { message: 'Not found' } });
      const valid = await bcrypt.compare(String(currentPassword || ''), rows[0].password);
      if (!valid) return res.status(400).json({ error: { message: 'Current password is incorrect' } });
      const hash = await bcrypt.hash(String(newPassword), 10);
      await platConn.query('UPDATE platform_admins SET password = ? WHERE id = ?', [hash, req.admin.sub]);
      await audit(req, { action: 'change_password', module: 'auth' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // ── dashboard ──────────────────────────────────────────────────────────────
  let statsCache = { at: 0, data: null };
  async function collectStats() {
    if (statsCache.data && Date.now() - statsCache.at < 30000) return statsCache.data;
    const [statusRows] = await platConn.query('SELECT status, COUNT(*) AS n FROM clinics GROUP BY status');
    const byStatus = { active: 0, trial: 0, suspended: 0, disabled: 0 };
    for (const r of statusRows) if (r.status in byStatus) byStatus[r.status] = Number(r.n);
    const totalClinics = Object.values(byStatus).reduce((s, n) => s + n, 0);

    const [[{ n: totalAdmins }]] = await platConn.query('SELECT COUNT(*) AS n FROM platform_admins');
    const [[{ n: totalUsers }]] = await platConn.query('SELECT COUNT(*) AS n FROM users');

    const [clinicIdRows] = await platConn.query('SELECT id, plan, status, created_at FROM clinics');
    let totalClients = 0, totalPatients = 0, totalAppointments = 0;
    for (const c of clinicIdRows) {
      const counts = await clinicCounts(c.id);
      totalClients += counts.clients;
      totalPatients += counts.patients;
      totalAppointments += counts.appointments;
      try {
        await platConn.query(
          'UPDATE clinics SET clients_count=?, patients_count=?, employees_count=?, branches_count=? WHERE id=?',
          [counts.clients, counts.patients, counts.employees, counts.branches, c.id],
        );
      } catch (_) {}
    }

    const [planRows] = await platConn.query('SELECT code, monthly_price FROM plans');
    const priceByCode = {};
    for (const p of planRows) priceByCode[p.code] = Number(p.monthly_price) || 0;
    let mrr = 0;
    for (const c of clinicIdRows) if (c.status === 'active') mrr += priceByCode[c.plan] || 0;

    // clinic growth: per-month registration for the last 12 months
    const [growthRows] = await platConn.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) AS n
       FROM clinics WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
       GROUP BY ym ORDER BY ym`,
    );
    const growthMap = {};
    for (const r of growthRows) growthMap[r.ym] = Number(r.n);
    const clinicGrowth = [];
    const revenueGrowth = [];
    const now = new Date();
    let cumulative = 0;
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const n = growthMap[ym] || 0;
      cumulative += n;
      clinicGrowth.push({ month: ym, count: n, total: cumulative });
      revenueGrowth.push({ month: ym, amount: mrr });
    }

    const [recentRows] = await platConn.query('SELECT * FROM clinics ORDER BY created_at DESC LIMIT 6');
    const [expiringRows] = await platConn.query(
      `SELECT * FROM clinics
       WHERE subscription_expiry IS NOT NULL
         AND subscription_expiry BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
       ORDER BY subscription_expiry ASC LIMIT 8`,
    );
    const [alertRows] = await platConn.query(
      `SELECT * FROM clinics WHERE status IN ('suspended','disabled') ORDER BY updated_at DESC LIMIT 5`,
    ).catch(() => [[]]);

    const data = {
      cards: {
        totalClinics,
        activeClinics: byStatus.active,
        trialClinics: byStatus.trial,
        suspendedClinics: byStatus.suspended + byStatus.disabled,
        totalAdmins,
        totalUsers,
        totalClients,
        totalPatients,
        totalAppointments,
        mrr,
      },
      charts: { clinicGrowth, revenueGrowth },
      recentClinics: recentRows.map(toRow),
      expiringSubscriptions: expiringRows.map(toRow),
      systemAlerts: Array.isArray(alertRows) ? alertRows.map(toRow) : [],
    };
    statsCache = { at: Date.now(), data };
    return data;
  }

  app.get('/api/super-admin/stats', superAuth, async (req, res) => {
    try { res.json(await collectStats()); }
    catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // ── clinics ────────────────────────────────────────────────────────────────
  app.get('/api/super-admin/clinics', superAuth, async (req, res) => {
    try {
      const pg = P(req.query.page) || 1;
      const sz = Math.min(P(req.query.pageSize) || 20, 100);
      const search = String(req.query.search || '').trim();
      const status = String(req.query.status || '').trim();
      const plan = String(req.query.plan || '').trim();
      const where = [];
      const params = [];
      if (search) {
        where.push('(clinic_name LIKE ? OR slug LIKE ? OR owner_name LIKE ? OR owner_email LIKE ? OR owner_phone LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (status) { where.push('status = ?'); params.push(status); }
      if (plan) { where.push('plan = ?'); params.push(plan); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [[{ total }]] = await platConn.query(`SELECT COUNT(*) AS total FROM clinics ${whereSql}`, params);
      const [rows] = await platConn.query(
        `SELECT * FROM clinics ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, sz, (pg - 1) * sz],
      );
      res.json({ data: rows.map(toRow), total: Number(total), page: pg, pageSize: sz, totalPages: Math.ceil(Number(total) / sz) || 1 });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/api/super-admin/clinics/:id', superAuth, async (req, res) => {
    try {
      const row = await clinicRow(P(req.params.id));
      if (!row) return res.status(404).json({ error: { message: 'Clinic not found' } });
      const counts = await clinicCounts(row.id);
      const [users] = await platConn.query(
        'SELECT id, name, username, email, role, created_at FROM users WHERE clinic_id = ? ORDER BY id ASC LIMIT 50',
        [row.id],
      );
      const [logs] = await platConn.query(
        'SELECT * FROM audit_logs WHERE clinic_id = ? ORDER BY id DESC LIMIT 20',
        [row.id],
      );
      res.json({ clinic: { ...toRow(row), ...counts }, users: users.map((u) => ({ id: u.id, name: u.name, username: u.username, email: u.email, role: u.role, createdAt: u.created_at })), auditLogs: logs });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/api/super-admin/clinics', superAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const clinicName = String(b.clinicName || '').trim();
      if (!clinicName) return res.status(400).json({ error: { message: 'Clinic name is required' } });
      const ownerName = String(b.ownerName || 'Owner').trim();
      const username = String(b.ownerUsername || b.username || '').trim();
      const email = String(b.ownerEmail || b.email || '').trim();
      let password = String(b.ownerPassword || b.password || '').trim();
      const generated = !password;
      if (generated) password = crypto.randomBytes(6).toString('base64url');
      if (!username) return res.status(400).json({ error: { message: 'Owner username is required' } });
      const [dup] = await platConn.query('SELECT id FROM users WHERE username = ?', [username]);
      if (dup.length) return res.status(409).json({ error: { message: 'Username already exists' } });
      const hash = await bcrypt.hash(password, 10);
      const status = ['active', 'trial', 'suspended', 'disabled'].includes(b.status) ? b.status : 'trial';
      const plan = String(b.plan || 'trial');
      const [reg] = await platConn.query(
        `INSERT INTO clinics
          (clinic_name, slug, status, plan, subscription_start, subscription_expiry,
           owner_name, owner_email, owner_phone, address, city, country, registration_date)
         VALUES (?,?,?,?,CURDATE(), DATE_ADD(CURDATE(), INTERVAL 14 DAY),?,?,?,?,?,?,CURDATE())`,
        [clinicName, 'podvet', status, plan, ownerName, email || null, b.ownerPhone || null, b.address || null, b.city || null, b.country || null],
      );
      const clinicId = reg.insertId;
      await createClinicDatabase(clinicId, clinicName);
      await platConn.query(
        `INSERT INTO users (name, username, email, password, role, phone_number, clinic_id)
         VALUES (?,?,?,?, 'OWNER', ?, ?)`,
        [ownerName, username, email || `${username}@podvet.local`, hash, b.ownerPhone || null, clinicId],
      );
      await audit(req, { action: 'create_clinic', module: 'clinics', targetType: 'clinic', targetId: clinicId, newValue: { clinicName, status, plan }, clinicId });
      statsCache = { at: 0, data: null };
      res.status(201).json({ clinic: toRow(await clinicRow(clinicId)), owner: { username, password: generated ? password : undefined } });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.patch('/api/super-admin/clinics/:id', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      const before = await clinicRow(id);
      if (!before) return res.status(404).json({ error: { message: 'Clinic not found' } });
      const map = {
        clinicName: 'clinic_name', ownerName: 'owner_name', ownerEmail: 'owner_email', ownerPhone: 'owner_phone',
        address: 'address', city: 'city', country: 'country', logo: 'logo', notes: 'notes', plan: 'plan',
        subscriptionStart: 'subscription_start', subscriptionExpiry: 'subscription_expiry',
      };
      const sets = [];
      const params = [];
      for (const [key, col] of Object.entries(map)) {
        if (req.body[key] !== undefined) { sets.push(`\`${col}\` = ?`); params.push(req.body[key] === '' ? null : req.body[key]); }
      }
      if (req.body.status !== undefined && ['active', 'trial', 'suspended', 'disabled'].includes(req.body.status)) {
        sets.push('status = ?'); params.push(req.body.status);
      }
      if (!sets.length) return res.status(400).json({ error: { message: 'Nothing to update' } });
      params.push(id);
      await platConn.query(`UPDATE clinics SET ${sets.join(', ')} WHERE id = ?`, params);
      const after = await clinicRow(id);
      await audit(req, { action: 'update_clinic', module: 'clinics', targetType: 'clinic', targetId: id, oldValue: toRow(before), newValue: toRow(after), clinicId: id });
      statsCache = { at: 0, data: null };
      res.json({ clinic: toRow(after) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/api/super-admin/clinics/:id/status', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      const status = String(req.body.status || '');
      if (!['active', 'trial', 'suspended', 'disabled'].includes(status)) {
        return res.status(400).json({ error: { message: 'Invalid status' } });
      }
      const before = await clinicRow(id);
      if (!before) return res.status(404).json({ error: { message: 'Clinic not found' } });
      await platConn.query('UPDATE clinics SET status = ? WHERE id = ?', [status, id]);
      await audit(req, { action: `clinic_${status}`, module: 'clinics', targetType: 'clinic', targetId: id, oldValue: { status: before.status }, newValue: { status }, clinicId: id });
      statsCache = { at: 0, data: null };
      res.json({ clinic: toRow(await clinicRow(id)) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/api/super-admin/clinics/:id/extend', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      const days = P(req.body.days) || 30;
      const before = await clinicRow(id);
      if (!before) return res.status(404).json({ error: { message: 'Clinic not found' } });
      await platConn.query(
        `UPDATE clinics
         SET subscription_expiry = DATE_ADD(GREATEST(COALESCE(subscription_expiry, CURDATE()), CURDATE()), INTERVAL ? DAY),
             subscription_start = COALESCE(subscription_start, CURDATE()),
             status = IF(status = 'suspended', 'active', status)
         WHERE id = ?`,
        [days, id],
      );
      const after = await clinicRow(id);
      await audit(req, { action: 'extend_subscription', module: 'subscriptions', targetType: 'clinic', targetId: id, oldValue: { subscriptionExpiry: before.subscription_expiry }, newValue: { subscriptionExpiry: after.subscription_expiry, days }, clinicId: id });
      res.json({ clinic: toRow(after) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/api/super-admin/clinics/:id/reset-admin-password', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      const [owners] = await platConn.query(
        `SELECT id, name, username FROM users WHERE clinic_id = ? ORDER BY (role = 'OWNER') DESC, id ASC LIMIT 1`,
        [id],
      );
      if (!owners.length) return res.status(404).json({ error: { message: 'No clinic admin found' } });
      let password = String(req.body.password || '').trim();
      const generated = !password;
      if (generated) password = crypto.randomBytes(6).toString('base64url');
      const hash = await bcrypt.hash(password, 10);
      await platConn.query('UPDATE users SET password = ? WHERE id = ?', [hash, owners[0].id]);
      await audit(req, { action: 'reset_admin_password', module: 'clinics', targetType: 'user', targetId: owners[0].id, newValue: { username: owners[0].username }, clinicId: id });
      res.json({ user: { id: owners[0].id, name: owners[0].name, username: owners[0].username }, password: generated ? password : undefined });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // Impersonation: hand back a normal clinic session token for this clinic's
  // owner so platform staff can "Login as Clinic Admin". Always audited.
  app.post('/api/super-admin/clinics/:id/impersonate', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      const [owners] = await platConn.query(
        `SELECT id, name, username, email, role FROM users WHERE clinic_id = ? ORDER BY (role = 'OWNER') DESC, id ASC LIMIT 1`,
        [id],
      );
      if (!owners.length) return res.status(404).json({ error: { message: 'No clinic user to impersonate' } });
      const token = deps.makeToken(owners[0].id, id);
      await audit(req, { action: 'impersonate_clinic', module: 'clinics', targetType: 'clinic', targetId: id, newValue: { asUser: owners[0].username }, clinicId: id });
      res.json({ accessToken: token, refreshToken: token, clinicId: id, user: { id: owners[0].id, name: owners[0].name, username: owners[0].username, email: owners[0].email } });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.delete('/api/super-admin/clinics/:id', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      if (id === 1) return res.status(400).json({ error: { message: 'The default clinic cannot be archived' } });
      const before = await clinicRow(id);
      if (!before) return res.status(404).json({ error: { message: 'Clinic not found' } });
      await platConn.query("UPDATE clinics SET status = 'disabled' WHERE id = ?", [id]);
      await audit(req, { action: 'archive_clinic', module: 'clinics', targetType: 'clinic', targetId: id, oldValue: { status: before.status }, newValue: { status: 'disabled' }, clinicId: id });
      statsCache = { at: 0, data: null };
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // ── plans ──────────────────────────────────────────────────────────────────
  app.get('/api/super-admin/plans', superAuth, async (req, res) => {
    try {
      const [rows] = await platConn.query('SELECT * FROM plans ORDER BY sort_order ASC, id ASC');
      res.json({ data: rows.map((p) => ({
        id: p.id, name: p.name, code: p.code, monthlyPrice: Number(p.monthly_price), yearlyPrice: Number(p.yearly_price),
        maxEmployees: p.max_employees, maxBranches: p.max_branches, maxPatients: p.max_patients,
        storageLimitMb: p.storage_limit_mb, isActive: !!p.is_active, sortOrder: p.sort_order,
      })) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/api/super-admin/plans', superAuth, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.name || !b.code) return res.status(400).json({ error: { message: 'Plan name and code are required' } });
      const [r] = await platConn.query(
        `INSERT INTO plans (name, code, monthly_price, yearly_price, max_employees, max_branches, max_patients, storage_limit_mb, is_active, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [b.name, String(b.code).toLowerCase(), b.monthlyPrice || 0, b.yearlyPrice || 0, b.maxEmployees || null, b.maxBranches || null, b.maxPatients || null, b.storageLimitMb || null, b.isActive === false ? 0 : 1, b.sortOrder || 0],
      );
      await audit(req, { action: 'create_plan', module: 'subscriptions', targetType: 'plan', targetId: r.insertId, newValue: b });
      res.status(201).json({ id: r.insertId });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.patch('/api/super-admin/plans/:id', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      const map = { name: 'name', monthlyPrice: 'monthly_price', yearlyPrice: 'yearly_price', maxEmployees: 'max_employees', maxBranches: 'max_branches', maxPatients: 'max_patients', storageLimitMb: 'storage_limit_mb', sortOrder: 'sort_order' };
      const sets = [];
      const params = [];
      for (const [k, col] of Object.entries(map)) if (req.body[k] !== undefined) { sets.push(`\`${col}\` = ?`); params.push(req.body[k]); }
      if (req.body.isActive !== undefined) { sets.push('is_active = ?'); params.push(req.body.isActive ? 1 : 0); }
      if (!sets.length) return res.status(400).json({ error: { message: 'Nothing to update' } });
      params.push(id);
      await platConn.query(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`, params);
      await audit(req, { action: 'update_plan', module: 'subscriptions', targetType: 'plan', targetId: id, newValue: req.body });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // ── roles & permissions ────────────────────────────────────────────────────
  const MODULES = ['dashboard', 'clinics', 'branches', 'users', 'roles', 'plans', 'subscriptions', 'billing', 'coupons', 'features', 'integrations', 'notifications', 'templates', 'announcements', 'reports', 'analytics', 'support', 'audit_logs', 'security', 'settings', 'branding', 'storage', 'backups', 'system_health', 'referral'];

  app.get('/api/super-admin/roles', superAuth, async (req, res) => {
    try {
      const [rows] = await platConn.query('SELECT * FROM roles ORDER BY is_system DESC, id ASC');
      res.json({ data: rows.map((r) => ({ id: r.id, name: r.name, scope: r.scope, description: r.description, isSystem: !!r.is_system })) , modules: MODULES });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/api/super-admin/roles', superAuth, async (req, res) => {
    try {
      const { name, description } = req.body || {};
      if (!name) return res.status(400).json({ error: { message: 'Role name is required' } });
      const [r] = await platConn.query('INSERT INTO roles (name, scope, description, is_system) VALUES (?, ?, ?, 0)', [name, 'platform', description || null]);
      await audit(req, { action: 'create_role', module: 'roles', targetType: 'role', targetId: r.insertId, newValue: { name } });
      res.status(201).json({ id: r.insertId });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.delete('/api/super-admin/roles/:id', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      const [rows] = await platConn.query('SELECT * FROM roles WHERE id = ?', [id]);
      if (!rows.length) return res.status(404).json({ error: { message: 'Role not found' } });
      if (rows[0].is_system) return res.status(400).json({ error: { message: 'System roles cannot be deleted' } });
      await platConn.query('DELETE FROM role_permissions WHERE role_id = ?', [id]);
      await platConn.query('DELETE FROM roles WHERE id = ?', [id]);
      await audit(req, { action: 'delete_role', module: 'roles', targetType: 'role', targetId: id, oldValue: { name: rows[0].name } });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.get('/api/super-admin/roles/:id/permissions', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      const [rows] = await platConn.query('SELECT * FROM role_permissions WHERE role_id = ?', [id]);
      const byModule = {};
      for (const r of rows) byModule[r.module] = { view: !!r.can_view, create: !!r.can_create, edit: !!r.can_edit, delete: !!r.can_delete, export: !!r.can_export };
      res.json({ modules: MODULES, permissions: byModule });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.put('/api/super-admin/roles/:id/permissions', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      const permissions = (req.body && req.body.permissions) || {};
      for (const [module, p] of Object.entries(permissions)) {
        if (!MODULES.includes(module)) continue;
        await platConn.query(
          `INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE can_view=VALUES(can_view), can_create=VALUES(can_create), can_edit=VALUES(can_edit), can_delete=VALUES(can_delete), can_export=VALUES(can_export)`,
          [id, module, p.view ? 1 : 0, p.create ? 1 : 0, p.edit ? 1 : 0, p.delete ? 1 : 0, p.export ? 1 : 0],
        );
      }
      await audit(req, { action: 'update_permissions', module: 'roles', targetType: 'role', targetId: id, newValue: permissions });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // ── audit logs ─────────────────────────────────────────────────────────────
  app.get('/api/super-admin/audit-logs', superAuth, async (req, res) => {
    try {
      const pg = P(req.query.page) || 1;
      const sz = Math.min(P(req.query.pageSize) || 25, 100);
      const search = String(req.query.search || '').trim();
      const where = [];
      const params = [];
      if (search) { where.push('(admin_name LIKE ? OR action LIKE ? OR module LIKE ? OR target_id LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [[{ total }]] = await platConn.query(`SELECT COUNT(*) AS total FROM audit_logs ${whereSql}`, params);
      const [rows] = await platConn.query(`SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
      res.json({ data: rows, total: Number(total), page: pg, totalPages: Math.ceil(Number(total) / sz) || 1 });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  // ── platform admins (users) ────────────────────────────────────────────────
  app.get('/api/super-admin/admins', superAuth, async (req, res) => {
    try {
      const [rows] = await platConn.query('SELECT * FROM platform_admins ORDER BY id ASC');
      res.json({ data: rows.map(maskAdmin) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/api/super-admin/admins', superAuth, async (req, res) => {
    try {
      const { name, username, email, password, role } = req.body || {};
      if (!name || !username || !password) return res.status(400).json({ error: { message: 'Name, username and password are required' } });
      const hash = await bcrypt.hash(String(password), 10);
      const [r] = await platConn.query(
        'INSERT INTO platform_admins (name, username, email, password, role) VALUES (?,?,?,?,?)',
        [name, username, email || null, hash, role || 'support_admin'],
      );
      await audit(req, { action: 'create_platform_admin', module: 'users', targetType: 'platform_admin', targetId: r.insertId, newValue: { name, username, role } });
      res.status(201).json({ id: r.insertId });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post('/api/super-admin/admins/:id/toggle', superAuth, async (req, res) => {
    try {
      const id = P(req.params.id);
      if (id === req.admin.sub) return res.status(400).json({ error: { message: 'You cannot disable your own account' } });
      const [rows] = await platConn.query('SELECT * FROM platform_admins WHERE id = ?', [id]);
      if (!rows.length) return res.status(404).json({ error: { message: 'Not found' } });
      const next = rows[0].is_active ? 0 : 1;
      await platConn.query('UPDATE platform_admins SET is_active = ? WHERE id = ?', [next, id]);
      await audit(req, { action: next ? 'activate_admin' : 'deactivate_admin', module: 'users', targetType: 'platform_admin', targetId: id });
      res.json({ isActive: !!next });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  return { superAuth, audit, collectStats };
}
