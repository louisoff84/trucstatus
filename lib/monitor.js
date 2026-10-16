// Moteur de surveillance : HTTP(S), mot-clé, JSON, TCP, ping, DNS, push (heartbeat)
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const db = require('./db');
const notify = require('./notify');
const { checkMinecraft } = require('./minecraft');
const { checkProxmox } = require('./proxmox');
const { maintenanceActive } = require('./schedule');
const { checkDatabase } = require('./database');

// Statuts : 0 hors ligne, 1 en ligne, 2 en attente, 3 maintenance, 4 dégradé (répond, mais lent / seuil dépassé)
const isUp = (s) => s === 1 || s === 4;

const timers = new Map();   // monitorId -> timeout
const state = new Map();    // monitorId -> { status, retries, cert, lastBeat, downSince, downCount, lastPush }
let emit = () => {};

function statusMatches(code, spec) {
  return String(spec || '200-299').split(',').some((part) => {
    part = part.trim();
    if (part.includes('-')) { const [a, b] = part.split('-').map(Number); return code >= a && code <= b; }
    return code === Number(part);
  });
}

function checkHttp(m) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(m.url); } catch { return reject(new Error('URL invalide')); }
    const lib = u.protocol === 'https:' ? https : http;
    const start = Date.now();
    const headers = { 'User-Agent': 'CraftpickStatus/1.5', Accept: '*/*' };
    if (m.headers) { try { Object.assign(headers, JSON.parse(m.headers)); } catch { return reject(new Error('En-têtes JSON invalides')); } }
    if (m.body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    if (m.basicAuthUser) headers.Authorization = 'Basic ' + Buffer.from(`${m.basicAuthUser}:${m.basicAuthPass || ''}`).toString('base64');
    const req = lib.request(u, {
      method: m.method || 'GET',
      headers,
      timeout: (m.timeout || 30) * 1000,
      rejectUnauthorized: !m.ignoreTls,
    }, (res) => {
      let cert = null;
      if (res.socket && typeof res.socket.getPeerCertificate === 'function') {
        const c = res.socket.getPeerCertificate();
        if (c && c.valid_to) cert = { validTo: new Date(c.valid_to).toISOString(), issuer: c.issuer && (c.issuer.O || c.issuer.CN), daysLeft: Math.floor((new Date(c.valid_to) - Date.now()) / 86400000) };
      }
      const needBody = m.type === 'keyword' || m.type === 'json';
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (needBody && body.length < 2e6) body += chunk; });
      res.on('end', () => {
        const ping = Date.now() - start;
        if (!statusMatches(res.statusCode, m.expectedStatus)) return reject(new Error(`Code HTTP ${res.statusCode} inattendu`));
        if (m.type === 'keyword') {
          const found = m.caseSensitive ? body.includes(m.keyword) : body.toLowerCase().includes(String(m.keyword).toLowerCase());
          if (found === !!m.invertKeyword) return reject(new Error(m.invertKeyword ? `Mot-clé « ${m.keyword} » trouvé` : `Mot-clé « ${m.keyword} » introuvable`));
        }
        if (m.type === 'json') {
          let val;
          try { val = String(m.jsonPath).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(body)); }
          catch { return reject(new Error('Réponse JSON invalide')); }
          if (String(val) !== String(m.jsonExpected)) return reject(new Error(`${m.jsonPath} = ${JSON.stringify(val)} (attendu ${m.jsonExpected})`));
        }
        resolve({ ping, msg: `${res.statusCode} ${res.statusMessage || 'OK'}`, cert });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout après ${m.timeout || 30} s`)));
    req.on('error', reject);
    req.end(m.body || undefined);
  });
}

function checkTcp(m) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const sock = net.connect({ host: m.hostname, port: Number(m.port) });
    sock.setTimeout((m.timeout || 30) * 1000);
    sock.on('connect', () => { const ping = Date.now() - start; sock.destroy(); resolve({ ping, msg: `Port ${m.port} ouvert` }); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('Timeout')); });
    sock.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'Connexion refusée' : e.message)));
  });
}

function checkPing(m) {
  return new Promise((resolve, reject) => {
    if (!/^[\w.:-]+$/.test(m.hostname)) return reject(new Error("Nom d'hôte invalide"));
    const win = process.platform === 'win32';
    const t = Math.min(m.timeout || 10, 60);
    const args = win ? ['-n', '1', '-w', String(t * 1000), m.hostname] : ['-c', '1', '-W', String(t), m.hostname];
    execFile('ping', args, { timeout: (t + 2) * 1000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      // FR / EN, et "temps<1ms" sous Windows
      const match = out.match(/(?:time|temps)\s*[=<]\s*([\d.,]+)\s*ms/i);
      if (err || !match) return reject(new Error('Hôte injoignable'));
      resolve({ ping: Math.max(1, Math.round(parseFloat(match[1].replace(',', '.')))), msg: 'Réponse ICMP' });
    });
  });
}

async function checkDns(m) {
  const start = Date.now();
  const type = m.dnsType || 'A';
  let resolver = dns;
  if (m.dnsServer) { resolver = new dns.Resolver(); resolver.setServers([m.dnsServer]); }
  const res = await resolver.resolve(m.hostname, type);
  if (!res || (Array.isArray(res) && !res.length)) throw new Error(`Aucun enregistrement ${type}`);
  return { ping: Date.now() - start, msg: `${type} : ${JSON.stringify(res).slice(0, 150)}` };
}

// Push : le service appelle /api/push/<token> ; on passe en panne si rien n'arrive à temps
function checkPush(m) {
  const st = state.get(m.id) || {};
  const limit = (m.interval || 60) * 1000;
  if (st.lastPush && Date.now() - st.lastPush <= limit + 5000) return Promise.resolve(null); // rien à enregistrer
  const since = st.lastPush ? Math.round((Date.now() - st.lastPush) / 1000) + ' s' : 'le démarrage';
  return Promise.reject(new Error(`Aucun push reçu depuis ${since}`));
}

function runCheck(m) {
  switch (m.type) {
    case 'tcp': return checkTcp(m);
    case 'ping': return checkPing(m);
    case 'dns': return checkDns(m);
    case 'push': return checkPush(m);
    case 'minecraft': return checkMinecraft(m);
    case 'proxmox': return checkProxmox(m);
    case 'database': return checkDatabase(m);
    default: return checkHttp(m); // http, keyword, json
  }
}

function inMaintenance(m) {
  const now = Date.now();
  return db.data.incidents.some((i) => maintenanceActive(i, now)
    && (!i.monitorIds || !i.monitorIds.length || i.monitorIds.includes(m.id)));
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  const h = Math.floor(s / 3600);
  return h < 48 ? `${h} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(h / 24)} j ${h % 24} h`;
}

// Passe un battement "en ligne" en "dégradé" si un seuil est dépassé
function applyDegraded(m, beat, reason) {
  if (reason) { beat.s = 4; beat.m = reason; return; }
  if (m.degradedMs > 0 && typeof beat.p === 'number' && beat.p > m.degradedMs) {
    beat.s = 4;
    beat.m = `Réponse lente : ${beat.p} ms (seuil ${m.degradedMs} ms)`;
  }
}

// Enregistre un battement, met à jour l'état et déclenche les notifications
function record(m, beat) {
  const st = state.get(m.id) || { status: null, retries: 0 };
  const prev = st.status;
  // Changement en ligne <-> hors ligne (le retour de maintenance vers "en ligne" n'est pas notifié)
  const realChange = prev !== null && (beat.s === 0 || isUp(beat.s))
    && (beat.s === 0) !== (prev === 0) && !(prev === 3 && isUp(beat.s));
  // Changement en ligne <-> dégradé
  const degradeChange = prev !== null && ((prev === 1 && beat.s === 4) || (prev === 4 && beat.s === 1));
  beat.important = prev === null || realChange || degradeChange || (beat.s === 3 && prev !== 3) ? 1 : 0;

  if (beat.s === 0) {
    if (prev !== 0) { st.downSince = beat.t; st.downCount = 0; }
    st.downCount = (st.downCount || 0) + 1;
  }
  if (prev === 4 && beat.s === 1) beat.m = `${beat.m} — performances revenues à la normale`;
  if (isUp(beat.s) && prev === 0 && st.downSince) {
    beat.m = `${beat.m} — de retour après ${fmtDuration(beat.t - st.downSince)} d'indisponibilité`;
  }
  if (beat.s !== 0) st.downSince = null;
  if (beat.s !== 2) st.status = beat.s;
  st.lastBeat = beat;
  state.set(m.id, st);
  db.addBeat(m.id, beat);
  emit({ monitorId: m.id, beat });

  if (realChange && beat.s === 0) notifyDown(m, st, beat);
  else if (realChange && isUp(beat.s)) {
    // si l'alerte de panne avait été masquée (dépendance), on masque aussi le retour
    if (st.suppressed) st.suppressed = false; else sendNotifications(m, beat);
  } else if (degradeChange && m.notifyDegraded) sendNotifications(m, beat);
  // Rappel tant que le service reste en panne
  else if (beat.s === 0 && prev === 0 && !st.suppressed && m.resendEvery > 0 && st.downCount % m.resendEvery === 0) {
    sendNotifications(m, { ...beat, m: `Toujours hors ligne depuis ${fmtDuration(beat.t - st.downSince)} — ${beat.m}` });
  }
  if (onStatusChange && (realChange || degradeChange || beat.important)) onStatusChange(m, beat);
}

// ── Dépendances : un monitor peut dépendre d'un parent (ex. VM → nœud Proxmox) ──
const parentOf = (m) => (m.parentId ? db.data.monitors.find((x) => x.id === m.parentId && x.active) : null);
function ancestorDown(m) {
  let p = parentOf(m), guard = 0;
  while (p && guard++ < 10) {
    if ((state.get(p.id) || {}).status === 0) return p;
    p = parentOf(p);
  }
  return null;
}
function dependents(m) { return db.data.monitors.filter((x) => x.parentId === m.id); }

// Panne : si un parent est en panne (ou l'est quand on le revérifie), l'alerte est masquée
async function notifyDown(m, st, beat) {
  let culprit = ancestorDown(m);
  if (!culprit && parentOf(m)) {
    // le parent n'a peut-être pas encore été vérifié : on le teste tout de suite
    const p = parentOf(m);
    try { await runCheck(p); } catch { culprit = p; }
  }
  if (culprit) {
    st.suppressed = true;
    beat.m = `${beat.m} — alerte masquée : dépend de « ${culprit.name} » (hors ligne)`;
    return;
  }
  st.suppressed = false;
  const deps = dependents(m);
  sendNotifications(m, deps.length ? { ...beat, m: `${beat.m}\n${deps.length} service(s) dépendant(s) probablement affecté(s) : ${deps.map((d) => d.name).join(', ')}` } : beat);
}
let onStatusChange = null;
function setStatusChangeHandler(fn) { onStatusChange = fn; }

async function tick(id) {
  const m = db.data.monitors.find((x) => x.id === id);
  if (!m || !m.active) return;
  const st = state.get(id) || { status: null, retries: 0 };
  state.set(id, st);
  let beat = null;

  if (inMaintenance(m)) {
    beat = { t: Date.now(), s: 3, p: null, m: 'Maintenance en cours' };
  } else {
    try {
      const r = await runCheck(m);
      if (r) {
        beat = { t: Date.now(), s: 1, p: r.ping, m: r.msg };
        applyDegraded(m, beat, r.degraded);
        if (r.players != null) beat.pl = r.players;
        if (r.cert) st.cert = r.cert;
        if (r.extra) st.extra = r.extra;
      }
      st.retries = 0;
    } catch (e) {
      if (e.extra) st.extra = e.extra;
      st.retries++;
      const pending = st.retries <= (m.retries || 0) && st.status !== 0;
      beat = { t: Date.now(), s: pending ? 2 : 0, p: null, m: e.message || String(e) };
    }
  }

  // Le monitor a pu être supprimé ou modifié pendant le check
  const cur = db.data.monitors.find((x) => x.id === id);
  if (!cur || cur !== m || !m.active) return;

  if (beat) record(m, beat);

  // Alerte d'expiration de certificat (une fois par jour)
  if (st.cert && m.certExpiryAlert && st.cert.daysLeft <= (m.certExpiryDays || 14)) {
    const today = db.dayKey(Date.now());
    if (st.certAlerted !== today) {
      st.certAlerted = today;
      sendNotifications(m, { s: 0, m: `Le certificat TLS expire dans ${st.cert.daysLeft} jour(s) (${st.cert.validTo.slice(0, 10)})`, p: null });
    }
  }

  schedule(m, beat && (beat.s === 0 || beat.s === 2));
}

function schedule(m, failing) {
  clearTimeout(timers.get(m.id));
  const interval = failing && m.retryInterval ? m.retryInterval : m.interval || 60;
  timers.set(m.id, setTimeout(() => tick(m.id), Math.max(5, interval) * 1000));
}

// Réception d'un push depuis /api/push/<token>
function receivePush(m, { status, msg, ping }) {
  const st = state.get(m.id) || { status: null, retries: 0 };
  st.lastPush = Date.now();
  st.retries = 0;
  state.set(m.id, st);
  if (!m.active) return;
  const down = status === 'down';
  const p = Number(ping);
  const beat = { t: Date.now(), s: inMaintenance(m) ? 3 : down ? 0 : 1, p: !down && ping != null && ping !== '' && Number.isFinite(p) ? Math.round(p) : null, m: String(msg || (down ? 'Signalé hors ligne' : 'Push reçu')).slice(0, 300) };
  if (beat.s === 1) applyDegraded(m, beat, status === 'degraded' ? beat.m : null);
  record(m, beat);
  schedule(m, false);
}

function sendNotifications(m, beat) {
  if (m.snoozeUntil && m.snoozeUntil > Date.now()) return; // alertes en silence
  const list = db.data.notifications.filter((n) => n.active !== false && ((m.notificationIds || []).includes(n.id) || n.applyAll));
  for (const n of list) {
    notify.send(n, { monitor: m, status: beat.s, msg: beat.m, ping: beat.p })
      .catch((e) => console.error(`[notif] ${n.name} : ${e.message}`));
  }
}

function start(m) {
  stop(m.id);
  if (!m.active) return;
  const st = state.get(m.id) || { status: null, retries: 0 };
  // On reprend l'état précédent pour éviter des notifications au redémarrage
  if (st.status === null) {
    const hist = (db.data.beats[m.id] || []).filter((b) => b.s !== 2);
    const last = hist[hist.length - 1];
    if (last) {
      st.status = last.s;
      if (last.s === 0) { // retrouve le début de la panne
        let i = hist.length - 1;
        while (i > 0 && hist[i - 1].s === 0) i--;
        st.downSince = hist[i].t;
        st.downCount = hist.length - i;
      }
    }
  }
  if (m.type === 'push' && !st.lastPush) st.lastPush = Date.now(); // délai de grâce au démarrage
  st.retries = 0;
  state.set(m.id, st);
  const delay = m.type === 'push' ? (m.interval || 60) * 1000 + 5000 : 500 + Math.random() * 1500;
  timers.set(m.id, setTimeout(() => tick(m.id), delay));
}

function stop(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

function startAll(emitter) {
  emit = emitter;
  db.data.monitors.forEach(start);
}

function getState(id) { return state.get(id) || {}; }
function forget(id) { stop(id); state.delete(id); }

module.exports = { startAll, start, stop, forget, getState, runCheck, receivePush, fmtDuration, statusMatches, applyDegraded, setStatusChangeHandler, ancestorDown };
