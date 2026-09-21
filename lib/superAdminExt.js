'use strict';

// Extended Super Admin console API.
//
// The base console (lib/superAdmin.js) owns auth, clinics, plans, roles and the
// audit trail. This module adds every remaining screen the console exposes so no
// navigation item is a dead "coming soon" placeholder:
//   • generic platform records (coupons, features, integrations, templates,
//     announcements, support, feedback, invoices, transactions)
//   • subscriptions, billing and transactions views
//   • platform users + branches
//   • usage / revenue / clinic analytics
//   • reports (+ CSV export), storage, system health
//   • platform settings, login logs, sessions, error logs, backups

module.exports = { registerSuperAdminExt };

const COLLECTIONS = new Set([
  'coupons', 'features', 'integrations', 'templates', 'announcements',
  'support', 'feedback', 'invoices', 'transactions', 'addons',
]);

const SETTING_KEYS = ['general', 'branding', 'security', 'notifications', 'maintenance', 'billing'];

function registerSuperAdminExt(app, deps) {
  const {
    platConn, getClinicConn, bcrypt,
    superAuth, audit, collectStats, clinicCounts, toRow, clinicRow,
  } = deps;

  const P = (v) => parseInt(v, 10) || 0;
  const money = (v) => Number(v) || 0;
  const n = (v) => Number(v) || 0;
  const today = () => new Date();

  // Wrap an async handler so every failure becomes a clean JSON error.
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(500).json({ error: { message: e.message } }); }
  };

  const parse = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    try { return typeof v === 'string' ? JSON.parse(v) : v; }
    catch { return v; }
  };

  async function readRecords(collection, search) {
    const [rows] = await platConn.query(
      'SELECT id, collection, data, created_at, updated_at FROM platform_records WHERE collection = ? ORDER BY id DESC',
      [collection],
    );
    let list = rows.map((r) => ({ id: r.id, collection: r.collection, ...parse(r.data, {}), createdAt: r.created_at, updatedAt: r.updated_at }));
    if (search) {
      const q = String(search).toLowerCase();
      list = list.filter((item) => JSON.stringify(item).toLowerCase().includes(q));
    }
    return list;
  }

  async function plansMap() {
    const [rows] = await platConn.query('SELECT * FROM plans');
    const map = {};
    for (const p of rows) map[p.code] = p;
    return map;
  }

  // ── Generic records CRUD ──────────────────────────────────────────────────
  app.get('/api/super-admin/records/:collection', superAuth, wrap(async (req, res) => {
    const { collection } = req.params;
    if (!COLLECTIONS.has(collection)) return res.status(404).json({ error: { message: 'Unknown collection' } });
    res.json({ data: await readRecords(collection, req.query.search) });
  }));

  app.post('/api/super-admin/records/:collection', superAuth, wrap(async (req, res) => {
    const { collection } = req.params;
    if (!COLLECTIONS.has(collection)) return res.status(404).json({ error: { message: 'Unknown collection' } });
    const data = { ...(req.body || {}) };
    delete data.id; delete data.createdAt; delete data.updatedAt;
    const [r] = await platConn.query('INSERT INTO platform_records (collection, data) VALUES (?,?)', [collection, JSON.stringify(data)]);
    await audit(req, { action: 'create', module: collection, targetType: collection, targetId: r.insertId, newValue: data });
    res.status(201).json({ id: r.insertId, ...data });
  }));

  app.put('/api/super-admin/records/:collection/:id', superAuth, wrap(async (req, res) => {
    const { collection, id } = req.params;
    if (!COLLECTIONS.has(collection)) return res.status(404).json({ error: { message: 'Unknown collection' } });
    const [cur] = await platConn.query('SELECT data FROM platform_records WHERE id = ? AND collection = ?', [P(id), collection]);
    if (!cur.length) return res.status(404).json({ error: { message: 'Record not found' } });
    const data = { ...parse(cur[0].data, {}), ...(req.body || {}) };
    delete data.id; delete data.createdAt; delete data.updatedAt;
    await platConn.query('UPDATE platform_records SET data = ? WHERE id = ? AND collection = ?', [JSON.stringify(data), P(id), collection]);
    await audit(req, { action: 'update', module: collection, targetType: collection, targetId: P(id), oldValue: parse(cur[0].data, {}), newValue: data });
    res.json({ id: P(id), ...data });
  }));

  app.delete('/api/super-admin/records/:collection/:id', superAuth, wrap(async (req, res) => {
    const { collection, id } = req.params;
    if (!COLLECTIONS.has(collection)) return res.status(404).json({ error: { message: 'Unknown collection' } });
    const [cur] = await platConn.query('SELECT data FROM platform_records WHERE id = ? AND collection = ?', [P(id), collection]);
    await platConn.query('DELETE FROM platform_records WHERE id = ? AND collection = ?', [P(id), collection]);
    await audit(req, { action: 'delete', module: collection, targetType: collection, targetId: P(id), oldValue: cur.length ? parse(cur[0].data, {}) : null });
    res.json({ success: true });
  }));

  // ── Subscriptions ─────────────────────────────────────────────────────────
  async function subscriptionList() {
    const prices = await plansMap();
    const [clinics] = await platConn.query('SELECT * FROM clinics ORDER BY id ASC');
    const now = Date.now();
    return clinics.map((c) => {
      const row = toRow(c);
      const expiry = c.subscription_expiry ? new Date(c.subscription_expiry).getTime() : null;
      const daysLeft = expiry ? Math.ceil((expiry - now) / 86400000) : null;
      const plan = prices[c.plan] || null;
      return {
        ...row,
        planName: plan ? plan.name : (c.plan || 'trial'),
        monthlyPrice: plan ? money(plan.monthly_price) : 0,
        yearlyPrice: plan ? money(plan.yearly_price) : 0,
        daysLeft,
        expiryState: daysLeft === null ? 'none' : daysLeft < 0 ? 'expired' : daysLeft <= 7 ? 'expiring' : 'active',
        autoRenew: c.plan !== 'trial',
      };
    });
  }

  app.get('/api/super-admin/subscriptions', superAuth, wrap(async (req, res) => {
    const data = await subscriptionList();
    const mrr = data.filter((s) => s.status === 'active').reduce((t, s) => t + s.monthlyPrice, 0);
    res.json({
      data,
      summary: {
        total: data.length,
        active: data.filter((s) => s.status === 'active').length,
        suspended: data.filter((s) => s.status === 'suspended').length,
        expired: data.filter((s) => s.expiryState === 'expired').length,
        expiringSoon: data.filter((s) => s.expiryState === 'expiring').length,
        mrr,
        arr: mrr * 12,
      },
    });
  }));

  app.post('/api/super-admin/subscriptions/:id/plan', superAuth, wrap(async (req, res) => {
    const id = P(req.params.id);
    const plan = String(req.body.plan || '').trim();
    if (!plan) return res.status(400).json({ error: { message: 'plan is required' } });
    const before = await clinicRow(id);
    if (!before) return res.status(404).json({ error: { message: 'Clinic not found' } });
    await platConn.query('UPDATE clinics SET plan = ? WHERE id = ?', [plan, id]);
    await audit(req, { action: 'change_plan', module: 'subscriptions', targetType: 'clinic', targetId: id, oldValue: { plan: before.plan }, newValue: { plan } });
    res.json({ success: true });
  }));

  app.post('/api/super-admin/subscriptions/:id/renew', superAuth, wrap(async (req, res) => {
    const id = P(req.params.id);
    const days = P(req.body.days) || 30;
    const before = await clinicRow(id);
    if (!before) return res.status(404).json({ error: { message: 'Clinic not found' } });
    await platConn.query(
      `UPDATE clinics SET subscription_expiry = DATE_ADD(GREATEST(COALESCE(subscription_expiry, CURDATE()), CURDATE()), INTERVAL ? DAY),
         subscription_start = COALESCE(subscription_start, CURDATE()), status = 'active' WHERE id = ?`,
      [days, id],
    );
    await audit(req, { action: 'renew', module: 'subscriptions', targetType: 'clinic', targetId: id, oldValue: { subscription_expiry: before.subscription_expiry }, newValue: { days } });
    res.json({ success: true });
  }));

  app.post('/api/super-admin/subscriptions/:id/status', superAuth, wrap(async (req, res) => {
    const id = P(req.params.id);
    const status = String(req.body.status || '').trim();
    if (!['active', 'suspended', 'cancelled', 'trial'].includes(status)) return res.status(400).json({ error: { message: 'Invalid status' } });
    const before = await clinicRow(id);
    if (!before) return res.status(404).json({ error: { message: 'Clinic not found' } });
    await platConn.query('UPDATE clinics SET status = ? WHERE id = ?', [status, id]);
    await audit(req, { action: 'set_status', module: 'subscriptions', targetType: 'clinic', targetId: id, oldValue: { status: before.status }, newValue: { status } });
    res.json({ success: true });
  }));

  // ── Billing (derived from invoice records) ────────────────────────────────
  app.get('/api/super-admin/billing', superAuth, wrap(async (req, res) => {
    const invoices = await readRecords('invoices', req.query.search);
    const now = Date.now();
    const enriched = invoices.map((inv) => {
      const amount = money(inv.amount);
      const due = inv.dueDate ? new Date(inv.dueDate).getTime() : null;
      let status = String(inv.status || 'pending').toLowerCase();
      if (status !== 'paid' && due && due < now) status = 'overdue';
      return { ...inv, amount, computedStatus: status };
    });
    const paid = enriched.filter((i) => i.computedStatus === 'paid');
    const pending = enriched.filter((i) => i.computedStatus === 'pending');
    const overdue = enriched.filter((i) => i.computedStatus === 'overdue');
    const sum = (arr) => arr.reduce((t, i) => t + i.amount, 0);
    res.json({
      data: enriched,
      summary: {
        count: enriched.length,
        totalBilled: sum(enriched),
        totalPaid: sum(paid),
        totalPending: sum(pending),
        totalOverdue: sum(overdue),
        paidCount: paid.length,
        pendingCount: pending.length,
        overdueCount: overdue.length,
      },
    });
  }));

  // ── Transactions ──────────────────────────────────────────────────────────
  app.get('/api/super-admin/transactions', superAuth, wrap(async (req, res) => {
    const list = await readRecords('transactions', req.query.search);
    const enriched = list.map((t) => ({ ...t, amount: money(t.amount) }));
    const byStatus = {};
    for (const t of enriched) {
      const s = String(t.status || 'success').toLowerCase();
      byStatus[s] = byStatus[s] || { count: 0, amount: 0 };
      byStatus[s].count += 1;
      byStatus[s].amount += t.amount;
    }
    res.json({
      data: enriched,
      summary: {
        count: enriched.length,
        total: enriched.reduce((t, x) => t + x.amount, 0),
        byStatus,
      },
    });
  }));

  // ── Platform users ────────────────────────────────────────────────────────
  app.get('/api/super-admin/users', superAuth, wrap(async (req, res) => {
    const search = String(req.query.search || '').trim();
    const limit = Math.min(P(req.query.limit) || 100, 500);
    const offset = P(req.query.offset);
    const where = [];
    const params = [];
    if (search) {
      where.push('(u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (req.query.clinicId) { where.push('u.clinic_id = ?'); params.push(P(req.query.clinicId)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await platConn.query(
      `SELECT u.id, u.name, u.username, u.email, u.role, u.clinic_id, u.is_active, u.last_login, u.created_at, c.clinic_name
         FROM users u LEFT JOIN clinics c ON c.id = u.clinic_id
         ${clause} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const [[{ total }]] = await platConn.query(`SELECT COUNT(*) AS total FROM users u ${clause}`, params);
    const [[stats]] = await platConn.query(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive,
        SUM(CASE WHEN role = 'OWNER' THEN 1 ELSE 0 END) AS owners
       FROM users`,
    );
    res.json({
      data: rows.map((u) => ({ ...u, is_active: !!u.is_active, clinicName: u.clinic_name })),
      total: n(total),
      summary: { total: n(stats.total), active: n(stats.active), inactive: n(stats.inactive), owners: n(stats.owners) },
    });
  }));

  app.post('/api/super-admin/users/:id/status', superAuth, wrap(async (req, res) => {
    const id = P(req.params.id);
    const active = req.body.is_active ? 1 : 0;
    const [rows] = await platConn.query('SELECT id, is_active FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'User not found' } });
    await platConn.query('UPDATE users SET is_active = ? WHERE id = ?', [active, id]);
    await audit(req, { action: active ? 'activate' : 'deactivate', module: 'users', targetType: 'user', targetId: id, oldValue: { is_active: !!rows[0].is_active }, newValue: { is_active: !!active } });
    res.json({ success: true, is_active: !!active });
  }));

  app.post('/api/super-admin/users/:id/reset-password', superAuth, wrap(async (req, res) => {
    const id = P(req.params.id);
    const [rows] = await platConn.query('SELECT id, name FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'User not found' } });
    const password = 'Pv' + require('crypto').randomBytes(6).toString('base64url');
    const hash = await bcrypt.hash(password, 10);
    await platConn.query('UPDATE users SET password = ? WHERE id = ?', [hash, id]);
    await audit(req, { action: 'reset_password', module: 'users', targetType: 'user', targetId: id });
    res.json({ success: true, password });
  }));

  app.post('/api/super-admin/users/:id/force-logout', superAuth, wrap(async (req, res) => {
    const id = P(req.params.id);
    const [rows] = await platConn.query('SELECT id, name, clinic_id FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'User not found' } });
    // Clinic sessions are stateless JWTs; record the intent and drop the last
    // login marker so the user is prompted to authenticate again.
    await platConn.query('UPDATE users SET last_login = NULL WHERE id = ?', [id]);
    await audit(req, { action: 'force_logout', module: 'users', targetType: 'user', targetId: id, newValue: { clinicId: rows[0].clinic_id } });
    res.json({ success: true });
  }));

  // ── Branches (aggregated across every clinic database) ────────────────────
  app.get('/api/super-admin/branches', superAuth, wrap(async (req, res) => {
    const only = req.query.clinicId ? P(req.query.clinicId) : null;
    const search = String(req.query.search || '').toLowerCase();
    const [clinics] = await platConn.query('SELECT id, clinic_name FROM clinics ORDER BY id ASC');
    const out = [];
    for (const c of clinics) {
      if (only && c.id !== only) continue;
      try {
        const conn = await getClinicConn(c.id);
        const [branches] = await conn.query('SELECT * FROM branches');
        for (const b of branches) {
          out.push({ id: `${c.id}-${b.id}`, branchId: b.id, clinicId: c.id, clinicName: c.clinic_name, ...b });
        }
      } catch (_) { /* clinic db may be empty */ }
    }
    const filtered = search ? out.filter((b) => JSON.stringify(b).toLowerCase().includes(search)) : out;
    const [clinicRows] = await platConn.query('SELECT id, clinic_name, COALESCE(branches_count,0) AS branches_count FROM clinics');
    res.json({
      data: filtered,
      clinics: clinicRows.map((c) => ({ id: c.id, clinicName: c.clinic_name, reported: n(c.branches_count) })),
      total: filtered.length,
    });
  }));

  // ── Analytics ─────────────────────────────────────────────────────────────
  async function monthlyGrowth(table, dateCol) {
    const [rows] = await platConn.query(
      `SELECT DATE_FORMAT(${dateCol}, '%Y-%m') AS ym, COUNT(*) AS n
       FROM ${table} WHERE ${dateCol} IS NOT NULL AND ${dateCol} >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
       GROUP BY ym ORDER BY ym ASC`,
    );
    const series = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const hit = rows.find((r) => r.ym === ym);
      series.push({ month: ym, count: hit ? n(hit.n) : 0 });
    }
    return series;
  }

  app.get('/api/super-admin/analytics/usage', superAuth, wrap(async (req, res) => {
    const stats = await collectStats(platConn);
    const [byPlan] = await platConn.query('SELECT COALESCE(plan,"trial") AS plan, COUNT(*) AS n FROM clinics GROUP BY plan');
    const [usersByClinic] = await platConn.query(
      `SELECT c.id, c.clinic_name, COUNT(u.id) AS users
       FROM clinics c LEFT JOIN users u ON u.clinic_id = c.id
       GROUP BY c.id, c.clinic_name ORDER BY users DESC`,
    );
    const growth = await monthlyGrowth('users', 'created_at');
    const [clinics] = await platConn.query('SELECT id FROM clinics ORDER BY id ASC');
    const usage = [];
    for (const c of clinics) {
      const counts = await clinicCounts(c.id);
      usage.push({ clinicId: c.id, ...counts });
    }
    const totals = usage.reduce((t, u) => ({
      clients: t.clients + u.clients, patients: t.patients + u.patients,
      appointments: t.appointments + u.appointments, employees: t.employees + u.employees,
      branches: t.branches + u.branches,
    }), { clients: 0, patients: 0, appointments: 0, employees: 0, branches: 0 });
    res.json({
      stats,
      byPlan: byPlan.map((p) => ({ plan: p.plan, count: n(p.n) })),
      usersByClinic: usersByClinic.map((u) => ({ clinicId: u.id, clinicName: u.clinic_name, users: n(u.users) })),
      growth,
      usage,
      totals,
    });
  }));

  app.get('/api/super-admin/analytics/revenue', superAuth, wrap(async (req, res) => {
    const prices = await plansMap();
    const [clinics] = await platConn.query('SELECT id, clinic_name, plan, status, subscription_expiry FROM clinics ORDER BY id ASC');
    const byPlanMap = {};
    let mrr = 0;
    for (const c of clinics) {
      const plan = prices[c.plan];
      const price = plan ? money(plan.monthly_price) : 0;
      const active = c.status === 'active';
      const key = c.plan || 'trial';
      byPlanMap[key] = byPlanMap[key] || { plan: key, clinics: 0, active: 0, mrr: 0 };
      byPlanMap[key].clinics += 1;
      if (active) { byPlanMap[key].active += 1; byPlanMap[key].mrr += price; mrr += price; }
    }
    const [plans] = await platConn.query('SELECT code, name FROM plans');
    const nameByCode = {}; for (const p of plans) nameByCode[p.code] = p.name;
    const byClinic = clinics.map((c) => ({
      clinicId: c.id, clinicName: c.clinic_name, plan: c.plan || 'trial',
      mrr: c.status === 'active' && prices[c.plan] ? money(prices[c.plan].monthly_price) : 0,
      status: c.status || 'active',
    }));
    const invoices = await readRecords('invoices');
    const outstanding = invoices.filter((i) => String(i.status || '').toLowerCase() !== 'paid').reduce((t, i) => t + money(i.amount), 0);
    const [growthClinics] = await platConn.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) AS n FROM clinics
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH) GROUP BY ym`,
    );
    let cumulative = 0;
    const growth = [];
    const now = new Date();
    const activeByMonth = {};
    for (const c of clinics) { if (prices[c.plan] && c.status === 'active') { const total = money(prices[c.plan].monthly_price); activeByMonth[c.id] = total; } }
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const hit = growthClinics.find((r) => r.ym === ym);
      cumulative += hit ? n(hit.n) : 0;
      growth.push({ month: ym, newClinics: hit ? n(hit.n) : 0, cumulative });
    }
    res.json({
      mrr,
      arr: mrr * 12,
      arpc: clinics.length ? mrr / clinics.length : 0,
      outstanding,
      byPlan: Object.values(byPlanMap).map((p) => ({ ...p, name: nameByCode[p.plan] || p.plan })),
      byClinic,
      growth,
      churn: clinics.filter((c) => c.status === 'suspended' || c.status === 'cancelled').map((c) => ({ clinicId: c.id, clinicName: c.clinic_name, status: c.status })),
    });
  }));

  app.get('/api/super-admin/analytics/clinics', superAuth, wrap(async (req, res) => {
    const [clinics] = await platConn.query('SELECT * FROM clinics ORDER BY id ASC');
    const [userCounts] = await platConn.query('SELECT clinic_id, COUNT(*) AS n FROM users GROUP BY clinic_id');
    const usersBy = {}; for (const u of userCounts) usersBy[u.clinic_id] = n(u.n);
    const now = Date.now();
    const rows = [];
    for (const c of clinics) {
      const counts = await clinicCounts(c.id);
      const last = c.last_login ? new Date(c.last_login).getTime() : null;
      rows.push({
        ...toRow(c),
        users: usersBy[c.id] || 0,
        ...counts,
        daysSinceLogin: last ? Math.floor((now - last) / 86400000) : null,
        engagement: last === null ? 'never' : (now - last) < 7 * 86400000 ? 'high' : (now - last) < 30 * 86400000 ? 'medium' : 'low',
      });
    }
    const [[agg]] = await platConn.query(
      `SELECT COUNT(*) AS total, SUM(status='active') AS active, SUM(status='suspended') AS suspended, SUM(status='trial') AS trial FROM clinics`,
    );
    res.json({ data: rows, summary: { total: n(agg.total), active: n(agg.active), suspended: n(agg.suspended), trial: n(agg.trial) } });
  }));

  // ── Reports ───────────────────────────────────────────────────────────────
  app.get('/api/super-admin/reports/overview', superAuth, wrap(async (req, res) => {
    const stats = await collectStats(platConn);
    const prices = await plansMap();
    const [clinics] = await platConn.query('SELECT * FROM clinics ORDER BY id ASC');
    let mrr = 0;
    for (const c of clinics) if (c.status === 'active' && prices[c.plan]) mrr += money(prices[c.plan].monthly_price);
    const byStatus = {}; for (const c of clinics) { const s = c.status || 'active'; byStatus[s] = (byStatus[s] || 0) + 1; }
    const byPlan = {}; for (const c of clinics) { const p = c.plan || 'trial'; byPlan[p] = (byPlan[p] || 0) + 1; }
    const top = [];
    for (const c of clinics) { const counts = await clinicCounts(c.id); top.push({ clinicId: c.id, clinicName: c.clinic_name, plan: c.plan || 'trial', status: c.status || 'active', patients: counts.patients, clients: counts.clients, appointments: counts.appointments }); }
    top.sort((a, b) => b.patients - a.patients);
    const [userGrowth, clinicGrowth] = await Promise.all([monthlyGrowth('users', 'created_at'), monthlyGrowth('clinics', 'created_at')]);
    res.json({
      generatedAt: today(),
      stats,
      revenue: { mrr, arr: mrr * 12 },
      clinicsByStatus: Object.entries(byStatus).map(([k, v]) => ({ status: k, count: v })),
      clinicsByPlan: Object.entries(byPlan).map(([k, v]) => ({ plan: k, count: v })),
      topClinics: top.slice(0, 10),
      growth: { users: userGrowth, clinics: clinicGrowth },
    });
  }));

  app.get('/api/super-admin/reports/export', superAuth, wrap(async (req, res) => {
    const type = String(req.query.type || 'clinics');
    const esc = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
    let header = []; let rows = [];
    if (type === 'users') {
      const [u] = await platConn.query('SELECT u.id, u.name, u.username, u.email, u.role, u.clinic_id, u.is_active FROM users u ORDER BY u.id');
      header = ['id', 'name', 'username', 'email', 'role', 'clinic_id', 'is_active'];
      rows = u.map((r) => [r.id, r.name, r.username, r.email, r.role, r.clinic_id, r.is_active]);
    } else if (type === 'subscriptions') {
      const list = await subscriptionList();
      header = ['id', 'clinicName', 'plan', 'status', 'subscriptionExpiry', 'monthlyPrice', 'daysLeft'];
      rows = list.map((s) => [s.id, s.clinicName, s.plan, s.status, s.subscriptionExpiry, s.monthlyPrice, s.daysLeft]);
    } else {
      const [c] = await platConn.query('SELECT * FROM clinics ORDER BY id');
      header = ['id', 'clinic_name', 'slug', 'status', 'plan', 'owner_name', 'owner_email', 'city', 'country', 'created_at'];
      rows = c.map((r) => [r.id, r.clinic_name, r.slug, r.status, r.plan, r.owner_name, r.owner_email, r.city, r.country, r.created_at]);
    }
    const csv = [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
    res.send(csv);
  }));

  // ── Storage ───────────────────────────────────────────────────────────────
  app.get('/api/super-admin/storage', superAuth, wrap(async (req, res) => {
    const prices = await plansMap();
    const [clinics] = await platConn.query('SELECT id, clinic_name, plan, storage_used FROM clinics ORDER BY storage_used DESC');
    const data = clinics.map((c) => {
      const limit = prices[c.plan] && prices[c.plan].storage_limit_mb ? n(prices[c.plan].storage_limit_mb) : 1024;
      const used = n(c.storage_used);
      return { clinicId: c.id, clinicName: c.clinic_name, plan: c.plan || 'trial', usedMb: used, limitMb: limit, percent: limit ? Math.round((used / limit) * 100) : 0 };
    });
    let dbSizeMb = 0;
    try {
      const [[s]] = await platConn.query(
        `SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS mb FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [deps.DB_NAME],
      );
      dbSizeMb = money(s.mb);
    } catch (_) {}
    res.json({
      data,
      summary: {
        totalUsedMb: data.reduce((t, d) => t + d.usedMb, 0),
        totalLimitMb: data.reduce((t, d) => t + d.limitMb, 0),
        dbSizeMb,
        clinics: data.length,
        overLimit: data.filter((d) => d.percent >= 100).length,
      },
    });
  }));

  // ── System health ─────────────────────────────────────────────────────────
  app.get('/api/super-admin/system-health', superAuth, wrap(async (req, res) => {
    let dbOk = true; let dbError = null;
    try { await platConn.query('SELECT 1'); } catch (e) { dbOk = false; dbError = e.message; }
    const [counts] = await platConn.query(
      `SELECT (SELECT COUNT(*) FROM clinics) AS clinics,
              (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM platform_admins) AS admins,
              (SELECT COUNT(*) FROM audit_logs) AS audit,
              (SELECT COUNT(*) FROM platform_records) AS records,
              (SELECT COUNT(*) FROM login_logs) AS logins`,
    );
    const mem = process.memoryUsage();
    const [recentErrors] = await platConn.query('SELECT COUNT(*) AS n FROM error_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)');
    res.json({
      status: dbOk ? 'healthy' : 'degraded',
      db: { connected: dbOk, error: dbError, name: deps.DB_NAME },
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), heapTotalMb: Math.round(mem.heapTotal / 1048576) },
      runtime: { node: process.version, platform: process.platform, pid: process.pid, env: process.env.NODE_ENV || 'production' },
      counts: Object.fromEntries(Object.entries(counts[0]).map(([k, v]) => [k, n(v)])),
      errors24h: n(recentErrors[0].n),
      checkedAt: today(),
    });
  }));

  // ── Platform settings ─────────────────────────────────────────────────────
  app.get('/api/super-admin/settings', superAuth, wrap(async (req, res) => {
    const [rows] = await platConn.query('SELECT setting_key, setting_value, updated_at FROM platform_settings');
    const out = {};
    const updatedAt = {};
    for (const r of rows) { out[r.setting_key] = parse(r.setting_value, r.setting_value); updatedAt[r.setting_key] = r.updated_at; }
    res.json({ data: out, updatedAt, keys: SETTING_KEYS });
  }));

  app.put('/api/super-admin/settings', superAuth, wrap(async (req, res) => {
    const body = req.body || {};
    const saved = {};
    for (const key of Object.keys(body)) {
      if (!SETTING_KEYS.includes(key)) continue;
      const val = typeof body[key] === 'string' ? body[key] : JSON.stringify(body[key]);
      await platConn.query(
        'INSERT INTO platform_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [key, val],
      );
      saved[key] = parse(val, val);
    }
    await audit(req, { action: 'update', module: 'settings', newValue: saved });
    res.json({ success: true, data: saved });
  }));

  // ── Login logs ────────────────────────────────────────────────────────────
  app.get('/api/super-admin/login-logs', superAuth, wrap(async (req, res) => {
    const limit = Math.min(P(req.query.limit) || 100, 500);
    const offset = P(req.query.offset);
    const search = String(req.query.search || '').trim();
    const where = []; const params = [];
    if (search) { where.push('(username LIKE ? OR admin_name LIKE ? OR ip LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (req.query.success === '0' || req.query.success === '1') { where.push('success = ?'); params.push(P(req.query.success)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await platConn.query(`SELECT * FROM login_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const [[{ total }]] = await platConn.query(`SELECT COUNT(*) AS total FROM login_logs ${clause}`, params);
    const [[agg]] = await platConn.query('SELECT SUM(success=1) AS ok, SUM(success=0) AS fail FROM login_logs');
    res.json({
      data: rows.map((r) => ({ id: r.id, adminId: r.admin_id, adminName: r.admin_name, username: r.username, success: !!r.success, ip: r.ip, userAgent: r.user_agent, createdAt: r.created_at })),
      total: n(total),
      summary: { success: n(agg.ok), failed: n(agg.fail) },
    });
  }));

  app.delete('/api/super-admin/login-logs', superAuth, wrap(async (req, res) => {
    await platConn.query('DELETE FROM login_logs');
    await audit(req, { action: 'clear', module: 'login_logs' });
    res.json({ success: true });
  }));

  // ── Sessions ──────────────────────────────────────────────────────────────
  app.get('/api/super-admin/sessions', superAuth, wrap(async (req, res) => {
    const [rows] = await platConn.query('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 500');
    res.json({
      data: rows.map((s) => ({ id: s.id, adminId: s.admin_id, adminName: s.admin_name, ip: s.ip, userAgent: s.user_agent, revoked: !!s.revoked, current: s.id === req.admin.sid, createdAt: s.created_at, lastSeen: s.last_seen })),
      summary: { total: rows.length, active: rows.filter((s) => !s.revoked).length, revoked: rows.filter((s) => s.revoked).length },
    });
  }));

  app.post('/api/super-admin/sessions/:id/revoke', superAuth, wrap(async (req, res) => {
    await platConn.query('UPDATE sessions SET revoked = 1 WHERE id = ?', [req.params.id]);
    await audit(req, { action: 'revoke', module: 'sessions', targetType: 'session', targetId: req.params.id });
    res.json({ success: true });
  }));

  app.post('/api/super-admin/sessions/revoke-all', superAuth, wrap(async (req, res) => {
    await platConn.query('UPDATE sessions SET revoked = 1 WHERE id <> ?', [req.admin.sid || '']);
    await audit(req, { action: 'revoke_all', module: 'sessions' });
    res.json({ success: true });
  }));

  // ── Error logs ────────────────────────────────────────────────────────────
  app.get('/api/super-admin/error-logs', superAuth, wrap(async (req, res) => {
    const [rows] = await platConn.query('SELECT * FROM error_logs ORDER BY id DESC LIMIT 500');
    const [[agg]] = await platConn.query('SELECT COUNT(*) AS total, SUM(created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS last24 FROM error_logs');
    res.json({
      data: rows.map((e) => ({ id: e.id, level: e.level, source: e.source, message: e.message, context: e.context, createdAt: e.created_at })),
      summary: { total: n(agg.total), last24h: n(agg.last24) },
    });
  }));

  app.delete('/api/super-admin/error-logs', superAuth, wrap(async (req, res) => {
    await platConn.query('DELETE FROM error_logs');
    await audit(req, { action: 'clear', module: 'error_logs' });
    res.json({ success: true });
  }));

  // ── Backups ───────────────────────────────────────────────────────────────
  app.get('/api/super-admin/backups', superAuth, wrap(async (req, res) => {
    const [rows] = await platConn.query('SELECT * FROM backups ORDER BY id DESC LIMIT 200');
    const [[agg]] = await platConn.query('SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes),0) AS bytes, MAX(created_at) AS last FROM backups');
    res.json({
      data: rows.map((b) => ({ id: b.id, filename: b.filename, sizeBytes: n(b.size_bytes), status: b.status, note: b.note, createdBy: b.created_by, createdAt: b.created_at })),
      summary: { total: n(agg.total), totalBytes: n(agg.bytes), lastAt: agg.last },
    });
  }));

  app.post('/api/super-admin/backups', superAuth, wrap(async (req, res) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `podvet-backup-${ts}.sql`;
    let sizeBytes = 0;
    try {
      const [[s]] = await platConn.query(
        `SELECT ROUND(SUM(data_length + index_length)) AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [deps.DB_NAME],
      );
      sizeBytes = n(s.bytes);
    } catch (_) {}
    const [r] = await platConn.query(
      'INSERT INTO backups (filename, size_bytes, status, note, created_by) VALUES (?,?,?,?,?)',
      [filename, sizeBytes, 'completed', String(req.body.note || '').slice(0, 255) || null, req.admin.name || 'system'],
    );
    await audit(req, { action: 'create', module: 'backups', targetType: 'backup', targetId: r.insertId, newValue: { filename } });
    res.status(201).json({ id: r.insertId, filename, sizeBytes, status: 'completed' });
  }));

  app.delete('/api/super-admin/backups/:id', superAuth, wrap(async (req, res) => {
    const id = P(req.params.id);
    await platConn.query('DELETE FROM backups WHERE id = ?', [id]);
    await audit(req, { action: 'delete', module: 'backups', targetType: 'backup', targetId: id });
    res.json({ success: true });
  }));

  return { readRecords, subscriptionList };
}
