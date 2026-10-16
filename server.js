// Craftpick Status — serveur HTTP, API REST, temps réel (SSE), authentification
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./lib/db');
const monitor = require('./lib/monitor');
const notify = require('./lib/notify');
const schedule = require('./lib/schedule');
const discordLive = require('./lib/discordLive');
const report = require('./lib/report');

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

db.load();

// ───────────────────────── Auth ─────────────────────────
// Sessions persistées (hash SHA-256 du jeton -> expiration) : on reste connecté après un redémarrage
const SESSION_MS = 30 * 24 * 3600 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
const loginAttempts = new Map(); // ip -> {n, until}
db.data.sessions ||= {};
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const sessions = {
  get: (t) => db.data.sessions[sha(t)],
  set: (t, exp) => { db.data.sessions[sha(t)] = exp; db.save(); },
  delete: (t) => { if (t) { delete db.data.sessions[sha(t)]; db.save(); } },
  clear: () => { db.data.sessions = {}; db.save(); },
};
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of Object.entries(db.data.sessions)) if (exp < now) delete db.data.sessions[k];
}, 3600e3).unref();
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress;
}
function isHttps(req) {
  return req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').startsWith('https'));
}

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
function newSession(req, res) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `cs_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`);
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

const MONITOR_TYPES = ['http', 'keyword', 'json', 'tcp', 'ping', 'dns', 'push', 'minecraft', 'proxmox', 'database'];
// Champs secrets : jamais renvoyés au navigateur ; laissés vides dans le formulaire = valeur conservée
const SECRET_FIELDS = ['basicAuthPass', 'pveTokenSecret', 'dbPassword'];
function sanitizeMonitor(b, existing = {}) {
  b = { ...b };
  for (const f of SECRET_FIELDS) if (!b[f] && existing[f]) b[f] = existing[f];
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
    resendEvery: clamp(b.resendEvery, 0, 1000, 0),
    basicAuthUser: str(b.basicAuthUser, 200),
    basicAuthPass: str(b.basicAuthPass, 200),
    pushToken: existing.pushToken
      || (/^[A-Za-z0-9]{16,64}$/.test(b.pushToken || '') && !db.data.monitors.some((x) => x.pushToken === b.pushToken) ? b.pushToken : crypto.randomBytes(16).toString('hex')),
    // Dépendance : monitor parent (ex. nœud Proxmox pour une VM)
    parentId: b.parentId ? Number(b.parentId) : null,
    // Statut dégradé
    degradedMs: clamp(b.degradedMs, 0, 300000, 0),
    notifyDegraded: !!b.notifyDegraded,
    // Minecraft
    mcEdition: b.mcEdition === 'bedrock' ? 'bedrock' : 'java',
    // Base de données
    dbKind: ['mysql', 'postgres', 'redis'].includes(b.dbKind) ? b.dbKind : 'mysql',
    dbUser: str(b.dbUser, 100),
    dbPassword: str(b.dbPassword, 200),
    // Proxmox
    pveNode: str(b.pveNode, 100),
    pveTokenId: str(b.pveTokenId, 200),
    pveTokenSecret: str(b.pveTokenSecret, 200),
    pveVmids: str(b.pveVmids, 500),
    pveCpu: clamp(b.pveCpu, 0, 100, 0),
    pveMem: clamp(b.pveMem, 0, 100, 0),
    pveDisk: clamp(b.pveDisk, 0, 100, 0),
  };
  if (['http', 'keyword', 'json', 'proxmox'].includes(m.type) && !/^https?:\/\//i.test(m.url)) throw new Error("L'URL doit commencer par http:// ou https://");
  if (['tcp', 'ping', 'dns', 'minecraft', 'database'].includes(m.type) && !m.hostname) throw new Error('Nom d’hôte requis');
  if (m.parentId) {
    if (!db.data.monitors.some((x) => x.id === m.parentId)) m.parentId = null;
    else {
      // pas de boucle : on remonte la chaîne des parents
      let cur = m.parentId, guard = 0;
      while (cur && guard++ < 20) {
        if (existing.id && cur === existing.id) throw new Error('Dépendance circulaire : ce monitor ne peut pas dépendre de lui-même (directement ou non)');
        const pm = db.data.monitors.find((x) => x.id === cur);
        cur = pm ? pm.parentId : null;
      }
    }
  }
  if (m.type === 'proxmox' && (!m.pveNode || !m.pveTokenId || !m.pveTokenSecret)) throw new Error('Nœud, ID du jeton et secret Proxmox requis');
  if (m.type === 'proxmox' && !/^[^@\s]+@[^!\s]+![^\s=]+$/.test(m.pveTokenId)) throw new Error('ID du jeton au format utilisateur@realm!nom (ex. root@pam!status)');
  if (m.type === 'tcp' && !m.port) throw new Error('Port requis');
  if (m.type === 'keyword' && !m.keyword) throw new Error('Mot-clé requis');
  if (m.type === 'json' && !m.jsonPath) throw new Error('Chemin JSON requis');
  return m;
}

// ───────────────────────── Statistiques ─────────────────────────
function rawStats(id, hours) {
  const since = Date.now() - hours * 3600 * 1000;
  const beats = (db.data.beats[id] || []).filter((b) => b.t >= since && b.s !== 2);
  const up = beats.filter((b) => b.s === 1 || b.s === 3 || b.s === 4).length;
  const pings = beats.filter((b) => (b.s === 1 || b.s === 4) && typeof b.p === 'number').map((b) => b.p);
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
    out.push(d ? { d: k, u: +((d.up / d.n) * 100).toFixed(2), p: d.pn ? Math.round(d.p / d.pn) : null, down: d.n - d.up, dg: d.dg || 0 } : { d: k, u: null });
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
  if (m.type === 'push') return 'Push (heartbeat)';
  if (m.type === 'proxmox') return `${m.url} · nœud ${m.pveNode}`;
  if (m.type === 'database') return `${{ mysql: 'MySQL', postgres: 'PostgreSQL', redis: 'Redis' }[m.dbKind]} · ${m.hostname}${m.port ? ':' + m.port : ''}`;
  if (m.type === 'minecraft') return m.hostname + (m.port ? ':' + m.port : '') + (m.mcEdition === 'bedrock' ? ' (Bedrock)' : '');
  return m.hostname + (m.port && m.type === 'tcp' ? ':' + m.port : '');
}
// Joueurs Minecraft : maximum par heure sur les dernières 24 h
function playersSeries(id) {
  const now = Date.now();
  const out = Array(24).fill(null);
  for (const b of db.data.beats[id] || []) {
    if (b.pl == null || now - b.t > 24 * 3600e3) continue;
    const h = 23 - Math.floor((now - b.t) / 3600e3);
    if (h >= 0) out[h] = Math.max(out[h] ?? 0, b.pl);
  }
  return out;
}
function publicConfig(m) {
  const c = { ...m };
  c.secretsSet = {};
  for (const f of SECRET_FIELDS) { c.secretsSet[f] = !!m[f]; c[f] = ''; }
  return c;
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
    recent: (db.data.beats[m.id] || []).slice(-60).map((b) => ({ t: b.t, s: b.s, p: b.p, ...(b.pl != null ? { pl: b.pl } : {}), ...(admin ? { m: b.m } : {}) })),
  };
  if (admin || m.showTarget) base.target = target(m);
  if (m.type === 'minecraft') {
    const x = st.extra && st.extra.kind === 'minecraft' ? st.extra : null;
    base.mc = x && (base.status === 1 || base.status === 4) ? { online: x.online, max: x.max, version: x.version, motd: x.motd } : null;
    base.players24 = playersSeries(m.id);
  }
  if (admin) Object.assign(base, { config: publicConfig(m), cert: st.cert || null, extra: st.extra || null, lastMsg: st.lastBeat ? st.lastBeat.m : null, pushPath: `/api/push/${m.pushToken}` });
  return base;
}

// ───────────────────────── Pages de status ─────────────────────────
db.data.pages ||= [];
db.data.settings.pageSecret ||= crypto.randomBytes(32).toString('hex');
const pageCookie = (p) => `cs_p${p.id}`;
const pageToken = (p) => crypto.createHmac('sha256', db.data.settings.pageSecret).update(`${p.id}:${p.passwordHash}`).digest('hex');
function pageAccess(req, p) {
  if (!p.passwordHash || isAuthed(req)) return true;
  const c = parseCookies(req)[pageCookie(p)];
  const t = pageToken(p);
  return !!c && c.length === t.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(t));
}
const findPage = (slug) => db.data.pages.find((p) => p.slug === String(slug || '').toLowerCase());
// Monitors visibles : ceux de la page, sinon tous les monitors publics
function visibleMonitorIds(page) {
  if (page) return new Set(page.monitorIds || []);
  return new Set(db.data.monitors.filter((m) => m.isPublic).map((m) => m.id));
}
// Un incident est visible s'il ne cible aucun monitor (global) ou au moins un monitor visible
function visibleIncidents(ids) {
  return db.data.incidents
    .filter((i) => !i.monitorIds || !i.monitorIds.length || i.monitorIds.some((id) => ids.has(id)))
    .map((i) => ({ ...publicIncident(i), monitorIds: (i.monitorIds || []).filter((id) => ids.has(id)) }));
}
// Résout ?page=<slug> : renvoie { page } ou envoie l'erreur (404 / 401 verrouillée)
function resolvePage(req, res, q) {
  const slug = q.get('page');
  if (!slug) return { page: null };
  const page = findPage(slug);
  if (!page) { send(res, 404, { error: 'Page introuvable' }); return null; }
  if (!pageAccess(req, page)) { send(res, 401, { locked: true, title: page.title }); return null; }
  return { page };
}
function sanitizePage(b, existing = {}) {
  const slug = String(b.slug || '').toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error('Adresse : lettres minuscules, chiffres et tirets (40 max)');
  if (db.data.pages.some((p) => p.slug === slug && p.id !== existing.id)) throw new Error('Cette adresse est déjà utilisée');
  const p = {
    ...existing,
    slug,
    title: str(b.title, 100) || slug,
    description: str(b.description, 500),
    logoUrl: str(b.logoUrl, 1000),
    footer: str(b.footer, 500),
    monitorIds: Array.isArray(b.monitorIds) ? b.monitorIds.map(Number).filter((id) => db.data.monitors.some((m) => m.id === id)) : [],
  };
  if (b.removePassword) { p.passwordHash = null; p.salt = null; }
  else if (b.password) {
    if (String(b.password).length < 4) throw new Error('Mot de passe de la page : 4 caractères minimum');
    p.salt = crypto.randomBytes(16).toString('hex');
    p.passwordHash = hashPassword(String(b.password), p.salt);
  }
  return p;
}
const adminPage = (p) => ({ id: p.id, slug: p.slug, title: p.title, description: p.description, logoUrl: p.logoUrl, footer: p.footer, monitorIds: p.monitorIds, protected: !!p.passwordHash });
function publicIncident(i) {
  return {
    id: i.id, title: i.title, content: i.content, severity: i.severity, status: i.status, createdAt: i.createdAt, updatedAt: i.updatedAt, resolvedAt: i.resolvedAt,
    startsAt: i.startsAt, endsAt: i.endsAt, monitorIds: i.monitorIds, updates: i.updates || [],
    recurrence: i.recurrence || null, recurrenceText: schedule.describeRecurrence(i.recurrence),
    activeNow: i.severity === 'maintenance' ? schedule.maintenanceActive(i) : i.status !== 'resolved',
  };
}

// ───────────────────────── SSE ─────────────────────────
const clients = new Set();
function broadcast(evt) {
  const m = db.data.monitors.find((x) => x.id === evt.monitorId);
  for (const c of clients) {
    if (!c.admin) {
      if (!m) continue;
      if (c.pageId) {
        const page = db.data.pages.find((p) => p.id === c.pageId);
        if (!page || !(page.monitorIds || []).includes(m.id)) continue;
      } else if (!m.isPublic) continue;
    }
    const beat = c.admin ? evt.beat : { t: evt.beat.t, s: evt.beat.s, p: evt.beat.p, ...(evt.beat.pl != null ? { pl: evt.beat.pl } : {}) };
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
// État d'une page (null = page principale) : utilisé par l'API publique et le message Discord
function buildStatus(page) {
  const s = db.data.settings;
  const ids = visibleMonitorIds(page);
  const monitors = page
    ? (page.monitorIds || []).map((id) => db.data.monitors.find((m) => m.id === id)).filter((m) => m && m.active).map((m) => monitorSummary(m, false))
    : db.data.monitors.filter((m) => m.isPublic && m.active).map((m) => monitorSummary(m, false));
  const now = Date.now();
  const incidents = visibleIncidents(ids)
    .filter((i) => i.status !== 'resolved' || (i.resolvedAt && now - new Date(i.resolvedAt).getTime() < 7 * 86400000))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const meta = page
    ? { title: page.title, description: page.description, logoUrl: page.logoUrl || s.logoUrl || '', footer: page.footer || s.footer || '', page: page.slug }
    : { title: s.title, description: s.description, logoUrl: s.logoUrl || '', footer: s.footer || '' };
  Object.assign(meta, { accentColor: s.accentColor || '', banner: s.banner && s.banner.text ? s.banner : null, customCss: s.customCss || '' });
  const base = (s.publicUrl || '').replace(/\/+$/, '');
  return { ...meta, monitors, incidents, setup: !s.adminHash, url: base ? base + (page ? '/s/' + page.slug : '/') : '' };
}
route('GET', '/api/status', (req, res, p, q) => {
  const r = resolvePage(req, res, q);
  if (!r) return;
  send(res, 200, buildStatus(r.page));
});
route('GET', '/api/incidents/history', (req, res, p, q) => {
  const r = resolvePage(req, res, q);
  if (!r) return;
  const list = visibleIncidents(visibleMonitorIds(r.page)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100);
  send(res, 200, list);
});
// Page détaillée d'un service : ?page=<slug> si le service n'est visible que sur une page dédiée
route('GET', '/api/service/:id', (req, res, p, q) => {
  const r = resolvePage(req, res, q);
  if (!r) return;
  const id = Number(p.id);
  const ids = visibleMonitorIds(r.page);
  const m = db.data.monitors.find((x) => x.id === id && x.active);
  if (!m || !ids.has(id)) return send(res, 404, { error: 'Service introuvable' });
  const hours = clamp(q.get('hours'), 1, 168, 24);
  const since = Date.now() - hours * 3600e3;
  // échantillonnage : ~300 points (ping moyen, pire statut, joueurs max)
  const raw = (db.data.beats[id] || []).filter((b) => b.t >= since);
  const size = Math.max(1, Math.ceil(raw.length / 300));
  const rank = { 0: 5, 4: 4, 3: 3, 2: 2, 1: 1 };
  const series = [];
  for (let i = 0; i < raw.length; i += size) {
    const g = raw.slice(i, i + size);
    const pings = g.filter((b) => typeof b.p === 'number').map((b) => b.p);
    const pls = g.filter((b) => b.pl != null).map((b) => b.pl);
    series.push({
      t: g[g.length - 1].t,
      s: g.reduce((w, b) => ((rank[b.s] || 0) > (rank[w] || 0) ? b.s : w), g[0].s),
      p: pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : null,
      ...(pls.length ? { pl: Math.max(...pls) } : {}),
    });
  }
  const s = db.data.settings;
  send(res, 200, {
    site: { title: r.page ? r.page.title : s.title, logoUrl: (r.page && r.page.logoUrl) || s.logoUrl || '', accentColor: s.accentColor || '', customCss: s.customCss || '', page: r.page ? r.page.slug : null },
    monitor: monitorSummary(m, false),
    series,
    incidents: visibleIncidents(ids).filter((i) => (i.monitorIds || []).includes(id)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 20),
  });
});

// Déverrouillage d'une page protégée par mot de passe
route('POST', '/api/pages/:slug/unlock', async (req, res, p) => {
  const page = findPage(p.slug);
  if (!page) return send(res, 404, { error: 'Page introuvable' });
  if (!page.passwordHash) return send(res, 200, { ok: true });
  const ip = clientIp(req);
  const a = loginAttempts.get('p' + ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return send(res, 429, { error: 'Trop de tentatives, réessaie dans quelques minutes' });
  const b = await readBody(req);
  const h = Buffer.from(hashPassword(String(b.password || ''), page.salt), 'hex');
  const ref = Buffer.from(page.passwordHash, 'hex');
  if (h.length !== ref.length || !crypto.timingSafeEqual(h, ref)) {
    a.n++; if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; }
    loginAttempts.set('p' + ip, a);
    return send(res, 401, { error: 'Mot de passe incorrect' });
  }
  loginAttempts.delete('p' + ip);
  res.setHeader('Set-Cookie', `${pageCookie(page)}=${pageToken(page)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${isHttps(req) ? '; Secure' : ''}`);
  send(res, 200, { ok: true });
});
route('GET', '/api/badge/:id', (req, res, p) => {
  const m = db.data.monitors.find((x) => x.id === Number(p.id) && x.isPublic);
  if (!m) return send(res, 404, { error: 'Introuvable' });
  const s = currentStatus(m);
  const u = rawStats(m.id, 24).uptime;
  const label = 'status';
  const val = s === 1 ? `up ${u != null ? u.toFixed(1) + '%' : ''}`.trim() : s === 4 ? 'degraded' : s === 0 ? 'down' : s === 3 ? 'maintenance' : 'pending';
  const col = s === 1 ? '#2ecc71' : s === 4 ? '#f39c12' : s === 0 ? '#e74c3c' : s === 3 ? '#3498db' : '#f1c40f';
  const lw = 48, vw = 8 + val.length * 7;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
  res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${col}"/><g fill="#fff" font-family="Verdana,sans-serif" font-size="11"><text x="6" y="14">${label}</text><text x="${lw + 5}" y="14">${val}</text></g></svg>`);
});
route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const c = { res, admin: isAuthed(req) };
  const slug = new URL(req.url, 'http://x').searchParams.get('page');
  if (slug && !c.admin) {
    const page = findPage(slug);
    c.pageId = page && pageAccess(req, page) ? page.id : -1; // -1 : aucun événement
  }
  clients.add(c);
  req.on('close', () => clients.delete(c));
});

// Push (heartbeat) : GET ou POST /api/push/<token>?status=up|down&msg=...&ping=...
async function handlePush(req, res, p, q) {
  const m = db.data.monitors.find((x) => x.type === 'push' && x.pushToken === p.token);
  if (!m) return send(res, 404, { ok: false, error: 'Jeton inconnu' });
  if (!m.active) return send(res, 200, { ok: false, error: 'Monitor en pause' });
  let body = {};
  if (req.method === 'POST') body = await readBody(req).catch(() => ({}));
  const status = String(q.get('status') || body.status || 'up').toLowerCase();
  monitor.receivePush(m, { status: ['down', 'degraded'].includes(status) ? status : 'up', msg: q.get('msg') || body.msg, ping: q.get('ping') ?? body.ping });
  send(res, 200, { ok: true });
}
route('GET', '/api/push/:token', handlePush);
route('POST', '/api/push/:token', handlePush);

// Santé du serveur (pour Docker / un autre outil de monitoring)
route('GET', '/api/health', (req, res) => send(res, 200, { ok: true, uptime: Math.round(process.uptime()), monitors: db.data.monitors.length }));

// Flux RSS des incidents
const xml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
route('GET', '/api/feed.xml', (req, res) => {
  const s = db.data.settings;
  const base = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host || 'localhost'}`;
  const items = visibleIncidents(visibleMonitorIds(null)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50).map((i) => {
    const last = (i.updates || []).slice(-1)[0];
    return `<item><title>${xml(i.title)}</title><link>${base}/history#i-${i.id}</link><guid isPermaLink="false">incident-${i.id}-${xml(i.updatedAt || i.createdAt)}</guid><pubDate>${new Date(i.updatedAt || i.createdAt).toUTCString()}</pubDate><description>${xml(`[${i.status}] ${last ? last.text : i.content}`)}</description></item>`;
  }).join('');
  res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(s.title)} — Incidents</title><link>${base}/</link><description>${xml(s.description)}</description>${items}</channel></rss>`);
});

// Auth
route('GET', '/api/me', (req, res) => send(res, 200, { authed: isAuthed(req), setup: !db.data.settings.adminHash }));
route('POST', '/api/setup', async (req, res) => {
  if (db.data.settings.adminHash) return send(res, 400, { error: 'Déjà configuré' });
  const b = await readBody(req);
  if (!b.password || String(b.password).length < 8) return send(res, 400, { error: 'Mot de passe : 8 caractères minimum' });
  setPassword(String(b.password));
  newSession(req, res);
  send(res, 200, { ok: true });
});
route('POST', '/api/login', async (req, res) => {
  const ip = clientIp(req);
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
  newSession(req, res);
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
  db.data.pages.forEach((pg) => { pg.monitorIds = (pg.monitorIds || []).filter((x) => x !== id); });
  db.data.monitors.forEach((x) => { if (x.parentId === id) x.parentId = null; });
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
  if (m.type === 'push') return send(res, 200, { ok: false, msg: 'Un monitor push ne peut pas être testé : il attend les appels de ton service.' });
  try {
    const r = await monitor.runCheck(m);
    const beat = { s: 1, p: r.ping, m: r.msg };
    monitor.applyDegraded(m, beat, r.degraded);
    send(res, 200, { ok: true, degraded: beat.s === 4, ping: r.ping, msg: beat.m });
  }
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
    recurrence: b.severity === 'maintenance' && b.recurrence ? schedule.sanitizeRecurrence(b.recurrence) : null,
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
const NTYPES = ['discord', 'slack', 'telegram', 'webhook', 'ntfy', 'gotify', 'pushover', 'email'];
function sanitizeNotif(b, existing = {}) {
  const c = b.config || {};
  return {
    ...existing,
    name: str(b.name, 100) || 'Notification',
    type: NTYPES.includes(b.type) ? b.type : 'webhook',
    applyAll: !!b.applyAll,
    active: b.active !== false,
    config: { webhookUrl: str(c.webhookUrl, 1000), username: str(c.username, 100), botToken: str(c.botToken, 200), chatId: str(c.chatId, 100), url: str(c.url, 1000), server: str(c.server, 500), topic: str(c.topic, 200), token: str(c.token, 200), userKey: str(c.userKey, 200),
      smtpHost: str(c.smtpHost, 200), smtpPort: str(c.smtpPort, 6), smtpSecure: !!c.smtpSecure, smtpUser: str(c.smtpUser, 200), smtpPass: str(c.smtpPass, 200), mailFrom: str(c.mailFrom, 200), mailTo: str(c.mailTo, 1000) },
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

// Pages de status (admin)
route('GET', '/api/pages', (req, res) => send(res, 200, db.data.pages.map(adminPage)), true);
route('POST', '/api/pages', async (req, res) => {
  const p = sanitizePage(await readBody(req));
  p.id = db.nextId();
  db.data.pages.push(p); db.save();
  send(res, 200, adminPage(p));
}, true);
route('PUT', '/api/pages/:id', async (req, res, prm) => {
  const idx = db.data.pages.findIndex((x) => x.id === Number(prm.id));
  if (idx < 0) return send(res, 404, { error: 'Introuvable' });
  db.data.pages[idx] = sanitizePage(await readBody(req), db.data.pages[idx]); db.save(); broadcastRefresh();
  send(res, 200, adminPage(db.data.pages[idx]));
}, true);
route('DELETE', '/api/pages/:id', (req, res, prm) => {
  db.data.pages = db.data.pages.filter((x) => x.id !== Number(prm.id)); db.save();
  send(res, 200, { ok: true });
}, true);

// Paramètres (admin)
route('GET', '/api/settings', (req, res) => {
  const { title, description, logoUrl, footer, publicUrl, discordLive: dl, weeklyReport: wr, accentColor, banner, customCss } = db.data.settings;
  send(res, 200, {
    title, description, logoUrl: logoUrl || '', footer: footer || '', publicUrl: publicUrl || '',
    accentColor: accentColor || '', banner: { text: '', level: 'info', link: '', ...(banner || {}) }, customCss: customCss || '',
    backups: db.listBackups(),
    discordLive: { enabled: false, webhookUrl: '', page: '', username: '', ...(dl || {}) },
    weeklyReport: { enabled: false, day: 1, hour: 9, notificationIds: [], ...(wr || {}) },
    pages: db.data.pages.map((pg) => ({ slug: pg.slug, title: pg.title, protected: !!pg.passwordHash })),
  });
}, true);
route('PUT', '/api/settings', async (req, res) => {
  const b = await readBody(req);
  const s = db.data.settings;
  s.title = str(b.title, 100) || s.title;
  s.description = str(b.description, 500);
  s.logoUrl = str(b.logoUrl, 1000);
  s.footer = str(b.footer, 500);
  if (b.accentColor !== undefined) {
    if (b.accentColor && !/^#[0-9a-f]{6}$/i.test(b.accentColor)) return send(res, 400, { error: 'Couleur invalide (format #rrggbb)' });
    s.accentColor = b.accentColor || '';
  }
  if (b.banner) s.banner = { text: str(b.banner.text, 300), level: ['info', 'success', 'warning', 'event'].includes(b.banner.level) ? b.banner.level : 'info', link: /^https?:\/\//.test(b.banner.link || '') ? str(b.banner.link, 500) : '' };
  if (b.customCss !== undefined) s.customCss = str(b.customCss, 20000).replace(/<\/style/gi, '');
  if (b.publicUrl !== undefined) {
    s.publicUrl = str(b.publicUrl, 300).replace(/\/+$/, '');
    if (s.publicUrl && !/^https?:\/\//.test(s.publicUrl)) return send(res, 400, { error: "L'URL publique doit commencer par http:// ou https://" });
  }
  if (b.discordLive) {
    const d = b.discordLive, prev = s.discordLive || {};
    const url = str(d.webhookUrl, 500).trim();
    if (d.enabled && !/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(url) && !process.env.ALLOW_ANY_WEBHOOK) return send(res, 400, { error: 'URL de webhook Discord invalide (https://discord.com/api/webhooks/…)' });
    const page = str(d.page, 40);
    if (page && !findPage(page)) return send(res, 400, { error: 'Page inconnue' });
    s.discordLive = {
      enabled: !!d.enabled, webhookUrl: url, page, username: str(d.username, 80),
      // nouveau webhook ou nouvelle page : on repart sur un nouveau message
      messageId: url === prev.webhookUrl && page === (prev.page || '') ? prev.messageId || null : null,
      lastError: prev.lastError || null,
    };
    discordLive.schedule(1000);
  }
  if (b.weeklyReport) {
    const w = b.weeklyReport;
    s.weeklyReport = {
      ...(s.weeklyReport || {}),
      enabled: !!w.enabled, day: clamp(w.day, 0, 6, 1), hour: clamp(w.hour, 0, 23, 9),
      notificationIds: Array.isArray(w.notificationIds) ? w.notificationIds.map(Number).filter(Number.isFinite) : [],
    };
  }
  if (b.newPassword) {
    if (!checkPassword(String(b.currentPassword || ''))) return send(res, 400, { error: 'Mot de passe actuel incorrect' });
    if (String(b.newPassword).length < 8) return send(res, 400, { error: 'Nouveau mot de passe : 8 caractères minimum' });
    setPassword(String(b.newPassword));
    sessions.clear();
    newSession(req, res);
  }
  db.save(); broadcastRefresh();
  send(res, 200, { ok: true });
}, true);
// Message Discord en direct : publication immédiate
route('POST', '/api/discord-live/publish', async (req, res) => {
  try { send(res, 200, await discordLive.publish()); }
  catch (e) { db.data.settings.discordLive && (db.data.settings.discordLive.lastError = e.message); send(res, 200, { ok: false, error: e.message }); }
}, true);

// Rapport hebdomadaire
function sendWeeklyReport() {
  const wr = db.data.settings.weeklyReport || {};
  const r = report.buildReport({ title: db.data.settings.title });
  const targets = db.data.notifications.filter((n) => n.active !== false && (wr.notificationIds || []).includes(n.id));
  return Promise.allSettled(targets.map((n) => notify.sendText(n, r))).then((res) => ({
    sent: res.filter((x) => x.status === 'fulfilled').length,
    errors: res.map((x, i) => (x.status === 'rejected' ? `${targets[i].name} : ${x.reason.message}` : null)).filter(Boolean),
  }));
}
route('GET', '/api/report/preview', (req, res) => send(res, 200, report.buildReport({ title: db.data.settings.title })), true);
route('POST', '/api/report/send', async (req, res) => {
  const wr = db.data.settings.weeklyReport || {};
  if (!(wr.notificationIds || []).length) return send(res, 400, { error: 'Choisis au moins une notification pour le rapport, puis enregistre' });
  send(res, 200, await sendWeeklyReport());
}, true);
// Planificateur : vérifie toutes les 5 min si c'est le moment d'envoyer le rapport
setInterval(() => {
  const wr = db.data.settings.weeklyReport;
  if (!wr || !wr.enabled) return;
  const now = new Date();
  if (now.getDay() !== wr.day || now.getHours() !== wr.hour) return;
  if (wr.lastSent && Date.now() - wr.lastSent < 6 * 86400000) return;
  wr.lastSent = Date.now(); db.save();
  sendWeeklyReport().then((r) => console.log(`[rapport] envoyé (${r.sent})`, r.errors.join(' ; ')));
}, 5 * 60000).unref();

// Sauvegardes automatiques
route('GET', '/api/backups', (req, res) => send(res, 200, db.listBackups()), true);
route('POST', '/api/backups', (req, res) => { const name = db.backup(true); send(res, 200, { ok: true, name, backups: db.listBackups() }); }, true);
route('GET', '/api/backups/:name', (req, res, p) => {
  const file = db.backupPath(p.name);
  if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'Sauvegarde introuvable' });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${p.name}"` });
  fs.createReadStream(file).pipe(res);
}, true);
// une sauvegarde par jour (vérifiée au démarrage puis toutes les heures)
const dailyBackup = () => { try { const n = db.backup(); if (n) console.log('[sauvegarde]', n); } catch (e) { console.error('[sauvegarde]', e.message); } };
setTimeout(dailyBackup, 10000).unref();
setInterval(dailyBackup, 3600e3).unref();

route('GET', '/api/export', (req, res) => {
  const { monitors, incidents, notifications, pages } = db.data;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="craftpick-status-backup.json"' });
  res.end(JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), monitors, incidents, notifications, pages }, null, 2));
}, true);
route('POST', '/api/import', async (req, res) => {
  const b = await readBody(req);
  if (!Array.isArray(b.monitors)) return send(res, 400, { error: 'Fichier de sauvegarde invalide' });
  const idMap = {};
  for (const n of b.notifications || []) { const nn = sanitizeNotif(n); nn.id = db.nextId(); idMap[n.id] = nn.id; db.data.notifications.push(nn); }
  let count = 0;
  const monIdMap = {};
  for (const raw of b.monitors) {
    try {
      const m = sanitizeMonitor({ ...raw, parentId: null, notificationIds: (raw.notificationIds || []).map((x) => idMap[x]).filter(Boolean) });
      if (raw.parentId) m._importParent = raw.parentId;
      m.id = db.nextId(); m.createdAt = new Date().toISOString();
      monIdMap[raw.id] = m.id;
      db.data.monitors.push(m); monitor.start(m); count++;
    } catch {}
  }
  db.save();
  // Dépendances : on relie aux nouveaux identifiants
  for (const m of db.data.monitors) if (m._importParent) { m.parentId = monIdMap[m._importParent] || null; delete m._importParent; }
  // Pages : on recrée celles dont l'adresse est libre, en conservant leur mot de passe
  for (const raw of b.pages || []) {
    try {
      if (findPage(raw.slug)) continue;
      const pg = sanitizePage({ ...raw, monitorIds: (raw.monitorIds || []).map((x) => monIdMap[x]).filter(Boolean) });
      if (raw.passwordHash && raw.salt) { pg.passwordHash = raw.passwordHash; pg.salt = raw.salt; }
      pg.id = db.nextId();
      db.data.pages.push(pg);
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
  else if (pathname === '/embed' || pathname === '/embed/') pathname = '/embed.html';
  else if (/^\/service\/\d+\/?$/.test(pathname) || /^\/s\/[a-z0-9-]+\/service\/\d+\/?$/i.test(pathname)) pathname = '/service.html';
  else if (/^\/s\/[a-z0-9-]+\/?$/i.test(pathname)) pathname = '/status.html';
  else if (/^\/s\/[a-z0-9-]+\/history\/?$/i.test(pathname)) pathname = '/history.html';
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
  if (!/^\/embed\/?$/.test(req.url.split('?')[0])) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = url.pathname.match(r.re);
      if (!match) continue;
      if (r.auth && !isAuthed(req)) return send(res, 401, { error: 'Non authentifié' });
      // Protection CSRF basique : les mutations doivent venir d'un fetch JSON
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json') && url.pathname !== '/api/logout' && !url.pathname.startsWith('/api/push/')) {
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

monitor.setStatusChangeHandler(() => discordLive.schedule());
monitor.startAll(broadcast);
discordLive.start((slug) => {
  const page = slug ? findPage(slug) : null;
  if (slug && !page) return null;
  return buildStatus(page);
});
server.listen(PORT, HOST, () => {
  console.log(`\n  Craftpick Status démarré`);
  console.log(`  Page publique : http://localhost:${PORT}/`);
  console.log(`  Administration : http://localhost:${PORT}/admin\n`);
});

function shutdown() { try { db.saveNow(); } catch {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
