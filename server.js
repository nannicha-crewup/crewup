// CrewUp public trial — standalone Node + SQLite server (no npm deps)
// Data lives in crewup.db next to this file. Photos stored as compressed data URLs in DB.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DB_PATH = process.env.DB_PATH || path.join(DIR, 'crewup.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS shops(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, color TEXT, agent_rate REAL, worker_rate REAL, active INTEGER DEFAULT 1, company_name TEXT DEFAULT '', company_address TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS shop_rules(shop_id INTEGER PRIMARY KEY, open_weekdays TEXT, close_weekday TEXT, close_sat_phe TEXT, location TEXT, taxi_cap_per_head REAL);
CREATE TABLE IF NOT EXISTS ph_eves(date TEXT PRIMARY KEY, label TEXT);
CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, active INTEGER DEFAULT 1, direct_company INTEGER DEFAULT 0, worker_rate_override REAL);
CREATE TABLE IF NOT EXISTS pins(role TEXT PRIMARY KEY, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, role TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS clock_records(id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER, shop_id INTEGER, date TEXT, clock_in TEXT, clock_out TEXT, hours REAL, is_15x INTEGER DEFAULT 0, covers_for_id INTEGER, taxi_amount REAL DEFAULT 0, taxi_payer TEXT DEFAULT '', taxi_receipt_no TEXT DEFAULT '', taxi_remark TEXT DEFAULT '', riders TEXT DEFAULT '[]', photo_in TEXT DEFAULT '', photo_out TEXT DEFAULT '', receipt_photo TEXT DEFAULT '', source TEXT DEFAULT 'app', created_at TEXT);
CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER, shop_id INTEGER, date TEXT, time_start TEXT, time_end TEXT, covers_for_id INTEGER, created_by TEXT DEFAULT '', status TEXT DEFAULT 'scheduled');
CREATE TABLE IF NOT EXISTS availability(staff_id INTEGER, date TEXT, available INTEGER, PRIMARY KEY(staff_id, date));
CREATE TABLE IF NOT EXISTS cover_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER, shop_id INTEGER, date TEXT, reason TEXT DEFAULT '', status TEXT DEFAULT 'open', cover_staff_id INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS pay_status(month TEXT, staff_id INTEGER, paid INTEGER DEFAULT 0, paid_at TEXT, PRIMARY KEY(month, staff_id));
CREATE TABLE IF NOT EXISTS requirements(shop_id INTEGER, weekday INTEGER, required_count INTEGER, PRIMARY KEY(shop_id, weekday));
CREATE TABLE IF NOT EXISTS req_dates(shop_id INTEGER, date TEXT, required_count INTEGER, PRIMARY KEY(shop_id, date));
CREATE TABLE IF NOT EXISTS special_days(date TEXT PRIMARY KEY, label TEXT);
CREATE TABLE IF NOT EXISTS rate_history(id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, scope_id INTEGER, agent_rate REAL, worker_rate REAL, effective_from TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS activity_log(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, detail TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS transfers(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref_id INTEGER, from_shop_id INTEGER, to_shop_id INTEGER, staff_id INTEGER, date TEXT, created_at TEXT);
`);

function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM shops').get().c;
  if (n === 0) {
    const ins = db.prepare('INSERT INTO shops(name,color,agent_rate,worker_rate,company_name,company_address) VALUES (?,?,?,?,?,?)');
    ins.run("Bae's", '#0d7a5f', 45, 30, 'Baes Hospitality Pte Ltd', '21 Tanjong Pagar Road #01-04-05');
    ins.run('Milli', '#7a4fd0', 45, 35, 'BNG Hospitality Pte Ltd', '');
    ins.run('Bungalow', '#c47a1a', 45, 35, '', '');
  }
  const ph = db.prepare('INSERT OR IGNORE INTO shops(name,color,agent_rate,worker_rate,active) VALUES (?,?,?,?,0)');
  ph.run('ร้านใหม่ 1', '#888888', 45, 35);
  ph.run('ร้านใหม่ 2', '#888888', 45, 35);
  ph.run('ร้านใหม่ 3', '#888888', 45, 35);
  const m = db.prepare('SELECT COUNT(*) c FROM staff').get().c;
  if (m === 0) {
    const names = ['Ariel','Bell','Celine','Chloe','Gift','Ivy','Janice','Jaslyn','Jay','Jee','KK','Kate','Koiz','Namwan','Natty','Nicha','Nonney','Oil','Pear','Phinya','Ploy','Rene','Scarlett','Venus'];
    const ins = db.prepare('INSERT INTO staff(name,direct_company) VALUES (?,?)');
    for (const nm of names) ins.run(nm, nm === 'Nicha' ? 1 : 0);
  }
}
seed();
// Access control: staff must log in with registered name + mobile number.
// Owner enters each staff member's phone in the owner area; no phone on file = no access.
try { db.exec("ALTER TABLE staff ADD COLUMN phone TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE staff ADD COLUMN paynow TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE staff ADD COLUMN payname TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE staff ADD COLUMN notes TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE sessions ADD COLUMN staff_id INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE sessions ADD COLUMN admin_id INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE otp_codes ADD COLUMN code TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE clock_records ADD COLUMN transport_mode TEXT DEFAULT 'taxi'"); } catch (e) {}
try { db.exec("ALTER TABLE clock_records ADD COLUMN company_transport_at TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE clock_records ADD COLUMN taxi_warning TEXT DEFAULT ''"); } catch (e) {}
// Bae's shop rules: open Wed-Sat, 11pm-3am Wed-Fri, 11pm-4am Sat & public-holiday eve, Tanjong Pagar.
// Taxi home reimbursed max $20/head with receipt; otherwise company transport 0.5-1h after close.
try {
  const baes = db.prepare("SELECT id FROM shops WHERE name=?").get("Bae's");
  if (baes && !db.prepare('SELECT 1 FROM shop_rules WHERE shop_id=?').get(baes.id)) {
    db.prepare('INSERT INTO shop_rules(shop_id,open_weekdays,close_weekday,close_sat_phe,location,taxi_cap_per_head) VALUES (?,?,?,?,?,?)')
      .run(baes.id, JSON.stringify([3, 4, 5, 6]), '03:00', '04:00', 'Tanjong Pagar', 20);
  }
  for (const [d, label] of [['2026-11-07', 'Deepavali eve'], ['2026-12-24', 'Christmas eve'], ['2026-12-31', "New Year's eve"]])
    db.prepare('INSERT OR IGNORE INTO ph_eves(date,label) VALUES (?,?)').run(d, label);
} catch (e) {}
function isPHEve(date) { return !!db.prepare('SELECT 1 FROM ph_eves WHERE date=?').get(date); }
function baesRule() { const b = db.prepare("SELECT id FROM shops WHERE name=?").get("Bae's"); return b ? db.prepare('SELECT * FROM shop_rules WHERE shop_id=?').get(b.id) : null; }
function baesOpen(date) { const wd = new Date(date + 'T12:00:00').getDay(); return [3, 4, 5, 6].includes(wd); }
function baesClose(date) { const wd = new Date(date + 'T12:00:00').getDay(); return (wd === 6 || isPHEve(date)) ? '04:00' : '03:00'; }
function taxiPerHead(amount, riders) { const heads = 1 + (riders || []).length; return { heads, per_head: +(amount / heads).toFixed(2) }; }
function cappedTaxi(rec) {
  // Bae's taxi reimbursement is capped at $20/head (with receipt); excess is not claimable.
  if (rec.transport_mode === 'company') return 0;
  const shop = db.prepare('SELECT name FROM shops WHERE id=?').get(rec.shop_id);
  if (shop && shop.name === "Bae's") {
    const riders = JSON.parse(rec.riders || '[]');
    const { heads } = taxiPerHead(rec.taxi_amount || 0, riders);
    return Math.min(rec.taxi_amount || 0, 20 * heads);
  }
  return rec.taxi_amount || 0;
}
// Migrate a legacy single admin PIN (pins.role='admin') into the admins table.
try {
  const legacy = db.prepare("SELECT * FROM pins WHERE role='admin'").get();
  if (legacy) {
    const n = db.prepare('SELECT COUNT(*) c FROM admins').get().c;
    if (!n) db.prepare("INSERT INTO admins(name,salt,hash,created_at) VALUES ('Admin',?,?,?)").run(legacy.salt, legacy.hash, new Date().toISOString());
    db.prepare("DELETE FROM pins WHERE role='admin'").run();
  }
} catch (e) {}
function normPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.length > 8 ? d.slice(-8) : d; }
function staffAuth(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return null;
  const row = db.prepare('SELECT role, staff_id FROM sessions WHERE token=?').get(tok);
  if (!row || row.role !== 'staff' || !row.staff_id) return null;
  const st = db.prepare('SELECT * FROM staff WHERE id=?').get(row.staff_id);
  if (!st || !st.active) return null;
  return st;
}
function requireStaff(req, res) {
  const st = staffAuth(req);
  if (!st) { send(res, 401, { error: 'staff login required — enter your registered name and mobile number' }); return null; }
  return st;
}

const STAFF_NAMES = () => db.prepare('SELECT id,name,active,direct_company FROM staff ORDER BY name').all();
const SHOPS = () => db.prepare('SELECT id,name,color,agent_rate,worker_rate,active,company_name,company_address FROM shops ORDER BY id').all();
function log(actor, action, detail) { db.prepare('INSERT INTO activity_log(actor,action,detail,created_at) VALUES (?,?,?,?)').run(actor, action, detail || '', new Date().toISOString()); }
function hashPin(pin, salt) { return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex'); }
function auth(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return null;
  const row = db.prepare('SELECT role FROM sessions WHERE token=?').get(tok);
  return row ? row.role : null;
}
function requireRole(req, res, roles) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) { send(res, 401, { error: 'unauthorized' }); return null; }
  const s = db.prepare('SELECT role, admin_id FROM sessions WHERE token=?').get(tok);
  if (!s) { send(res, 401, { error: 'unauthorized' }); return null; }
  if (!roles.includes(s.role)) { send(res, 403, { error: 'forbidden' }); return null; }
  // Admin sessions carry the admin's name so the activity log shows WHO acted.
  if (s.role === 'admin' && s.admin_id) {
    const a = db.prepare('SELECT name, active FROM admins WHERE id=?').get(s.admin_id);
    if (!a || !a.active) { send(res, 403, { error: 'admin deactivated' }); return null; }
    return 'admin:' + a.name;
  }
  return s.role;
}
function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
  res.end(body);
}
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
// --- rates / pay ---
function rateFor(shopId, staffId, date) {
  const shop = db.prepare('SELECT agent_rate,worker_rate FROM shops WHERE id=?').get(shopId);
  let agent = shop ? shop.agent_rate : 45, worker = shop ? shop.worker_rate : 35;
  const rh = db.prepare("SELECT agent_rate,worker_rate FROM rate_history WHERE scope='shop' AND scope_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1").get(shopId, date);
  if (rh) { if (rh.agent_rate != null) agent = rh.agent_rate; if (rh.worker_rate != null) worker = rh.worker_rate; }
  const st = db.prepare('SELECT worker_rate_override FROM staff WHERE id=?').get(staffId);
  if (st && st.worker_rate_override != null) worker = st.worker_rate_override;
  const rh2 = db.prepare("SELECT worker_rate FROM rate_history WHERE scope='staff' AND scope_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1").get(staffId, date);
  if (rh2 && rh2.worker_rate != null) worker = rh2.worker_rate;
  return { agent, worker };
}
function is15x(date) { return !!db.prepare('SELECT 1 FROM special_days WHERE date=?').get(date); }
function calcPay(rec) {
  const r = rateFor(rec.shop_id, rec.staff_id, rec.date);
  const hrs = rec.hours || 0;
  const mult = rec.is_15x ? 1.5 : 1;
  return { workerPay: +(hrs * r.worker * mult).toFixed(2), agentAmount: +(hrs * r.agent * mult).toFixed(2), workerRate: r.worker, agentRate: r.agent, normalHrs: rec.is_15x ? 0 : hrs, hrs15: rec.is_15x ? hrs : 0 };
}
function hoursBetween(a, b) {
  const ms = new Date(b) - new Date(a);
  return ms > 0 ? +(ms / 3600000).toFixed(2) : 0;
}
function shopName(id) { const s = db.prepare('SELECT name FROM shops WHERE id=?').get(id); return s ? s.name : ''; }
function staffName(id) { const s = db.prepare('SELECT name FROM staff WHERE id=?').get(id); return s ? s.name : ''; }
function monthRange(month) { // 'YYYY-MM'
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${month}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

// --- security: access lock / revocable public link ---
db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO settings(key,value) VALUES('public_access','1');
CREATE TABLE IF NOT EXISTS otp_codes(id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER, code_hash TEXT, code TEXT, expires_at TEXT, attempts INTEGER DEFAULT 0, used INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS trusted_devices(device_token TEXT PRIMARY KEY, staff_id INTEGER, expires_at TEXT, created_at TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, salt TEXT, hash TEXT, active INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS shop_rules(shop_id INTEGER PRIMARY KEY, open_weekdays TEXT, close_weekday TEXT, close_sat_phe TEXT, location TEXT, taxi_cap_per_head REAL);
CREATE TABLE IF NOT EXISTS ph_eves(date TEXT PRIMARY KEY, label TEXT);`);
function publicAccessOn() { const r = db.prepare("SELECT value FROM settings WHERE key='public_access'").get(); return !r || r.value === '1'; }
function csvEscape(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function csv(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\n'); }

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/' || p === '/index.html') { send(res, 200, fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')); return; }
    if (p === '/api/health') { send(res, 200, { ok: true, public_access: publicAccessOn() }); return; }
    if (p === '/api/directory') {
      if (!publicAccessOn()) return send(res, 403, { error: 'access_disabled' });
      // Never return rates/pay, and never return the staff list publicly.
      // Staff log in by typing their own name + phone; the server checks it.
      send(res, 200, { shops: SHOPS().filter(s => s.active).map(s => ({ id: s.id, name: s.name, color: s.color })) });
      return;
    }
    if (p === '/api/staff-login' && req.method === 'POST') {
      // Step 1 of OTP login: name + registered phone. No real SMS is sent in
      // this trial — the 6-digit code is shown to the OWNER in the owner area
      // (labelled "trial OTP") so the owner can send it to the staff member
      // (e.g. via WhatsApp). The code itself is never returned to the requester.
      if (!publicAccessOn()) return send(res, 403, { error: 'access_disabled' });
      const b = await bodyJson(req);
      const name = String(b.name || '').trim().toLowerCase();
      const phone = normPhone(b.phone);
      if (!name || !phone) return send(res, 400, { error: 'name and mobile number required' });
      const st = db.prepare('SELECT * FROM staff WHERE lower(name)=?').get(name);
      if (!st || !st.active || !st.phone || normPhone(st.phone) !== phone) {
        log(name || 'unknown', 'login_failed', 'name/phone did not match registered staff');
        return send(res, 403, { error: 'name or mobile number not registered — ask the owner to add your number' });
      }
      const hourAgo = new Date(Date.now() - 3600e3).toISOString();
      const recent = db.prepare('SELECT COUNT(*) c FROM otp_codes WHERE staff_id=? AND created_at>?').get(st.id, hourAgo).c;
      if (recent >= 5) return send(res, 429, { error: 'too many codes requested — try again later' });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date(Date.now() + 10 * 60e3).toISOString();
      db.prepare('INSERT INTO otp_codes(staff_id,code_hash,code,expires_at,created_at) VALUES (?,?,?,?,?)').run(st.id, crypto.createHash('sha256').update(code).digest('hex'), code, expires, new Date().toISOString());
      log(st.name, 'otp_sent', 'trial OTP issued (owner-visible only), expires in 10 min');
      send(res, 200, { ok: true, step: 'otp', staff_id: st.id, name: st.name, expires_in_seconds: 600, trial_note: 'Trial OTP: no SMS is sent. The owner can see the code in the owner area and send it to you.' }); return;
    }
    if (p === '/api/staff-verify-otp' && req.method === 'POST') {
      // Step 2: staff enters the 6-digit code. On success the device is
      // remembered for 30 days (trusted device token).
      if (!publicAccessOn()) return send(res, 403, { error: 'access_disabled' });
      const b = await bodyJson(req);
      const name = String(b.name || '').trim().toLowerCase();
      const phone = normPhone(b.phone);
      const code = String(b.code || '').trim();
      const st = db.prepare('SELECT * FROM staff WHERE lower(name)=?').get(name);
      if (!st || !st.active || !st.phone || normPhone(st.phone) !== phone) return send(res, 403, { error: 'name or mobile number not registered' });
      const row = db.prepare('SELECT * FROM otp_codes WHERE staff_id=? AND used=0 ORDER BY id DESC LIMIT 1').get(st.id);
      if (!row) return send(res, 403, { error: 'no OTP requested — request a code first' });
      if (new Date(row.expires_at) < new Date()) return send(res, 403, { error: 'OTP expired — request a new code' });
      if (row.attempts >= 5) return send(res, 403, { error: 'too many wrong attempts — request a new code' });
      if (crypto.createHash('sha256').update(code).digest('hex') !== row.code_hash) {
        db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
        log(st.name, 'otp_failed', 'wrong OTP attempt');
        return send(res, 403, { error: 'wrong OTP code' });
      }
      db.prepare('UPDATE otp_codes SET used=1 WHERE id=?').run(row.id);
      const token = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO sessions(token,role,staff_id,created_at) VALUES(?,?,?,?)').run(token, 'staff', st.id, new Date().toISOString());
      const deviceToken = crypto.randomBytes(24).toString('hex');
      const devExp = new Date(Date.now() + 30 * 86400e3).toISOString();
      db.prepare('INSERT INTO trusted_devices(device_token,staff_id,expires_at,created_at,last_seen) VALUES (?,?,?,?,?)').run(deviceToken, st.id, devExp, new Date().toISOString(), new Date().toISOString());
      log(st.name, 'otp_verified', 'OTP verified, device remembered for 30 days');
      send(res, 200, { ok: true, token, device_token: deviceToken, staff_id: st.id, name: st.name }); return;
    }
    if (p === '/api/staff-device-login' && req.method === 'POST') {
      // Remembered device: skip OTP if the device token is still valid and
      // the staff member is still active with a registered phone.
      if (!publicAccessOn()) return send(res, 403, { error: 'access_disabled' });
      const b = await bodyJson(req);
      const dev = db.prepare('SELECT * FROM trusted_devices WHERE device_token=?').get(b.device_token || '');
      if (!dev || new Date(dev.expires_at) < new Date()) return send(res, 403, { error: 'device not remembered — log in with OTP' });
      const st = db.prepare('SELECT * FROM staff WHERE id=?').get(dev.staff_id);
      if (!st || !st.active || !st.phone) return send(res, 403, { error: 'staff deactivated or phone removed — log in with OTP' });
      db.prepare('UPDATE trusted_devices SET last_seen=? WHERE device_token=?').run(new Date().toISOString(), b.device_token);
      const token = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO sessions(token,role,staff_id,created_at) VALUES(?,?,?,?)').run(token, 'staff', st.id, new Date().toISOString());
      log(st.name, 'app_entry', 'remembered device login');
      send(res, 200, { ok: true, token, staff_id: st.id, name: st.name }); return;
    }
    if (p === '/api/owner/otps') {
      // Owner-only: trial OTP codes so the owner can send them to staff.
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const rows = db.prepare('SELECT * FROM otp_codes ORDER BY id DESC LIMIT 50').all();
      send(res, 200, { trial_note: 'TRIAL OTP — no real SMS is sent. Codes below are visible to the owner only; send a code to the staff member yourself (e.g. WhatsApp). Codes expire after 10 minutes.', otps: rows.map(r => ({ id: r.id, staff: staffName(r.staff_id), staff_id: r.staff_id, code: r.code, expires_at: r.expires_at, attempts: r.attempts, used: !!r.used, created_at: r.created_at })) });
      return;
    }
    if (p === '/api/pin-status') { const owner = !!db.prepare("SELECT 1 FROM pins WHERE role='owner'").get(); const admins = db.prepare('SELECT COUNT(*) c FROM admins WHERE active=1').get().c; send(res, 200, { owner, admin: admins > 0, admin_count: admins }); return; }
    if (p === '/api/pin/setup' && req.method === 'POST') {
      const b = await bodyJson(req); const { role, pin, current_pin } = b;
      if (!pin || String(pin).length < 4) return send(res, 400, { error: 'pin must be at least 4 digits' });
      const owner = db.prepare("SELECT * FROM pins WHERE role='owner'").get();
      // --- admins: up to 3 named admins, each with their own PIN (owner sets them) ---
      if (role === 'admin') {
        if (!owner || hashPin(String(current_pin || ''), owner.salt) !== owner.hash) return send(res, 403, { error: 'owner PIN required to set an admin PIN' });
        if (b.name) {
          const active = db.prepare('SELECT COUNT(*) c FROM admins WHERE active=1').get().c;
          if (active >= 3) return send(res, 400, { error: 'max 3 admins' });
          const salt = crypto.randomBytes(8).toString('hex');
          try { db.prepare('INSERT INTO admins(name,salt,hash,created_at) VALUES (?,?,?,?)').run(String(b.name).trim(), salt, hashPin(String(pin), salt), new Date().toISOString()); }
          catch (e) { return send(res, 400, { error: 'admin name already exists' }); }
          log('owner', 'admin_add', 'admin ' + b.name + ' added');
          send(res, 200, { ok: true }); return;
        }
        const a = db.prepare('SELECT * FROM admins WHERE active=1 ORDER BY id LIMIT 1').get();
        if (!a) return send(res, 400, { error: 'no admin yet — add one with a name' });
        const salt = crypto.randomBytes(8).toString('hex');
        db.prepare('UPDATE admins SET salt=?, hash=? WHERE id=?').run(salt, hashPin(String(pin), salt), a.id);
        log('owner', 'pin_change', 'admin ' + a.name + ' PIN changed');
        send(res, 200, { ok: true }); return;
      }
      if (role !== 'owner') return send(res, 400, { error: 'unknown role' });
      const existing = db.prepare('SELECT * FROM pins WHERE role=?').get(role);
      if (existing) {
        if (!owner || hashPin(String(current_pin || ''), owner.salt) !== owner.hash) return send(res, 403, { error: 'current owner PIN required to change a PIN' });
      }
      const salt = crypto.randomBytes(8).toString('hex');
      db.prepare('INSERT INTO pins(role,salt,hash) VALUES(?,?,?) ON CONFLICT(role) DO UPDATE SET salt=excluded.salt, hash=excluded.hash').run(role, salt, hashPin(String(pin), salt));
      log('owner', 'pin_change', role + ' PIN set/changed');
      send(res, 200, { ok: true }); return;
    }
    if (p === '/api/pin/verify' && req.method === 'POST') {
      const b = await bodyJson(req); const { role, pin } = b;
      if (role === 'admin') {
        // Admins log in with their own name + PIN; the session records which admin.
        let a = null;
        if (b.name) a = db.prepare('SELECT * FROM admins WHERE lower(name)=? AND active=1').get(String(b.name).trim().toLowerCase());
        if (!a) { const list = db.prepare('SELECT * FROM admins WHERE active=1 ORDER BY id').all(); if (list.length === 1) a = list[0]; }
        if (!a || hashPin(String(pin || ''), a.salt) !== a.hash) { log(b.name || 'unknown', 'pin_failed', 'failed PIN attempt for admin'); return send(res, 403, { error: 'wrong admin name or PIN' }); }
        const token = crypto.randomBytes(24).toString('hex');
        db.prepare('INSERT INTO sessions(token,role,admin_id,created_at) VALUES(?,?,?,?)').run(token, 'admin', a.id, new Date().toISOString());
        log('admin:' + a.name, 'pin_verified', 'admin area entered');
        send(res, 200, { ok: true, token, role: 'admin', admin_name: a.name }); return;
      }
      const row = db.prepare('SELECT * FROM pins WHERE role=?').get(role);
      if (!row || hashPin(String(pin || ''), row.salt) !== row.hash) { log(role || 'unknown', 'pin_failed', 'failed PIN attempt for ' + role); return send(res, 403, { error: 'wrong PIN' }); }
      const token = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO sessions(token,role,created_at) VALUES(?,?,?)').run(token, role, new Date().toISOString());
      log(role, 'pin_verified', role + ' area entered');
      send(res, 200, { ok: true, token, role }); return;
    }
    if (p === '/api/log-entry' && req.method === 'POST') {
      // Staff opening the app / picking their name is logged for the owner.
      const b = await bodyJson(req);
      if (b && b.actor) log(String(b.actor).slice(0, 60), 'app_entry', String(b.action || 'opened app').slice(0, 120));
      send(res, 200, { ok: true }); return;
    }
    // Staff clock-in (public, but blocked if access disabled or staff deactivated)
    if (p === '/api/clock-in' && req.method === 'POST') {
      if (!publicAccessOn()) return send(res, 403, { error: 'access_disabled' });
      const me = requireStaff(req, res); if (!me) return;
      const b = await bodyJson(req);
      const ids = (b.staff_ids || (b.staff_id ? [b.staff_id] : [])).map(Number);
      if (!ids.includes(me.id)) return send(res, 403, { error: 'you can only clock in yourself (or a group you are part of)' });
      if (!ids.length || !b.shop_id) return send(res, 400, { error: 'staff and shop required' });
      const shop = db.prepare('SELECT * FROM shops WHERE id=? AND active=1').get(b.shop_id);
      if (!shop) return send(res, 400, { error: 'shop not found' });
      const now = new Date(); const date = now.toISOString().slice(0, 10);
      const out = [];
      for (const sid of ids) {
        const st = db.prepare('SELECT * FROM staff WHERE id=?').get(sid);
        if (!st || !st.active) { out.push({ staff_id: sid, error: 'staff deactivated — cannot clock in' }); continue; }
        const open = db.prepare('SELECT * FROM clock_records WHERE staff_id=? AND clock_out IS NULL').get(sid);
        if (open) { out.push({ staff_id: sid, error: 'already clocked in', record_id: open.id }); continue; }
        const r = db.prepare('INSERT INTO clock_records(staff_id,shop_id,date,clock_in,is_15x,covers_for_id,photo_in,source,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(sid, b.shop_id, date, now.toISOString(), is15x(date) ? 1 : 0, b.covers_for_id || null, (b.photo || '').slice(0, 500000), ids.length > 1 ? 'group' : 'app', now.toISOString());
        log(st.name, 'clock_in', shopName(b.shop_id) + ' ' + date + (b.covers_for_id ? ' covers ' + staffName(b.covers_for_id) : ''));
        out.push({ staff_id: sid, record_id: Number(r.lastInsertRowid) });
      }
      send(res, 200, { ok: true, results: out }); return;
    }
    if (p === '/api/clock-out' && req.method === 'POST') {
      if (!publicAccessOn()) return send(res, 403, { error: 'access_disabled' });
      const me = requireStaff(req, res); if (!me) return;
      const b = await bodyJson(req);
      const rec = db.prepare('SELECT * FROM clock_records WHERE id=?').get(b.record_id);
      if (!rec || rec.staff_id !== me.id) return send(res, 403, { error: 'you can only clock out your own shift' });
      if (!rec || rec.clock_out) return send(res, 400, { error: 'record not found or already clocked out' });
      const st = db.prepare('SELECT * FROM staff WHERE id=?').get(rec.staff_id);
      if (!st || !st.active) return send(res, 403, { error: 'staff deactivated' });
      const now = new Date();
      const hrs = hoursBetween(rec.clock_in, now.toISOString());
      // Bae's taxi rule: max $20/head with receipt; otherwise company transport.
      const riders = b.riders || [];
      const transportMode = b.transport_mode || 'taxi';
      let taxiAmt = Number(b.taxi_amount || 0);
      if (transportMode === 'company') taxiAmt = 0;
      const warnings = [];
      if (transportMode === 'company' && !b.company_transport_at) warnings.push('company transport used — record departure time');
      if (transportMode === 'taxi' && taxiAmt > 0) {
        const rule = baesRule();
        const cap = rule ? rule.taxi_cap_per_head : 20;
        const { heads, per_head } = taxiPerHead(taxiAmt, riders);
        if (per_head > cap) warnings.push(`taxi $${per_head}/head exceeds $${cap}/head cap (${heads} heads) — reimburse max $${cap * heads}`);
        if (!b.taxi_receipt_no && !b.receipt_photo) warnings.push('receipt required for taxi reimbursement');
      }
      db.prepare('UPDATE clock_records SET clock_out=?, hours=?, taxi_amount=?, taxi_payer=?, taxi_receipt_no=?, taxi_remark=?, riders=?, photo_out=?, receipt_photo=?, transport_mode=?, company_transport_at=?, taxi_warning=? WHERE id=?')
        .run(now.toISOString(), hrs, taxiAmt, b.taxi_payer || '', b.taxi_receipt_no || '', b.taxi_remark || '', JSON.stringify(riders), (b.photo || '').slice(0, 500000), (b.receipt_photo || '').slice(0, 500000), transportMode, b.company_transport_at || '', warnings.join('; '), b.record_id);
      log(st.name, 'clock_out', shopName(rec.shop_id) + ' ' + rec.date + ' ' + hrs + 'h taxi $' + taxiAmt + (transportMode === 'company' ? ' (company transport)' : '') + (warnings.length ? ' WARNING: ' + warnings.join('; ') : ''));
      send(res, 200, { ok: true, hours: hrs, warnings }); return;
    }
    if (p === '/api/my-status') {
      const me = requireStaff(req, res); if (!me) return;
      const sid = Number(u.searchParams.get('staff_id'));
      if (sid !== me.id) return send(res, 403, { error: 'you can only view your own status' });
      const open = db.prepare('SELECT * FROM clock_records WHERE staff_id=? AND clock_out IS NULL').get(sid);
      const today = new Date().toISOString().slice(0, 10);
      const shifts = db.prepare('SELECT * FROM shifts WHERE staff_id=? AND date=?').all(sid, today);
      send(res, 200, { open: open ? { id: open.id, shop_id: open.shop_id, shop: shopName(open.shop_id), clock_in: open.clock_in } : null, shifts: shifts.map(s => ({ ...s, shop: shopName(s.shop_id), covers_for: s.covers_for_id ? staffName(s.covers_for_id) : null })) }); return;
    }
    if (p === '/api/my-hours') {
      const me = requireStaff(req, res); if (!me) return;
      const sid = Number(u.searchParams.get('staff_id')); const month = u.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      if (sid !== me.id) return send(res, 403, { error: 'you can only view your own hours' });
      const { from, to } = monthRange(month);
      const recs = db.prepare('SELECT * FROM clock_records WHERE staff_id=? AND date BETWEEN ? AND ? ORDER BY date').all(sid, from, to);
      // Staff see hours + own taxi only — never pay or rates.
      send(res, 200, { month, total_hours: +recs.reduce((a, r) => a + (r.hours || 0), 0).toFixed(2), taxi_total: +recs.reduce((a, r) => a + (r.taxi_amount || 0), 0).toFixed(2), records: recs.map(r => ({ id: r.id, date: r.date, shop: shopName(r.shop_id), clock_in: r.clock_in, clock_out: r.clock_out, hours: r.hours, is_15x: !!r.is_15x, covers_for: r.covers_for_id ? staffName(r.covers_for_id) : null, taxi_amount: r.taxi_amount, taxi_payer: r.taxi_payer, transport_mode: r.transport_mode || 'taxi', taxi_warning: r.taxi_warning || '' })) }); return;
    }
    if (p === '/api/availability' && req.method === 'POST') {
      if (!publicAccessOn()) return send(res, 403, { error: 'access_disabled' });
      const me = requireStaff(req, res); if (!me) return;
      const b = await bodyJson(req);
      if (Number(b.staff_id) !== me.id) return send(res, 403, { error: 'you can only set your own availability' });
      const st = db.prepare('SELECT * FROM staff WHERE id=?').get(b.staff_id);
      if (!st || !st.active) return send(res, 403, { error: 'staff deactivated' });
      for (const d of (b.dates || [])) db.prepare('INSERT INTO availability(staff_id,date,available) VALUES(?,?,?) ON CONFLICT(staff_id,date) DO UPDATE SET available=excluded.available').run(b.staff_id, d, b.available ? 1 : 0);
      log(st.name, 'availability', (b.dates || []).length + ' dates');
      send(res, 200, { ok: true }); return;
    }
    if (p === '/api/availability') {
      const me = auth(req) ? (staffAuth(req) || null) : null;
      if (!me && !auth(req)) return send(res, 401, { error: 'login required' });
      const from = u.searchParams.get('from') || new Date().toISOString().slice(0, 10);
      const to = u.searchParams.get('to') || from;
      const rows = db.prepare('SELECT staff_id,date FROM availability WHERE available=1 AND date BETWEEN ? AND ?').all(from, to);
      send(res, 200, { rows: rows.map(r => ({ staff_id: r.staff_id, name: staffName(r.staff_id), date: r.date })) }); return;
    }
    if (p === '/api/schedule') {
      if (!auth(req) && !staffAuth(req)) return send(res, 401, { error: 'login required' });
      const from = u.searchParams.get('from') || new Date().toISOString().slice(0, 10);
      const to = u.searchParams.get('to') || from;
      const rows = db.prepare('SELECT * FROM shifts WHERE date BETWEEN ? AND ? ORDER BY date, shop_id').all(from, to);
      send(res, 200, { shifts: rows.map(s => ({ ...s, staff: staffName(s.staff_id), shop: shopName(s.shop_id), covers_for: s.covers_for_id ? staffName(s.covers_for_id) : null })) }); return;
    }
    if (p === '/api/today-status') {
      if (!auth(req) && !staffAuth(req)) return send(res, 401, { error: 'login required' });
      const today = new Date().toISOString().slice(0, 10);
      const out = [];
      for (const shop of SHOPS().filter(s => s.active)) {
        const shifts = db.prepare('SELECT * FROM shifts WHERE shop_id=? AND date=?').all(shop.id, today);
        const recs = db.prepare('SELECT * FROM clock_records WHERE shop_id=? AND date=?').all(shop.id, today);
        const inIds = new Set(recs.filter(r => r.clock_in).map(r => r.staff_id));
        out.push({ shop_id: shop.id, shop: shop.name, scheduled: shifts.map(s => ({ staff: staffName(s.staff_id), clocked_in: inIds.has(s.staff_id) })), clocked_in_count: recs.filter(r => r.clock_in).length, clocked_out_count: recs.filter(r => r.clock_out).length, scheduled_count: shifts.length });
      }
      send(res, 200, { date: today, shops: out }); return;
    }
    if (p === '/api/replacements') {
      if (!auth(req) && !staffAuth(req)) return send(res, 401, { error: 'login required' });
      const date = u.searchParams.get('date'); const shopId = Number(u.searchParams.get('shop_id'));
      const avail = db.prepare('SELECT staff_id FROM availability WHERE date=? AND available=1').all(date).map(r => r.staff_id);
      const sched = db.prepare('SELECT staff_id FROM shifts WHERE date=? AND shop_id=?').all(date, shopId).map(r => r.staff_id);
      const clocked = db.prepare('SELECT staff_id FROM clock_records WHERE date=?').all(date).map(r => r.staff_id);
      const list = STAFF_NAMES().filter(s => s.active).map(s => ({ id: s.id, name: s.name, available: avail.includes(s.id), scheduled_here: sched.includes(s.id), already_working: clocked.includes(s.id) }))
        .sort((a, b) => (b.available - a.available) || (a.already_working - b.already_working));
      send(res, 200, { date, shop: shopName(shopId), candidates: list }); return;
    }
    // ---- cover requests: staff report they can't work; the OWNER decides the replacement ----
    if (p === '/api/cover-request' && req.method === 'POST') {
      const me = requireStaff(req, res); if (!me) return;
      const b = await bodyJson(req);
      if (!b.date || !b.shop_id) return send(res, 400, { error: 'date and shop required' });
      const dup = db.prepare("SELECT id FROM cover_requests WHERE staff_id=? AND shop_id=? AND date=? AND status='open'").get(me.id, b.shop_id, b.date);
      if (dup) return send(res, 400, { error: 'แจ้งไปแล้ว — คำขอนี้ยังรออยู่' });
      const r = db.prepare('INSERT INTO cover_requests(staff_id,shop_id,date,reason,status,created_at) VALUES (?,?,?,?,\'open\',?)').run(me.id, b.shop_id, b.date, String(b.reason || '').trim(), new Date().toISOString());
      log(me.name, 'cover_request', me.name + ' cannot work ' + shopName(b.shop_id) + ' ' + b.date);
      send(res, 200, { ok: true, id: Number(r.lastInsertRowid) }); return;
    }
    if (p === '/api/cover-requests') {
      const role = requireRole(req, res, ['owner', 'admin']); if (!role) return;
      const reqs = db.prepare("SELECT * FROM cover_requests WHERE status='open' ORDER BY date").all();
      const out = reqs.map(rq => {
        const avail = db.prepare('SELECT staff_id FROM availability WHERE date=? AND available=1').all(rq.date).map(x => x.staff_id);
        const clocked = db.prepare('SELECT staff_id FROM clock_records WHERE date=?').all(rq.date).map(x => x.staff_id);
        const sched = db.prepare('SELECT staff_id FROM shifts WHERE date=? AND shop_id=?').all(rq.date, rq.shop_id).map(x => x.staff_id);
        const cands = STAFF_NAMES().filter(s => s.active && s.id !== rq.staff_id).map(s => ({
          id: s.id, name: s.name,
          available: avail.includes(s.id),
          shop_shifts: db.prepare('SELECT COUNT(*) c FROM clock_records WHERE staff_id=? AND shop_id=?').get(s.id, rq.shop_id).c,
          already_working: clocked.includes(s.id),
          scheduled_here: sched.includes(s.id)
        })).sort((a, b) => (b.available - a.available) || (a.already_working - b.already_working) || (b.shop_shifts - a.shop_shifts));
        return { id: rq.id, staff_id: rq.staff_id, name: staffName(rq.staff_id), shop: shopName(rq.shop_id), shop_id: rq.shop_id, date: rq.date, reason: rq.reason, candidates: cands };
      });
      send(res, 200, { requests: out }); return;
    }
    if (p.startsWith('/api/cover-requests/') && req.method === 'POST') {
      const role = requireRole(req, res, ['owner', 'admin']); if (!role) return;
      const b = await bodyJson(req);
      const id = Number(p.split('/')[3]);
      const rq = db.prepare('SELECT * FROM cover_requests WHERE id=?').get(id);
      if (!rq) return send(res, 404, { error: 'request not found' });
      if (b.action === 'cancel') {
        db.prepare("UPDATE cover_requests SET status='cancelled' WHERE id=?").run(id);
        log(role, 'cover_cancel', 'cover request ' + id + ' cancelled'); send(res, 200, { ok: true }); return;
      }
      const coverId = Number(b.cover_staff_id);
      const cover = db.prepare('SELECT * FROM staff WHERE id=?').get(coverId);
      if (!cover || !cover.active) return send(res, 400, { error: 'invalid replacement' });
      db.prepare('DELETE FROM shifts WHERE staff_id=? AND shop_id=? AND date=?').run(rq.staff_id, rq.shop_id, rq.date);
      db.prepare('INSERT INTO shifts(staff_id,shop_id,date,time_start,time_end,covers_for_id,created_by) VALUES (?,?,?,?,?,?,?)').run(coverId, rq.shop_id, rq.date, '23:00', baesClose(rq.date), rq.staff_id, role);
      db.prepare("UPDATE cover_requests SET status='assigned', cover_staff_id=? WHERE id=?").run(coverId, id);
      log(role, 'cover_assign', staffName(coverId) + ' covers ' + staffName(rq.staff_id) + ' at ' + shopName(rq.shop_id) + ' ' + rq.date);
      send(res, 200, { ok: true }); return;
    }
    // ---- admin / owner (PIN) ----
    if (p === '/api/shift' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner', 'admin']); if (!role) return;
      const b = await bodyJson(req);
      // Bae's is open Wed-Sat only, 11pm-3am (Wed-Fri) / 11pm-4am (Sat & PH eve).
      const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(b.shop_id);
      if (shop && shop.name === "Bae's" && b.date) {
        if (!baesOpen(b.date) && !b.force) return send(res, 400, { error: "Bae's is closed Sun-Tue (open Wed-Sat, Tanjong Pagar)", closed: true });
        if (!b.time_start) b.time_start = '23:00';
        if (!b.time_end) b.time_end = baesClose(b.date);
      }
      const r = db.prepare('INSERT INTO shifts(staff_id,shop_id,date,time_start,time_end,covers_for_id,created_by) VALUES (?,?,?,?,?,?,?)').run(b.staff_id, b.shop_id, b.date, b.time_start || '', b.time_end || '', b.covers_for_id || null, role);
      log(role, 'shift_create', staffName(b.staff_id) + ' ' + shopName(b.shop_id) + ' ' + b.date + (b.covers_for_id ? ' covers ' + staffName(b.covers_for_id) : ''));
      send(res, 200, { ok: true, id: Number(r.lastInsertRowid) }); return;
    }
    if (p.startsWith('/api/shift/') && req.method === 'DELETE') {
      const role = requireRole(req, res, ['owner', 'admin']); if (!role) return;
      db.prepare('DELETE FROM shifts WHERE id=?').run(p.split('/')[3]); log(role, 'shift_delete', 'shift ' + p.split('/')[3]); send(res, 200, { ok: true }); return;
    }
    if (p === '/api/transfer' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner', 'admin']); if (!role) return;
      const b = await bodyJson(req);
      if (b.kind === 'shift') { const s = db.prepare('SELECT * FROM shifts WHERE id=?').get(b.ref_id); if (!s) return send(res, 400, { error: 'shift not found' }); db.prepare('UPDATE shifts SET shop_id=? WHERE id=?').run(b.new_shop_id, b.ref_id); db.prepare('INSERT INTO transfers(kind,ref_id,from_shop_id,to_shop_id,staff_id,date,created_at) VALUES (?,?,?,?,?,?,?)').run('shift', b.ref_id, s.shop_id, b.new_shop_id, s.staff_id, s.date, new Date().toISOString()); }
      else { const r0 = db.prepare('SELECT * FROM clock_records WHERE id=?').get(b.ref_id); if (!r0) return send(res, 400, { error: 'record not found' }); db.prepare('UPDATE clock_records SET shop_id=? WHERE id=?').run(b.new_shop_id, b.ref_id); db.prepare('INSERT INTO transfers(kind,ref_id,from_shop_id,to_shop_id,staff_id,date,created_at) VALUES (?,?,?,?,?,?,?)').run('clock', b.ref_id, r0.shop_id, b.new_shop_id, r0.staff_id, r0.date, new Date().toISOString()); }
      log(role, 'transfer', 'moved to ' + shopName(b.new_shop_id)); send(res, 200, { ok: true }); return;
    }
    if (p === '/api/backfill' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner', 'admin']); if (!role) return;
      const b = await bodyJson(req);
      const st = db.prepare('SELECT * FROM staff WHERE id=?').get(b.staff_id);
      if (!st || !st.active) return send(res, 403, { error: 'staff deactivated' });
      const hrs = hoursBetween(b.clock_in, b.clock_out);
      const r = db.prepare('INSERT INTO clock_records(staff_id,shop_id,date,clock_in,clock_out,hours,is_15x,covers_for_id,taxi_amount,taxi_payer,taxi_receipt_no,taxi_remark,riders,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(b.staff_id, b.shop_id, b.date, b.clock_in, b.clock_out, hrs, is15x(b.date) ? 1 : 0, b.covers_for_id || null, Number(b.taxi_amount || 0), b.taxi_payer || '', b.taxi_receipt_no || '', b.taxi_remark || '', JSON.stringify(b.riders || []), 'backfill', new Date().toISOString());
      log(role, 'backfill', st.name + ' ' + shopName(b.shop_id) + ' ' + b.date + ' ' + hrs + 'h');
      send(res, 200, { ok: true, id: Number(r.lastInsertRowid), hours: hrs }); return;
    }
    if (p === '/api/requirement' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner', 'admin']); if (!role) return;
      const b = await bodyJson(req);
      if (b.date) db.prepare('INSERT INTO req_dates(shop_id,date,required_count) VALUES(?,?,?) ON CONFLICT(shop_id,date) DO UPDATE SET required_count=excluded.required_count').run(b.shop_id, b.date, b.count);
      else db.prepare('INSERT INTO requirements(shop_id,weekday,required_count) VALUES(?,?,?) ON CONFLICT(shop_id,weekday) DO UPDATE SET required_count=excluded.required_count').run(b.shop_id, b.weekday, b.count);
      send(res, 200, { ok: true }); return;
    }
    if (p === '/api/alerts') {
      const role = requireRole(req, res, ['owner', 'admin']); if (!role) return;
      const from = u.searchParams.get('from') || new Date().toISOString().slice(0, 10);
      const to = u.searchParams.get('to') || from;
      const alerts = [];
      for (let d = new Date(from); d <= new Date(to); d.setDate(d.getDate() + 1)) {
        const date = d.toISOString().slice(0, 10); const wd = d.getDay();
        for (const shop of SHOPS().filter(s => s.active)) {
          const ov = db.prepare('SELECT required_count FROM req_dates WHERE shop_id=? AND date=?').get(shop.id, date);
          const rw = db.prepare('SELECT required_count FROM requirements WHERE shop_id=? AND weekday=?').get(shop.id, wd);
          const req = ov ? ov.required_count : (rw ? rw.required_count : null);
          if (req == null) continue;
          const n = db.prepare('SELECT COUNT(*) c FROM shifts WHERE shop_id=? AND date=?').get(shop.id, date).c;
          if (n < req) alerts.push({ date, shop: shop.name, shop_id: shop.id, required: req, scheduled: n, short_by: req - n });
        }
      }
      send(res, 200, { alerts }); return;
    }
    // ---- owner only (money) ----
    if (p === '/api/staff' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req); if (!b.name) return send(res, 400, { error: 'name required' });
      try {
        const r = db.prepare('INSERT INTO staff(name,direct_company) VALUES (?,?)').run(b.name.trim(), b.direct_company ? 1 : 0);
        if (b.phone) db.prepare('UPDATE staff SET phone=? WHERE id=?').run(String(b.phone).trim(), Number(r.lastInsertRowid));
        log('owner', 'staff_add', b.name); send(res, 200, { ok: true, id: Number(r.lastInsertRowid) }); return;
      } catch (e) { return send(res, 400, { error: 'มีชื่อนี้อยู่แล้ว — ชื่อพนักงานซ้ำกันไม่ได้' }); }
    }
    if (p.startsWith('/api/staff/') && req.method === 'PATCH') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req); const id = Number(p.split('/')[3]);
      if (b.name) db.prepare('UPDATE staff SET name=? WHERE id=?').run(b.name.trim(), id);
      if (b.phone !== undefined) db.prepare('UPDATE staff SET phone=? WHERE id=?').run(String(b.phone || '').trim(), id);
      if (b.paynow !== undefined) db.prepare('UPDATE staff SET paynow=? WHERE id=?').run(String(b.paynow || '').trim(), id);
      if (b.payname !== undefined) db.prepare('UPDATE staff SET payname=? WHERE id=?').run(String(b.payname || '').trim(), id);
      if (b.notes !== undefined) db.prepare('UPDATE staff SET notes=? WHERE id=?').run(String(b.notes || '').trim(), id);
      if (b.active !== undefined) db.prepare('UPDATE staff SET active=? WHERE id=?').run(b.active ? 1 : 0, id);
      if (b.direct_company !== undefined) db.prepare('UPDATE staff SET direct_company=? WHERE id=?').run(b.direct_company ? 1 : 0, id);
      if (b.worker_rate_override !== undefined) db.prepare('UPDATE staff SET worker_rate_override=? WHERE id=?').run(b.worker_rate_override, id);
      log('owner', 'staff_update', 'staff ' + id + ' ' + JSON.stringify(b));
      send(res, 200, { ok: true }); return;
    }
    if (p.startsWith('/api/staff/') && req.method === 'DELETE') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const id = Number(p.split('/')[3]);
      const worked = db.prepare('SELECT COUNT(*) c FROM clock_records WHERE staff_id=?').get(id).c;
      if (worked > 0) return send(res, 400, { error: 'คนนี้มีประวัติชั่วโมงทำงานแล้ว ลบไม่ได้ — ให้กด Deactivate แทน ประวัติเงินจะได้ไม่หาย' });
      db.prepare('DELETE FROM availability WHERE staff_id=?').run(id);
      db.prepare('DELETE FROM shifts WHERE staff_id=?').run(id);
      db.prepare('DELETE FROM staff WHERE id=?').run(id);
      log('owner', 'staff_delete', 'staff ' + id + ' deleted');
      send(res, 200, { ok: true }); return;
    }
    if (p === '/api/owner/admins' && req.method === 'GET') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      send(res, 200, { admins: db.prepare('SELECT id,name,active,created_at FROM admins ORDER BY id').all(), max: 3 }); return;
    }
    if (p === '/api/owner/admins' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req);
      if (!b.name || !b.pin || String(b.pin).length < 4) return send(res, 400, { error: 'admin name and a PIN of 4+ digits are required' });
      const active = db.prepare('SELECT COUNT(*) c FROM admins WHERE active=1').get().c;
      if (active >= 3) return send(res, 400, { error: 'max 3 admins' });
      const salt = crypto.randomBytes(8).toString('hex');
      try { const r = db.prepare('INSERT INTO admins(name,salt,hash,created_at) VALUES (?,?,?,?)').run(String(b.name).trim(), salt, hashPin(String(b.pin), salt), new Date().toISOString()); log('owner', 'admin_add', 'admin ' + b.name + ' added'); send(res, 200, { ok: true, id: Number(r.lastInsertRowid) }); }
      catch (e) { send(res, 400, { error: 'admin name already exists' }); }
      return;
    }
    if (p.startsWith('/api/owner/admins/') && req.method === 'PATCH') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req); const id = Number(p.split('/')[4]);
      const a = db.prepare('SELECT * FROM admins WHERE id=?').get(id); if (!a) return send(res, 404, { error: 'admin not found' });
      if (b.name) db.prepare('UPDATE admins SET name=? WHERE id=?').run(String(b.name).trim(), id);
      if (b.pin) { if (String(b.pin).length < 4) return send(res, 400, { error: 'pin must be at least 4 digits' }); const salt = crypto.randomBytes(8).toString('hex'); db.prepare('UPDATE admins SET salt=?, hash=? WHERE id=?').run(salt, hashPin(String(b.pin), salt), id); }
      if (b.active !== undefined) db.prepare('UPDATE admins SET active=? WHERE id=?').run(b.active ? 1 : 0, id);
      log('owner', 'admin_update', 'admin ' + a.name + ' updated ' + JSON.stringify({ name: b.name, pin_changed: !!b.pin, active: b.active }));
      send(res, 200, { ok: true }); return;
    }
    if (p === '/api/owner/staff') { const role = requireRole(req, res, ['owner']); if (!role) return; send(res, 200, { staff: db.prepare('SELECT id,name,active,direct_company,phone,paynow,payname,notes,worker_rate_override FROM staff ORDER BY name').all(), shops: SHOPS() }); return; }
    if (p === '/api/shop' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const active = db.prepare('SELECT COUNT(*) c FROM shops WHERE active=1').get().c;
      if (active >= 8) return send(res, 400, { error: 'max 8 shops' });
      const b = await bodyJson(req);
      const r = db.prepare('INSERT INTO shops(name,color,agent_rate,worker_rate,company_name,company_address) VALUES (?,?,?,?,?,?)').run(b.name, b.color || '#333', Number(b.agent_rate || 45), Number(b.worker_rate || 35), b.company_name || '', b.company_address || '');
      log('owner', 'shop_add', b.name); send(res, 200, { ok: true, id: Number(r.lastInsertRowid) }); return;
    }
    if (p.startsWith('/api/shop/') && req.method === 'PATCH') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req); const id = Number(p.split('/')[3]);
      const cur = db.prepare('SELECT * FROM shops WHERE id=?').get(id); if (!cur) return send(res, 404, { error: 'not found' });
      db.prepare('UPDATE shops SET name=?,color=?,agent_rate=?,worker_rate=?,company_name=?,company_address=?,active=? WHERE id=?').run(b.name ?? cur.name, b.color ?? cur.color, b.agent_rate ?? cur.agent_rate, b.worker_rate ?? cur.worker_rate, b.company_name ?? cur.company_name, b.company_address ?? cur.company_address, b.active !== undefined ? (b.active ? 1 : 0) : cur.active, id);
      log('owner', 'shop_update', 'shop ' + id); send(res, 200, { ok: true }); return;
    }
    if (p === '/api/rate' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req);
      if (b.agent_rate != null && (b.agent_rate < 35 || b.agent_rate > 45)) return send(res, 400, { error: 'agent rate must be 35-45' });
      if (b.worker_rate != null && (b.worker_rate < 25 || b.worker_rate > 45)) return send(res, 400, { error: 'worker rate must be 25-45' });
      db.prepare('INSERT INTO rate_history(scope,scope_id,agent_rate,worker_rate,effective_from,created_at) VALUES (?,?,?,?,?,?)').run(b.scope, b.scope_id, b.agent_rate ?? null, b.worker_rate ?? null, b.effective_from, new Date().toISOString());
      log('owner', 'rate_change', b.scope + ' ' + b.scope_id + ' from ' + b.effective_from + ' agent ' + b.agent_rate + ' worker ' + b.worker_rate);
      send(res, 200, { ok: true }); return;
    }
    if (p === '/api/rates') { const role = requireRole(req, res, ['owner']); if (!role) return; send(res, 200, { shops: SHOPS(), history: db.prepare('SELECT * FROM rate_history ORDER BY effective_from DESC LIMIT 100').all() }); return; }
    if (p === '/api/special-day' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req);
      db.prepare('INSERT OR REPLACE INTO special_days(date,label) VALUES (?,?)').run(b.date, b.label || '1.5x');
      log('owner', 'special_day', b.date); send(res, 200, { ok: true }); return;
    }
    if (p === '/api/shop-rules') {
      if (!auth(req) && !staffAuth(req)) return send(res, 401, { error: 'login required' });
      const rules = db.prepare('SELECT * FROM shop_rules').all().map(r => ({ shop_id: r.shop_id, shop: shopName(r.shop_id), open_weekdays: JSON.parse(r.open_weekdays || '[]'), close_weekday: r.close_weekday, close_sat_phe: r.close_sat_phe, location: r.location, taxi_cap_per_head: r.taxi_cap_per_head }));
      send(res, 200, { rules, ph_eves: db.prepare('SELECT * FROM ph_eves ORDER BY date').all(), baes_hours: "Bae's: Wed-Sat, 11pm-3am Wed-Fri, 11pm-4am Sat & public-holiday eve, Tanjong Pagar. Taxi home max $20/head with receipt, otherwise company transport 0.5-1h after close." }); return;
    }
    if (p === '/api/ph-eve' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req);
      db.prepare('INSERT OR REPLACE INTO ph_eves(date,label) VALUES (?,?)').run(b.date, b.label || 'public holiday eve');
      log('owner', 'ph_eve', b.date + ' set as public-holiday eve (Bae\'s closes 4am)');
      send(res, 200, { ok: true }); return;
    }
    // ---- pay status: owner marks each staff member paid per month ----
    if (p === '/api/owner/pay-status' && req.method === 'POST') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req);
      if (!b.month || !b.staff_id) return send(res, 400, { error: 'month and staff_id required' });
      db.prepare('INSERT INTO pay_status(month,staff_id,paid,paid_at) VALUES (?,?,?,?) ON CONFLICT(month,staff_id) DO UPDATE SET paid=excluded.paid, paid_at=excluded.paid_at').run(b.month, b.staff_id, b.paid ? 1 : 0, b.paid ? new Date().toISOString() : null);
      log('owner', 'pay_status', staffName(b.staff_id) + ' ' + b.month + ' paid=' + (b.paid ? 1 : 0));
      send(res, 200, { ok: true }); return;
    }
    if (p === '/api/owner/summary') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const month = u.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      const { from, to } = monthRange(month);
      const recs = db.prepare('SELECT * FROM clock_records WHERE date BETWEEN ? AND ? AND clock_out IS NOT NULL ORDER BY date').all(from, to);
      const staffInfo = {}; for (const st of db.prepare('SELECT id,paynow,payname FROM staff').all()) staffInfo[st.id] = { paynow: st.paynow || '', payname: st.payname || '' };
      const perStaff = {}, perShop = {};
      for (const shop of SHOPS()) perShop[shop.id] = { shop: shop.name, hours: 0, worker_pay: 0, agent_total: 0, taxi_claimable: 0, taxi_reimburse: 0 };
      for (const r of recs) {
        const pay = calcPay(r);
        perStaff[r.staff_id] = perStaff[r.staff_id] || { staff_id: r.staff_id, name: staffName(r.staff_id), paynow: (staffInfo[r.staff_id] || {}).paynow || '', payname: (staffInfo[r.staff_id] || {}).payname || '', hours: 0, worker_pay: 0, agent_total: 0, taxi: 0, taxi_reimburse: 0, by_shop: {} };
        const s = perStaff[r.staff_id]; s.hours += r.hours || 0; s.worker_pay += pay.workerPay; s.agent_total += pay.agentAmount; s.taxi += r.taxi_amount || 0;
        if (r.taxi_payer === 'staff') s.taxi_reimburse += cappedTaxi(r);
        s.by_shop[r.shop_id] = s.by_shop[r.shop_id] || { shop: shopName(r.shop_id), hours: 0, pay: 0 };
        s.by_shop[r.shop_id].hours += r.hours || 0; s.by_shop[r.shop_id].pay += pay.workerPay;
        const ps = perShop[r.shop_id]; if (ps) { ps.hours += r.hours || 0; ps.worker_pay += pay.workerPay; ps.agent_total += pay.agentAmount; ps.taxi_claimable += r.taxi_amount || 0; if (r.taxi_payer === 'staff') ps.taxi_reimburse += cappedTaxi(r); }
      }
      const paidRows = db.prepare('SELECT staff_id, paid FROM pay_status WHERE month=?').all(month);
      const paidMap = {}; for (const pr of paidRows) paidMap[pr.staff_id] = pr.paid;
      send(res, 200, { month, per_staff: Object.values(perStaff).map(s => ({ ...s, paid: paidMap[s.staff_id] || 0, hours: +s.hours.toFixed(2), worker_pay: +s.worker_pay.toFixed(2), agent_total: +s.agent_total.toFixed(2), taxi: +s.taxi.toFixed(2), taxi_reimburse: +s.taxi_reimburse.toFixed(2) })), per_shop: Object.values(perShop), total_agent: +Object.values(perShop).reduce((a, x) => a + x.agent_total, 0).toFixed(2), total_worker_pay: +Object.values(perShop).reduce((a, x) => a + x.worker_pay, 0).toFixed(2), taxi_warnings: recs.filter(r => r.taxi_warning).map(r => ({ date: r.date, staff: staffName(r.staff_id), shop: shopName(r.shop_id), warning: r.taxi_warning })) }); return;
    }
    if (p === '/api/owner/activity') { const role = requireRole(req, res, ['owner']); if (!role) return; send(res, 200, { log: db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 200').all() }); return; }
    if (p === '/api/owner/access' && req.method === 'POST') {
      // Revoke / restore public access — kills the public link for everyone until owner re-enables it.
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const b = await bodyJson(req);
      db.prepare("INSERT INTO settings(key,value) VALUES('public_access',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(b.enabled ? '1' : '0');
      log('owner', 'access_' + (b.enabled ? 'enabled' : 'disabled'), 'public access ' + (b.enabled ? 'ON' : 'OFF — public link revoked'));
      send(res, 200, { ok: true, public_access: b.enabled }); return;
    }
    if (p === '/api/bill/direct') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const month = u.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      const sid = Number(u.searchParams.get('staff_id'));
      const { from, to } = monthRange(month);
      const recs = db.prepare('SELECT * FROM clock_records WHERE staff_id=? AND date BETWEEN ? AND ? AND clock_out IS NOT NULL ORDER BY shop_id, date').all(sid, from, to);
      const rows = [['Date', 'Timing', 'Hr', '1.5', 'Total']];
      let total = 0;
      for (const r of recs) { const pay = calcPay(r); total += pay.agentAmount; rows.push([r.date, (r.clock_in || '').slice(11, 16) + '-' + (r.clock_out || '').slice(11, 16), pay.normalHrs, pay.hrs15, pay.agentAmount.toFixed(2)]); }
      rows.push(['', '', '', 'TOTAL', total.toFixed(2)]);
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="direct-bill-${staffName(sid)}-${month}.csv"` }); res.end(csv(rows)); return;
    }
    if (p === '/api/bill/bng') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const month = u.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      const shopId = Number(u.searchParams.get('shop_id'));
      const { from, to } = monthRange(month);
      const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(shopId);
      const recs = db.prepare('SELECT * FROM clock_records WHERE shop_id=? AND date BETWEEN ? AND ? AND clock_out IS NOT NULL ORDER BY date').all(shopId, from, to);
      const rows = [[`Company: ${shop ? shop.company_name : ''}`], [`Month: ${month}`], ['Date', 'Time', 'Talent', 'Rate', 'Hr', 'BA', 'Remark', 'Amount', 'Transport', 'Claims', 'Talent Riding']];
      let amt = 0, tr = 0, trc = 0;
      for (const r of recs) { const pay = calcPay(r); amt += pay.agentAmount; tr += r.taxi_amount || 0; trc += cappedTaxi(r); rows.push([r.date, (r.clock_in || '').slice(11, 16) + '-' + (r.clock_out || '').slice(11, 16), staffName(r.staff_id), pay.agentRate, r.hours, 1, r.covers_for_id ? 'covers ' + staffName(r.covers_for_id) : '', pay.agentAmount.toFixed(2), (r.taxi_amount || 0).toFixed(2), cappedTaxi(r).toFixed(2), JSON.parse(r.riders || '[]').map(staffName).join(',')]); }
      rows.push(['', '', '', '', '', '', 'TOTAL', amt.toFixed(2), tr.toFixed(2), trc.toFixed(2), '']);
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="bng-bill-${shop ? shop.name : shopId}-${month}.csv"` }); res.end(csv(rows)); return;
    }
    if (p === '/api/export/xlsx') {
      const role = requireRole(req, res, ['owner']); if (!role) return;
      const month = u.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      const out = path.join(DIR, `crewup-backup-${month}.xlsx`);
      const py = spawn('python3', [path.join(DIR, 'export_xlsx.py'), DB_PATH, month, out], { cwd: DIR });
      let err = '';
      py.stderr.on('data', d => err += d);
      py.on('close', code => {
        if (code !== 0 || !fs.existsSync(out)) return send(res, 500, { error: 'xlsx export failed', detail: err.slice(0, 500) });
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="crewup-backup-${month}.xlsx"` });
        fs.createReadStream(out).pipe(res);
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); send(res, 500, { error: String(e.message || e) }); }
}

http.createServer((req, res) => { handle(req, res); }).listen(PORT, '0.0.0.0', () => console.log(`CrewUp listening on http://0.0.0.0:${PORT}`));
