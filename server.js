// Craftpick Status — serveur HTTP, API REST, temps réel (SSE), authentification
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./lib/db');
const monitor = require('./lib/monitor');
const notify = require('./lib/notify');

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

db.load();

// ───────────────────────── Auth ─────────────────────────
const sessions = new Map(); // token -> expiresAt
const SESSION_MS = 30 * 24 * 3600 * 1000;
const loginAttempts = new Map(); // ip -> {n, until}

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw) {
  const s = db.data.settings;
  if (!s.adminHash) return false;
  const h = Buffer.from(hashPassword(pw, s.salt), 'hex');
  const ref = Buffer.from(s.adminHash, 'hex');
  return h.length === ref.length && crypto.timingSafeEqual(h, ref);
}
function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.data.settings.salt = salt;
  db.data.settings.adminHash = hashPassword(pw, salt);
  db.save();
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  const t = parseCookies(req).cs_session;
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function newSession(res) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `cs_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

// ───────────────────────── Helpers ─────────────────────────
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) { reject(new Error('Corps trop volumineux')); req.destroy(); } });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON invalide')); } });
    req.on('error', reject);
  });
}
const clamp = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const str = (v, max = 500) => (v == null ? '' : String(v).slice(0, max));

const MONITOR_TYPES = ['http', 'keyword', 'json', 'tcp', 'ping', 'dns'];
function sanitizeMonitor(b, existing = {}) {
  const m = {
    ...existing,
    name: str(b.name, 100) || 'Sans nom',
    type: MONITOR_TYPES.includes(b.type) ? b.type : 'http',
    url: str(b.url, 2000),
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(b.method) ? b.method : 'GET',
    headers: str(b.headers, 5000),
    body: str(b.body, 20000),
    hostname: str(b.hostname, 255),
    port: b.port ? clamp(b.port, 1, 65535, 80) : null,
    keyword: str(b.keyword, 500),
    invertKeyword: !!b.invertKeyword,
    caseSensitive: !!b.caseSensitive,
    jsonPath: str(b.jsonPath, 200),
    jsonExpected: str(b.jsonExpected, 500),
    dnsType: ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SRV', 'CAA'].includes(b.dnsType) ? b.dnsType : 'A',
    dnsServer: str(b.dnsServer, 100),
    interval: clamp(b.interval, 10, 86400, 60),
    retryInterval: clamp(b.retryInterval, 10, 86400, 30),
    timeout: clamp(b.timeout, 1, 300, 30),
    retries: clamp(b.retries, 0, 10, 1),
    expectedStatus: str(b.expectedStatus, 100) || '200-299',
    ignoreTls: !!b.ignoreTls,
    certExpiryAlert: !!b.certExpiryAlert,
    certExpiryDays: clamp(b.certExpiryDays, 1, 365, 14),
    group: str(b.group, 100),
    description: str(b.description, 500),
    isPublic: b.isPublic !== false,
    showTarget: !!b.showTarget,
    notificationIds: Array.isArray(b.notificationIds) ? b.notificationIds.map(Number).filter(Number.isFinite) : [],
    active: b.active !== false,
  };
  if (['http', 'keyword', 'json'].includes(m.type) && !/^https?:\/\//i.test(m.url)) throw new Error("L'URL doit commencer par http:// ou https://");
  if (['tcp', 'ping', 'dns'].includes(m.type) && !m.hostname) throw new Error('Nom d’hôte requis');
  if (m.type === 'tcp' && !m.port) throw new Error('Port requis');
  if (m.type === 'keyword' && !m.keyword) throw new Error('Mot-clé requis');
  if (m.type === 'json' && !m.jsonPath) throw new Error('Chemin JSON requis');
  return m;
}

// ───────────────────────── Statistiques ─────────────────────────
function rawStats(id, hours) {
  const since = Date.now() - hours * 3600 * 1000;
  const beats = (db.data.beats[id] || []).filter((b) => b.t >= since && b.s !== 2);
  const up = beats.filter((b) => b.s === 1 || b.s === 3).length;
  const pings = beats.filter((b) => b.s === 1 && typeof b.p === 'number').map((b) => b.p);
  return {
    uptime: beats.length ? (up / beats.length) * 100 : null,
    avgPing: pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : null,
  };
}
function dailyUptime(id, days) {
  const daily = db.data.daily[id] || {};
  let up = 0, n = 0;
  for (let i = 0; i < days; i++) {
    const d = daily[db.dayKey(Date.now() - i * 86400000)];
    if (d) { up += d.up; n += d.n; }
  }
  return n ? (up / n) * 100 : null;
}
function dailyBars(id, days = 90) {
  const daily = db.data.daily[id] || {};
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = db.dayKey(Date.now() - i * 86400000);
    const d = daily[k];
    out.push(d ? { d: k, u: +((d.up / d.n) * 100).toFixed(2), p: d.pn ? Math.round(d.p / d.pn) : null, down: d.n - d.up } : { d: k, u: null });
  }
  return out;
}
function currentStatus(m) {
  if (!m.active) return -1; // en pause
  const st = monitor.getState(m.id);
  if (st.lastBeat) return st.lastBeat.s;
  const last = (db.data.beats[m.id] || []).slice(-1)[0];
  return last ? last.s : 2;
}
function target(m) {
  if (['http', 'keyword', 'json'].includes(m.type)) return m.url;
  return m.hostname + (m.port && m.type === 'tcp' ? ':' + m.port : '');
}
function monitorSummary(m, admin) {
  const st = monitor.getState(m.id);
  const s24 = rawStats(m.id, 24);
  const base = {
    id: m.id, name: m.name, group: m.group, description: m.description, type: m.type,
    status: currentStatus(m),
    uptime24: s24.uptime, uptime7: dailyUptime(m.id, 7), uptime30: dailyUptime(m.id, 30), uptime90: dailyUptime(m.id, 90),
    avgPing24: s24.avgPing,
    ping: st.lastBeat ? st.lastBeat.p : null,
    bars: dailyBars(m.id),
    recent: (db.data.beats[m.id] || []).slice(-60).map((b) => ({ t: b.t, s: b.s, p: b.p, ...(admin ? { m: b.m } : {}) })),
  };
  if (admin || m.showTarget) base.target = target(m);
  if (admin) Object.assign(base, { config: m, cert: st.cert || null, lastMsg: st.lastBeat ? st.lastBeat.m : null });
  return base;
}
function publicIncident(i) {
  return { id: i.id, title: i.title, content: i.content, severity: i.severity, status: i.status, createdAt: i.createdAt, updatedAt: i.updatedAt, resolvedAt: i.resolvedAt, startsAt: i.startsAt, endsAt: i.endsAt, monitorIds: i.monitorIds, updates: i.updates || [] };
}

// ───────────────────────── SSE ─────────────────────────
const clients = new Set();
function broadcast(evt) {
  const m = db.data.monitors.find((x) => x.id === evt.monitorId);
  for (const c of clients) {
    if (!c.admin && (!m || !m.isPublic)) continue;
    const beat = c.admin ? evt.beat : { t: evt.beat.t, s: evt.beat.s, p: evt.beat.p };
    c.res.write(`event: beat\ndata: ${JSON.stringify({ monitorId: evt.monitorId, beat })}\n\n`);
  }
}
function broadcastRefresh() {
  for (const c of clients) c.res.write('event: refresh\ndata: {}\n\n');
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000);

// ───────────────────────── Routeur ─────────────────────────
const routes = [];
const route = (method, pattern, handler, auth = false) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
};

// Public
route('GET', '/api/status', (req, res) => {
  const s = db.data.settings;
  const monitors = db.data.monitors.filter((m) => m.isPublic && m.active).map((m) => monitorSummary(m, false));
  const now = Date.now();
  const incidents = db.data.incidents
    .filter((i) => i.status !== 'resolved' || (i.resolvedAt && now - new Date(i.resolvedAt).getTime() < 7 * 86400000))
    .filter((i) => i.severity !== 'maintenance' || !i.endsAt || new Date(i.endsAt).getTime() > now - 86400000 || i.status !== 'resolved')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(publicIncident);
  send(res, 200, { title: s.title, description: s.description, logoUrl: s.logoUrl || '', footer: s.footer || '', monitors, incidents, setup: !s.adminHash });
});
route('GET', '/api/incidents/history', (req, res) => {
  send(res, 200, db.data.incidents.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100).map(publicIncident));
});
route('GET', '/api/badge/:id', (req, res, p) => {
  const m = db.data.monitors.find((x) => x.id === Number(p.id) && x.isPublic);
  if (!m) return send(res, 404, { error: 'Introuvable' });
  const s = currentStatus(m);
  const u = rawStats(m.id, 24).uptime;
  const label = 'status';
  const val = s === 1 ? `up ${u != null ? u.toFixed(1) + '%' : ''}`.trim() : s === 0 ? 'down' : s === 3 ? 'maintenance' : 'pending';
  const col = s === 1 ? '#2ecc71' : s === 0 ? '#e74c3c' : s === 3 ? '#3498db' : '#f1c40f';
  const lw = 48, vw = 8 + val.length * 7;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
  res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${col}"/><g fill="#fff" font-family="Verdana,sans-serif" font-size="11"><text x="6" y="14">${label}</text><text x="${lw + 5}" y="14">${val}</text></g></svg>`);
});
route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const c = { res, admin: isAuthed(req) };
  clients.add(c);
  req.on('close', () => clients.delete(c));
});

// Auth
route('GET', '/api/me', (req, res) => send(res, 200, { authed: isAuthed(req), setup: !db.data.settings.adminHash }));
route('POST', '/api/setup', async (req, res) => {
  if (db.data.settings.adminHash) return send(res, 400, { error: 'Déjà configuré' });
  const b = await readBody(req);
  if (!b.password || String(b.password).length < 8) return send(res, 400, { error: 'Mot de passe : 8 caractères minimum' });
  setPassword(String(b.password));
  newSession(res);
  send(res, 200, { ok: true });
});
route('POST', '/api/login', async (req, res) => {
  const ip = req.socket.remoteAddress;
  const a = loginAttempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return send(res, 429, { error: 'Trop de tentatives, réessaie dans quelques minutes' });
  const b = await readBody(req);
  if (!checkPassword(String(b.password || ''))) {
    a.n++;
    if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; }
    loginAttempts.set(ip, a);
    return send(res, 401, { error: 'Mot de passe incorrect' });
  }
  loginAttempts.delete(ip);
  newSession(res);
  send(res, 200, { ok: true });
});
route('POST', '/api/logout', (req, res) => {
  sessions.delete(parseCookies(req).cs_session);
  res.setHeader('Set-Cookie', 'cs_session=; HttpOnly; Path=/; Max-Age=0');
  send(res, 200, { ok: true });
});

// Monitors (admin)
route('GET', '/api/monitors', (req, res) => send(res, 200, db.data.monitors.map((m) => monitorSummary(m, true))), true);
route('POST', '/api/monitors', async (req, res) => {
  const m = sanitizeMonitor(await readBody(req));
  m.id = db.nextId();
  m.createdAt = new Date().toISOString();
  db.data.monitors.push(m);
  db.save();
  monitor.start(m);
  send(res, 200, monitorSummary(m, true));
}, true);
route('PUT', '/api/monitors/:id', async (req, res, p) => {
  const i = db.data.monitors.findIndex((x) => x.id === Number(p.id));
  if (i < 0) return send(res, 404, { error: 'Introuvable' });
  const m = sanitizeMonitor(await readBody(req), db.data.monitors[i]);
  db.data.monitors[i] = m;
  db.save();
  monitor.start(m);
  send(res, 200, monitorSummary(m, true));
}, true);
route('POST', '/api/monitors/:id/toggle', (req, res, p) => {
  const i = db.data.monitors.findIndex((x) => x.id === Number(p.id));
  if (i < 0) return send(res, 404, { error: 'Introuvable' });
  const m = { ...db.data.monitors[i], active: !db.data.monitors[i].active };
  db.data.monitors[i] = m;
  db.save();
  if (m.active) monitor.start(m); else monitor.stop(m.id);
  send(res, 200, monitorSummary(m, true));
}, true);
route('DELETE', '/api/monitors/:id', (req, res, p) => {
  const id = Number(p.id);
  db.data.monitors = db.data.monitors.filter((x) => x.id !== id);
  monitor.forget(id);
  db.removeMonitorData(id);
  send(res, 200, { ok: true });
}, true);
route('GET', '/api/monitors/:id/beats', (req, res, p, q) => {
  const hours = clamp(q.get('hours'), 1, 168, 24);
  const since = Date.now() - hours * 3600 * 1000;
  send(res, 200, (db.data.beats[Number(p.id)] || []).filter((b) => b.t >= since));
}, true);
route('POST', '/api/monitors/test', async (req, res) => {
  const m = sanitizeMonitor(await readBody(req));
  try { const r = await monitor.runCheck(m); send(res, 200, { ok: true, ping: r.ping, msg: r.msg }); }
  catch (e) { send(res, 200, { ok: false, msg: e.message }); }
}, true);

// Incidents (admin)
const SEVERITIES = ['info', 'warning', 'danger', 'maintenance'];
const ISTATUS = ['investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'inprogress'];
function sanitizeIncident(b, existing = {}) {
  const i = {
    ...existing,
    title: str(b.title, 200) || 'Incident',
    content: str(b.content, 5000),
    severity: SEVERITIES.includes(b.severity) ? b.severity : 'warning',
    status: ISTATUS.includes(b.status) ? b.status : 'investigating',
    monitorIds: Array.isArray(b.monitorIds) ? b.monitorIds.map(Number).filter(Number.isFinite) : [],
    startsAt: b.startsAt ? new Date(b.startsAt).toISOString() : null,
    endsAt: b.endsAt ? new Date(b.endsAt).toISOString() : null,
    updatedAt: new Date().toISOString(),
  };
  if (i.status === 'resolved' && !i.resolvedAt) i.resolvedAt = new Date().toISOString();
  if (i.status !== 'resolved') i.resolvedAt = null;
  return i;
}
route('GET', '/api/incidents', (req, res) => send(res, 200, db.data.incidents.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))), true);
route('POST', '/api/incidents', async (req, res) => {
  const i = sanitizeIncident(await readBody(req));
  i.id = db.nextId();
  i.createdAt = new Date().toISOString();
  i.updates = [{ at: i.createdAt, status: i.status, text: i.content }];
  db.data.incidents.push(i);
  db.save(); broadcastRefresh();
  send(res, 200, i);
}, true);
route('PUT', '/api/incidents/:id', async (req, res, p) => {
  const idx = db.data.incidents.findIndex((x) => x.id === Number(p.id));
  if (idx < 0) return send(res, 404, { error: 'Introuvable' });
  const b = await readBody(req);
  const i = sanitizeIncident(b, db.data.incidents[idx]);
  if (b.updateText) i.updates = [...(i.updates || []), { at: new Date().toISOString(), status: i.status, text: str(b.updateText, 5000) }];
  db.data.incidents[idx] = i;
  db.save(); broadcastRefresh();
  send(res, 200, i);
}, true);
route('DELETE', '/api/incidents/:id', (req, res, p) => {
  db.data.incidents = db.data.incidents.filter((x) => x.id !== Number(p.id));
  db.save(); broadcastRefresh();
  send(res, 200, { ok: true });
}, true);

// Notifications (admin)
const NTYPES = ['discord', 'slack', 'telegram', 'webhook', 'ntfy'];
function sanitizeNotif(b, existing = {}) {
  const c = b.config || {};
  return {
    ...existing,
    name: str(b.name, 100) || 'Notification',
    type: NTYPES.includes(b.type) ? b.type : 'webhook',
    applyAll: !!b.applyAll,
    active: b.active !== false,
    config: { webhookUrl: str(c.webhookUrl, 1000), username: str(c.username, 100), botToken: str(c.botToken, 200), chatId: str(c.chatId, 100), url: str(c.url, 1000), server: str(c.server, 500), topic: str(c.topic, 200) },
  };
}
route('GET', '/api/notifications', (req, res) => send(res, 200, db.data.notifications), true);
route('POST', '/api/notifications', async (req, res) => {
  const n = sanitizeNotif(await readBody(req));
  n.id = db.nextId();
  db.data.notifications.push(n); db.save();
  send(res, 200, n);
}, true);
route('PUT', '/api/notifications/:id', async (req, res, p) => {
  const idx = db.data.notifications.findIndex((x) => x.id === Number(p.id));
  if (idx < 0) return send(res, 404, { error: 'Introuvable' });
  db.data.notifications[idx] = sanitizeNotif(await readBody(req), db.data.notifications[idx]); db.save();
  send(res, 200, db.data.notifications[idx]);
}, true);
route('DELETE', '/api/notifications/:id', (req, res, p) => {
  const id = Number(p.id);
  db.data.notifications = db.data.notifications.filter((x) => x.id !== id);
  db.data.monitors.forEach((m) => { m.notificationIds = (m.notificationIds || []).filter((x) => x !== id); });
  db.save();
  send(res, 200, { ok: true });
}, true);
route('POST', '/api/notifications/test', async (req, res) => {
  const n = sanitizeNotif(await readBody(req));
  try {
    await notify.send(n, { monitor: { id: 0, name: 'Test Craftpick Status', type: 'http', url: 'https://exemple.fr' }, status: 1, msg: 'Ceci est une notification de test 🎉', ping: 42 });
    send(res, 200, { ok: true });
  } catch (e) { send(res, 200, { ok: false, error: e.message }); }
}, true);

// Paramètres (admin)
route('GET', '/api/settings', (req, res) => {
  const { title, description, logoUrl, footer } = db.data.settings;
  send(res, 200, { title, description, logoUrl: logoUrl || '', footer: footer || '' });
}, true);
route('PUT', '/api/settings', async (req, res) => {
  const b = await readBody(req);
  const s = db.data.settings;
  s.title = str(b.title, 100) || s.title;
  s.description = str(b.description, 500);
  s.logoUrl = str(b.logoUrl, 1000);
  s.footer = str(b.footer, 500);
  if (b.newPassword) {
    if (!checkPassword(String(b.currentPassword || ''))) return send(res, 400, { error: 'Mot de passe actuel incorrect' });
    if (String(b.newPassword).length < 8) return send(res, 400, { error: 'Nouveau mot de passe : 8 caractères minimum' });
    setPassword(String(b.newPassword));
    sessions.clear();
    newSession(res);
  }
  db.save(); broadcastRefresh();
  send(res, 200, { ok: true });
}, true);
route('GET', '/api/export', (req, res) => {
  const { monitors, incidents, notifications } = db.data;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="craftpick-status-backup.json"' });
  res.end(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), monitors, incidents, notifications }, null, 2));
}, true);
route('POST', '/api/import', async (req, res) => {
  const b = await readBody(req);
  if (!Array.isArray(b.monitors)) return send(res, 400, { error: 'Fichier de sauvegarde invalide' });
  const idMap = {};
  for (const n of b.notifications || []) { const nn = sanitizeNotif(n); nn.id = db.nextId(); idMap[n.id] = nn.id; db.data.notifications.push(nn); }
  let count = 0;
  for (const raw of b.monitors) {
    try {
      const m = sanitizeMonitor({ ...raw, notificationIds: (raw.notificationIds || []).map((x) => idMap[x]).filter(Boolean) });
      m.id = db.nextId(); m.createdAt = new Date().toISOString();
      db.data.monitors.push(m); monitor.start(m); count++;
    } catch {}
  }
  db.save();
  send(res, 200, { ok: true, imported: count });
}, true);

// ───────────────────────── Fichiers statiques ─────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/status.html';
  else if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  else if (pathname === '/history') pathname = '/history.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = url.pathname.match(r.re);
      if (!match) continue;
      if (r.auth && !isAuthed(req)) return send(res, 401, { error: 'Non authentifié' });
      // Protection CSRF basique : les mutations doivent venir d'un fetch JSON
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json') && !['/api/logout'].includes(url.pathname)) {
        return send(res, 415, { error: 'Content-Type application/json requis' });
      }
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match[i + 1])));
      try { return await r.handler(req, res, params, url.searchParams); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    return send(res, 404, { error: 'Route inconnue' });
  }
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  res.writeHead(405); res.end();
});

monitor.startAll(broadcast);
server.listen(PORT, HOST, () => {
  console.log(`\n  Craftpick Status démarré`);
  console.log(`  Page publique : http://localhost:${PORT}/`);
  console.log(`  Administration : http://localhost:${PORT}/admin\n`);
});

function shutdown() { try { db.saveNow(); } catch {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
